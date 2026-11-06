"""Private, immutable manuscript snapshots. Project paths are data, never disk paths.

Uploads use sequential UTF-8 byte offsets. Only a fully verified upload becomes
visible to readers; scoped callers and capability-based MCP readers share the
same immutable snapshot format. No project or workspace file is modified.
"""
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import stat
import threading
import time
import uuid

MAX_FILES = 2000
MAX_TOTAL_BYTES = 16 * 1024 * 1024
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_CHUNK_BYTES = 800000
MAX_CHUNK_UTF16 = 200000
MAX_JSON_BYTES = MAX_TOTAL_BYTES * 6 + 4 * 1024 * 1024
UPLOAD_IDLE_TTL = 24 * 60 * 60
HEX = re.compile(r'^[a-f0-9]{64}$')
UPLOAD = re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$')
DEFAULT_ROOT = Path.home() / 'Library/Application Support/OverleafPersonalTools/codex-assistant/project-context'


class ProjectContextError(ValueError):
    pass


def project_path(value):
    if (not isinstance(value, str) or not value or len(value) > 1000
            or any(ord(c) < 32 or ord(c) == 127 or 0xD800 <= ord(c) <= 0xDFFF for c in value)
            or '\\' in value or ':' in value or value.startswith('/')
            or any(part in ('', '.', '..') for part in value.split('/'))):
        raise ProjectContextError('Invalid relative manuscript path.')
    return value


def _identifier(value, pattern, label):
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise ProjectContextError('Invalid %s.' % label)
    return value


def _manifest(root_path, entries):
    if not isinstance(root_path, str):
        raise ProjectContextError('Invalid root document path.')
    if not isinstance(entries, list) or len(entries) > MAX_FILES:
        raise ProjectContextError('A project snapshot supports at most 2000 files.')
    result, seen, total = [], set(), 0
    for item in entries:
        if not isinstance(item, dict) or set(item) != {'path', 'bytes', 'sha256'}:
            raise ProjectContextError('Invalid project manifest.')
        path = project_path(item['path'])
        size = item['bytes']
        if path in seen or type(size) is not int or not 0 <= size <= MAX_FILE_BYTES:
            raise ProjectContextError('Duplicate path or oversized manuscript file.')
        digest = _identifier(item['sha256'], HEX, 'file SHA256')
        seen.add(path); total += size
        result.append({'path': path, 'bytes': size, 'sha256': digest})
    if total > MAX_TOTAL_BYTES:
        raise ProjectContextError('The complete project snapshot exceeds 16 MiB.')
    # An unknown root does not prevent complete project access. Keep it empty
    # instead of guessing among several candidate entry documents.
    if root_path and root_path not in seen:
        raise ProjectContextError('The root document must be present in the project manifest.')
    return result


def _check_components(path):
    # Do not resolve() first: that would conceal a supplied symlink.
    for component in [path] + list(path.parents):
        if component.is_symlink():
            raise ProjectContextError('Snapshot storage cannot contain symlinks.')


def _directory(path, create=False):
    _check_components(path)
    if create:
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not path.exists():
        raise ProjectContextError('The manuscript snapshot is not available.')
    info = path.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise ProjectContextError('Invalid private snapshot directory.')
    if create:
        os.chmod(str(path), 0o700)
    elif info.st_mode & 0o077:
        raise ProjectContextError('The snapshot directory is not private.')


def _read_bytes(path, limit):
    _check_components(path)
    try:
        descriptor = os.open(str(path), os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
        with os.fdopen(descriptor, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                    or info.st_mode & 0o077 or info.st_size > limit):
                raise ProjectContextError('Invalid private snapshot file.')
            data = stream.read(limit + 1)
            if len(data) > limit:
                raise ProjectContextError('Oversized snapshot storage.')
            return data
    except OSError as error:
        raise ProjectContextError('The manuscript snapshot is not available.') from error


def _json_bytes(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')


def _read_json(path, limit=MAX_JSON_BYTES):
    try:
        return json.loads(_read_bytes(path, limit))
    except (UnicodeError, ValueError) as error:
        if isinstance(error, ProjectContextError):
            raise
        raise ProjectContextError('Invalid manuscript snapshot data.') from error


def _atomic_bytes(path, content, immutable=False, replace=False):
    _directory(path.parent)
    _check_components(path)
    temporary = path.parent / ('.new-' + uuid.uuid4().hex)
    descriptor = os.open(str(temporary), os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(content); stream.flush(); os.fsync(stream.fileno())
            if immutable:
                os.fchmod(stream.fileno(), 0o400)
        if immutable and not replace:
            # link() publishes atomically without ever replacing an existing
            # snapshot, including a maliciously pre-created symlink.
            os.link(str(temporary), str(path), follow_symlinks=False)
        else:
            _check_components(path)
            os.replace(str(temporary), str(path))
    except OSError as error:
        raise ProjectContextError('Unable to save the private manuscript snapshot.') from error
    finally:
        if temporary.exists():
            temporary.unlink()


class ProjectContextStore:
    def __init__(self, root=DEFAULT_ROOT, read_only=False):
        self.root = Path(root).expanduser().absolute()
        self.read_only = read_only
        self.uploads = self.root / 'uploads'
        self.snapshots = self.root / 'snapshots'
        self.dedup = self.root / 'dedup'
        self.blobs = self.root / 'blobs'
        self._mutex = threading.RLock()
        _check_components(self.root)
        if not read_only:
            _directory(self.root, True)
            _directory(self.uploads, True)
            _directory(self.snapshots, True)
            _directory(self.dedup, True)
            _directory(self.blobs, True)
        elif self.root.exists():
            _directory(self.root)

    @contextlib.contextmanager
    def _lock(self):
        if self.read_only:
            raise ProjectContextError('This snapshot store is read-only.')
        with self._mutex:
            _directory(self.root)
            path = self.root / '.lock'
            _check_components(path)
            descriptor = os.open(str(path), os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
            try:
                info = os.fstat(descriptor)
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                    raise ProjectContextError('Invalid snapshot lock.')
                fcntl.flock(descriptor, fcntl.LOCK_EX)
                yield
            finally:
                os.close(descriptor)

    def _upload(self, scope, upload_id):
        _identifier(scope, HEX, 'project scope')
        _identifier(upload_id, UPLOAD, 'upload identifier')
        directory = self.uploads / upload_id
        _directory(self.uploads); _directory(directory)
        metadata = _read_json(directory / 'manifest.json', 4 * 1024 * 1024)
        if not isinstance(metadata, dict) or metadata.get('scope') != scope or metadata.get('upload_id') != upload_id:
            raise ProjectContextError('This upload does not belong to the current project.')
        metadata['manifest'] = _manifest(metadata.get('root_path'), metadata.get('manifest'))
        return directory, metadata

    @staticmethod
    def _blob(directory, path):
        return directory / (hashlib.sha256(path.encode('utf-8')).hexdigest() + '.part')

    def _content_blob(self, scope, digest, create=False):
        _identifier(scope, HEX, 'project scope')
        _identifier(digest, HEX, 'file SHA256')
        _directory(self.blobs, create)
        directory = self.blobs / scope
        _directory(directory, create)
        return directory / (digest + '.utf8')

    @staticmethod
    def _verify_content(data, entry):
        if len(data) != entry['bytes'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
            raise ProjectContextError('The manuscript snapshot failed its integrity check.')
        try:
            return data.decode('utf-8')
        except UnicodeError as error:
            raise ProjectContextError('The manuscript file is not valid UTF-8.') from error

    def _read_content_blob(self, scope, entry):
        data = _read_bytes(self._content_blob(scope, entry['sha256']), MAX_FILE_BYTES)
        self._verify_content(data, entry)
        return data

    def _save_content_blob(self, scope, entry, data):
        # Only an independently verified upload may heal a missing/corrupt blob.
        # Its identity fixes the bytes, so old snapshots never acquire new text.
        self._verify_content(data, entry)
        path = self._content_blob(scope, entry['sha256'], create=True)
        _check_components(path)
        try:
            self._read_content_blob(scope, entry)
            return
        except ProjectContextError:
            pass
        _atomic_bytes(path, data, immutable=True, replace=path.exists())

    def missing_paths(self, scope, upload_id):
        """Return required uploads only after verifying the scoped cached bytes.

        A subsequent commit validates again; corruption between the two checks
        fails closed and can be repaired by a fresh source-begin request.
        """
        with self._lock():
            directory, metadata = self._upload(scope, upload_id)
            missing = []
            for entry in metadata['manifest']:
                try:
                    self._read_content_blob(scope, entry)
                except ProjectContextError:
                    # Empty files need no chunk; commit can derive their bytes.
                    if entry['bytes'] or entry['sha256'] != hashlib.sha256(b'').hexdigest():
                        missing.append(entry['path'])
            return missing

    @staticmethod
    def _fingerprint(scope, root_path, manifest):
        # This digest is private lookup metadata, NOT the capability exposed to
        # models. Identical text in another account/project has a distinct key.
        value = {'version': 1, 'scope': scope, 'root_path': root_path,
                 'manifest': sorted(manifest, key=lambda item: item['path'])}
        return hashlib.sha256(_json_bytes(value)).hexdigest()

    def _indexed_snapshot(self, scope, fingerprint):
        path = self.dedup / (fingerprint + '.json')
        _directory(self.dedup)
        _check_components(path)
        if not path.exists():
            return None
        try:
            entry = _read_json(path, 1024)
            if (not isinstance(entry, dict)
                    or set(entry) != {'version', 'scope', 'fingerprint', 'snapshot_id'}
                    or entry['version'] != 1 or entry['scope'] != scope
                    or entry['fingerprint'] != fingerprint):
                return None
            # The index is a cache, never an authority. Verify the immutable
            # target, scope, all bytes/hashes and its canonical manifest again.
            snapshot = self.get(scope, entry['snapshot_id'])
            if self._fingerprint(scope, snapshot['root_path'], snapshot['manifest']) != fingerprint:
                return None
            return snapshot['snapshot_id']
        except ProjectContextError:
            # A missing/corrupt cache target must not substitute other content.
            # Publishing a fresh verified version repairs only this cache key;
            # no existing snapshot or chat reference is removed or rewritten.
            return None

    def _cleanup_idle_uploads(self):
        """Called only under _lock; never visits the published snapshots tree."""
        _directory(self.uploads)
        now = time.time()
        for directory in self.uploads.iterdir():
            if not UPLOAD.fullmatch(directory.name):
                continue
            try:
                info = directory.lstat()
                # Do not follow or delete foreign/symlink entries. rmtree also
                # unlinks child symlinks without traversing their destinations.
                if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
                        or info.st_mode & 0o077 or now - info.st_mtime < UPLOAD_IDLE_TTL):
                    continue
                shutil.rmtree(directory)
            except OSError:
                # An unreadable temporary upload cannot block new questions.
                continue

    def begin(self, scope, root_path, manifest):
        _identifier(scope, HEX, 'project scope')
        entries = _manifest(root_path, manifest)
        upload_id = str(uuid.uuid4())
        with self._lock():
            _directory(self.uploads)
            self._cleanup_idle_uploads()
            directory = self.uploads / upload_id
            directory.mkdir(mode=0o700)
            _atomic_bytes(directory / 'manifest.json', _json_bytes({
                'version': 1, 'scope': scope, 'root_path': root_path, 'manifest': entries,
                'upload_id': upload_id, 'created_at': time.time(),
            }))
        return upload_id

    def chunk(self, scope, upload_id, path, offset, content):
        project_path(path)
        if type(offset) is not int or offset < 0 or not isinstance(content, str):
            raise ProjectContextError('Invalid manuscript upload chunk.')
        try:
            encoded = content.encode('utf-8')
            units = len(content.encode('utf-16-le')) // 2
        except UnicodeError as error:
            raise ProjectContextError('The manuscript chunk contains invalid Unicode.') from error
        if len(encoded) > MAX_CHUNK_BYTES or units > MAX_CHUNK_UTF16:
            raise ProjectContextError('The manuscript upload chunk is too large.')
        with self._lock():
            directory, metadata = self._upload(scope, upload_id)
            entry = next((item for item in metadata['manifest'] if item['path'] == path), None)
            if entry is None:
                raise ProjectContextError('The chunk path is not in the project manifest.')
            blob = self._blob(directory, path)
            _check_components(blob)
            previous = _read_bytes(blob, MAX_FILE_BYTES) if blob.exists() else b''
            if offset != len(previous) or offset + len(encoded) > entry['bytes']:
                raise ProjectContextError('Manuscript chunks must use sequential UTF-8 byte offsets.')
            _atomic_bytes(blob, previous + encoded)
            # Last valid activity, not creation time, controls staging cleanup.
            # Cleanup and writes share the process lock and cross-process flock.
            os.utime(str(directory), None, follow_symlinks=False)
            return {'offset': offset + len(encoded), 'bytes': entry['bytes']}

    def commit(self, scope, upload_id):
        with self._lock():
            directory, metadata = self._upload(scope, upload_id)
            verified = []
            for entry in metadata['manifest']:
                blob = self._blob(directory, entry['path'])
                _check_components(blob)
                if blob.exists():
                    data = _read_bytes(blob, MAX_FILE_BYTES)
                elif entry['bytes'] == 0:
                    data = b''
                else:
                    try:
                        data = self._read_content_blob(scope, entry)
                    except ProjectContextError as error:
                        raise ProjectContextError('The project upload is incomplete or its cached file is unavailable. Synchronize again.') from error
                if len(data) != entry['bytes'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
                    raise ProjectContextError('The project upload is incomplete or its SHA256 does not match.')
                self._verify_content(data, entry)
                verified.append((entry, data))
            # Publish no files from an incomplete/invalid upload. Content-addressed
            # blobs are private to the account/project; unchanged bytes are not
            # copied to staging or rewritten for every new snapshot.
            for entry, data in verified:
                self._save_content_blob(scope, entry, data)
            fingerprint = self._fingerprint(scope, metadata['root_path'], metadata['manifest'])
            existing = self._indexed_snapshot(scope, fingerprint)
            if existing:
                shutil.rmtree(directory)
                return existing
            # Keep unpredictable, immutable capability IDs even though the
            # private index now reuses a version with identical source content.
            snapshot_id = hashlib.sha256(scope.encode('ascii') + secrets.token_bytes(32)).hexdigest()
            snapshot = {'version': 2, 'snapshot_id': snapshot_id, 'scope': scope,
                        'root_path': metadata['root_path'], 'manifest': metadata['manifest'],
                        'created_at': time.time()}
            _atomic_bytes(self.snapshots / (snapshot_id + '.json'), _json_bytes(snapshot), immutable=True)
            _atomic_bytes(self.dedup / (fingerprint + '.json'), _json_bytes({
                'version': 1, 'scope': scope, 'fingerprint': fingerprint,
                'snapshot_id': snapshot_id,
            }))
            shutil.rmtree(directory)
            return snapshot_id

    def read_snapshot(self, snapshot_id):
        _identifier(snapshot_id, HEX, 'snapshot identifier')
        _directory(self.root); _directory(self.snapshots)
        snapshot = _read_json(self.snapshots / (snapshot_id + '.json'))
        if not isinstance(snapshot, dict) or snapshot.get('version') not in (1, 2) or snapshot.get('snapshot_id') != snapshot_id:
            raise ProjectContextError('Invalid manuscript snapshot.')
        _identifier(snapshot.get('scope'), HEX, 'stored project scope')
        entries = _manifest(snapshot.get('root_path'), snapshot.get('manifest'))
        if snapshot['version'] == 2:
            if 'files' in snapshot:
                raise ProjectContextError('Invalid manuscript snapshot.')
            snapshot['files'] = [{'path': entry['path'], 'content': self._read_content_blob(snapshot['scope'], entry).decode('utf-8')}
                                 for entry in entries]
            return snapshot
        files = snapshot.get('files')
        if not isinstance(files, list) or len(files) != len(entries):
            raise ProjectContextError('Incomplete manuscript snapshot.')
        for item, entry in zip(files, entries):
            if not isinstance(item, dict) or set(item) != {'path', 'content'} or item['path'] != entry['path'] or not isinstance(item['content'], str):
                raise ProjectContextError('Invalid manuscript snapshot file.')
            try:
                encoded = item['content'].encode('utf-8')
            except UnicodeError as error:
                raise ProjectContextError('Invalid manuscript Unicode.') from error
            if len(encoded) != entry['bytes'] or hashlib.sha256(encoded).hexdigest() != entry['sha256']:
                raise ProjectContextError('The manuscript snapshot failed its integrity check.')
        return snapshot

    def get(self, scope, snapshot_id):
        _identifier(scope, HEX, 'project scope')
        snapshot = self.read_snapshot(snapshot_id)
        if snapshot['scope'] != scope:
            raise ProjectContextError('This snapshot does not belong to the current project.')
        return snapshot
