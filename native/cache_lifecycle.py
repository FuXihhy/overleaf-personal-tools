"""Durable page/turn protection and scoped, atomic source-cache reclamation.

No heartbeat expires a page. Only confirmed document departure or a complete
browser inventory retires it. Unknown turn outcomes retain their exact versions.
Publication and deletion share the ProjectContextStore cross-process lock.
"""
import contextlib
import copy
import hashlib
import math
import os
from pathlib import Path
import re
import shutil
import sys
import time
import unicodedata
import uuid

from project_context import (ProjectContextError, _atomic_bytes, _check_components,
                             _json_bytes, _read_json, _read_bytes, _directory, _manifest, UPLOAD)
from platform_utils import IS_WINDOWS, is_link, is_private, private_permissions

_HEX = re.compile(r'^[a-f0-9]{64}$')
_ID = re.compile(r'^[A-Za-z0-9_.:-]{1,200}$')
_MAX_METADATA = 4 * 1024 * 1024
_MAX_RECORDS = 10000
TERMINAL = frozenset(('completed', 'failed', 'cancelled', 'interrupted'))
CACHE_OPERATIONS = {
    'source-page-acquire': {'browserId', 'documentId', 'leaseToken'},
    'source-page-release': {'browserId', 'documentId', 'leaseToken'},
    'source-page-reconcile': {'browserId', 'documents', 'inventoryComplete'},
    'source-queue-pin': {'queueId', 'snapshotId'}, 'source-queue-release': {'queueId'},
    'source-cache-info': set(), 'source-cache-clear': {'cacheRevision'},
    'source-cache-open': set(), 'source-cache-sweep': set(),
}
CACHE_FIELDS = {'browserId', 'documentId', 'leaseToken', 'previousLeaseToken', 'documents', 'inventoryComplete', 'queueId', 'cacheRevision', 'cacheMode'}


def validate_cache_request(value, result):
    fields = CACHE_OPERATIONS[value['op']]
    if value['op'] == 'source-page-acquire' and 'previousLeaseToken' in value:
        fields = fields | {'previousLeaseToken'}
    if set(value) - {'version', 'id', 'op', 'projectId', 'accountId'} != fields:
        raise ProjectContextError('Invalid cache lifecycle request fields.')
    for field in fields - {'documents', 'inventoryComplete'}:
        _identifier(value[field], _HEX if field in ('snapshotId', 'cacheRevision') else _ID)
        result[field] = value[field]
    if 'documents' in fields:
        docs = value['documents']
        if not isinstance(docs, list) or len(docs) > 10000 or value['inventoryComplete'] is not True:
            raise ProjectContextError('A complete browser document inventory is required.')
        result['documents'] = [_identifier(document) for document in docs]
        result['inventoryComplete'] = True
    return result


def _identifier(value, pattern=_ID):
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise ProjectContextError('Invalid cache lifecycle identity.')
    return value


def _scope():
    return {'pages': {}, 'retired': {}, 'snapshots': {}, 'pins': {}, 'empty_since': None}


def _validate(state):
    """Corrupt metadata must never be interpreted as an empty live-page set."""
    try:
        if set(state) != {'version', 'scopes'} or type(state['version']) is not int or state['version'] != 1:
            raise ValueError()
        if not isinstance(state['scopes'], dict) or len(state['scopes']) > 1000:
            raise ValueError()
        for scope_id, scope in state['scopes'].items():
            _identifier(scope_id, _HEX)
            if set(scope) != set(_scope()):
                raise ValueError()
            for name in ('pages', 'retired', 'snapshots', 'pins'):
                if not isinstance(scope[name], dict) or len(scope[name]) > _MAX_RECORDS:
                    raise ValueError()
            empty = scope['empty_since']
            if empty is not None and (type(empty) not in (int, float) or not math.isfinite(empty) or empty < 0):
                raise ValueError()
            if scope['pages'] and empty is not None:
                raise ValueError()
            for name in ('pages', 'retired'):
                for token, page in scope[name].items():
                    _identifier(token)
                    if set(page) != {'browser', 'document'}:
                        raise ValueError()
                    _identifier(page['browser']); _identifier(page['document'])
            if set(scope['pages']) & set(scope['retired']):
                raise ValueError()
            for snapshot, mode in scope['snapshots'].items():
                _identifier(snapshot, _HEX)
                if mode not in ('temporary', 'persistent', 'legacy'):
                    raise ValueError()
            for key, pin in scope['pins'].items():
                _identifier(key)
                if set(pin) != {'kind', 'state', 'snapshots', 'thread', 'turn'}:
                    raise ValueError()
                if pin['kind'] not in ('queue', 'turn') or pin['state'] not in ('queued', 'provisional', 'accepted', 'uncertain'):
                    raise ValueError()
                if (pin['kind'] == 'queue') != (pin['state'] == 'queued'):
                    raise ValueError()
                if not isinstance(pin['snapshots'], list) or not pin['snapshots'] or len(pin['snapshots']) > _MAX_RECORDS:
                    raise ValueError()
                for snapshot in pin['snapshots']:
                    _identifier(snapshot, _HEX)
                if (pin['thread'] is None) != (pin['turn'] is None):
                    raise ValueError()
                if pin['thread'] is not None:
                    _identifier(pin['thread']); _identifier(pin['turn'])
                if pin['state'] == 'accepted' and pin['thread'] is None:
                    raise ValueError()
                if pin['state'] in ('queued', 'provisional') and pin['thread'] is not None:
                    raise ValueError()
        return state
    except (ValueError, TypeError, KeyError, AttributeError) as error:
        raise ProjectContextError('Invalid cache lifecycle metadata; source cleanup is blocked.') from error


class CacheLifecycle:
    def __init__(self, store, *, grace_seconds=30, clock=time.time):
        if type(grace_seconds) not in (int, float) or not math.isfinite(grace_seconds) or grace_seconds < 0:
            raise ValueError('Invalid reconnect grace period.')
        self.store = store
        self.path = store.root / 'cache-lifecycle.json'
        self.grace = grace_seconds
        self.clock = clock

    def _now(self):
        value = self.clock()
        if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
            raise ProjectContextError('Invalid lifecycle clock; source cleanup is blocked.')
        return value

    @contextlib.contextmanager
    def _transaction(self, scope, *, write=True, locked=False):
        _identifier(scope, _HEX)
        with contextlib.nullcontext() if locked else self.store._lock():
            _check_components(self.path)
            state = _validate(_read_json(self.path, _MAX_METADATA)) if self.path.exists() else {'version': 1, 'scopes': {}}
            value = state['scopes'].setdefault(scope, _scope())
            yield value
            if write:
                _validate(state)
                encoded = _json_bytes(state)
                if len(encoded) > _MAX_METADATA:
                    raise ProjectContextError('Cache lifecycle metadata is full; source cleanup is blocked.')
                _atomic_bytes(self.path, encoded)

    def acquire_page(self, scope, browser, document, token, previous_token=None):
        """Idempotent acquisition; a retired generation cannot resurrect itself."""
        page = {'browser': _identifier(browser), 'document': _identifier(document)}
        _identifier(token)
        if previous_token is not None:
            _identifier(previous_token)
            if previous_token == token:
                raise ProjectContextError('A replacement page token must be a new generation.')
        with self._transaction(scope) as state:
            if token in state['retired']:
                raise ProjectContextError('This browser document has already departed.')
            old = state['pages'].get(token)
            if old is not None and old != page:
                raise ProjectContextError('This page token belongs to another document.')
            if previous_token is not None:
                previous = state['pages'].get(previous_token) or state['retired'].get(previous_token)
                if previous is not None and previous != page:
                    raise ProjectContextError('The previous page token belongs to another document.')
            for other, value in list(state['pages'].items()):
                if other != token and value == page:
                    if other != previous_token:
                        raise ProjectContextError('This document already has a different page generation.')
                    state['retired'][other] = state['pages'].pop(other)
            if previous_token is not None:
                # Fence a predecessor even if its first acquire is still
                # delayed in another helper process and has never reached disk.
                state['retired'][previous_token] = page
            state['pages'][token] = page
            state['empty_since'] = None

    def release_page(self, scope, browser, document, token, *, confirmed_departure=False):
        page = {'browser': _identifier(browser), 'document': _identifier(document)}
        _identifier(token)
        if confirmed_departure is not True:
            return False
        with self._transaction(scope) as state:
            if state['pages'].get(token) != page:
                return False
            state['retired'][token] = state['pages'].pop(token)
            if not state['pages']:
                state['empty_since'] = self._now()
            return True

    def reconcile_browser(self, scope, browser, documents, *, inventory_complete=False):
        """Only a complete inventory for this browser retires its missing pages.

        A worker wakeup, disconnected native port, or missing heartbeat is not
        such an inventory. Other browser instances are never affected.
        """
        _identifier(browser)
        if not isinstance(documents, (list, tuple, set)) or len(documents) > _MAX_RECORDS:
            raise ProjectContextError('Invalid browser document inventory.')
        present = {_identifier(document) for document in documents}
        if inventory_complete is not True:
            return 0
        with self._transaction(scope) as state:
            removed = 0
            for token, page in list(state['pages'].items()):
                if page['browser'] == browser and page['document'] not in present:
                    state['retired'][token] = state['pages'].pop(token)
                    removed += 1
            if removed and not state['pages']:
                state['empty_since'] = self._now()
            return removed

    def manage_snapshot(self, scope, snapshot, mode, *, newly_created=False, locked=False):
        """New captures may be temporary; old/deduplicated snapshots stay retained.

        ``newly_created`` must come from the atomic publication integration,
        never from a page's assertion. Changing settings does not migrate copies.
        Persistent mode creates a separate immutable directory mirror.
        """
        _identifier(snapshot, _HEX)
        if mode not in ('on-demand', 'persistent'):
            raise ProjectContextError('Normal context must not capture a complete project.')
        with self._transaction(scope, locked=locked) as state:
            contents = self.store.get(scope, snapshot)
            old = state['snapshots'].get(snapshot)
            if mode == 'persistent':
                self._mirror(scope, snapshot, contents)
                state['snapshots'][snapshot] = 'persistent'
            elif old is None:
                state['snapshots'][snapshot] = 'temporary' if newly_created is True else 'legacy'
            # No implicit persistent/legacy -> temporary downgrade.

    def pin(self, scope, pin_id, snapshot, *, kind='turn'):
        """Protect before submission; steering may add versions to the same pin."""
        _identifier(pin_id); _identifier(snapshot, _HEX)
        if kind not in ('turn', 'queue'):
            raise ProjectContextError('Invalid snapshot pin kind.')
        with self._transaction(scope) as state:
            self.store.get(scope, snapshot)
            pin = state['pins'].setdefault(pin_id, {'kind': kind, 'state': 'queued' if kind == 'queue' else 'provisional',
                                                   'snapshots': [], 'thread': None, 'turn': None})
            if pin['kind'] != kind:
                raise ProjectContextError('This snapshot pin belongs to another operation.')
            if snapshot not in pin['snapshots']:
                pin['snapshots'].append(snapshot)

    def accept_turn(self, scope, pin_id, thread, turn):
        _identifier(pin_id); _identifier(thread); _identifier(turn)
        with self._transaction(scope) as state:
            pin = state['pins'].get(pin_id)
            if not pin or pin['kind'] != 'turn':
                raise ProjectContextError('No provisional turn pin exists.')
            if pin['thread'] is not None and (pin['thread'], pin['turn']) != (thread, turn):
                raise ProjectContextError('The turn pin is bound to a different reply.')
            pin.update(state='accepted', thread=thread, turn=turn)

    def uncertain_turn(self, scope, pin_id):
        _identifier(pin_id)
        with self._transaction(scope) as state:
            pin = state['pins'].get(pin_id)
            if not pin or pin['kind'] != 'turn':
                raise ProjectContextError('No turn pin exists.')
            pin['state'] = 'uncertain'

    def reject_before_submission(self, scope, pin_id, *, confirmed_rejection=False):
        """Only an unsubmitted provisional pin can be released this way."""
        _identifier(pin_id)
        with self._transaction(scope) as state:
            pin = state['pins'].get(pin_id)
            if pin and (pin['state'] == 'provisional' or confirmed_rejection is True and pin['state'] == 'uncertain' and pin['thread'] is None):
                del state['pins'][pin_id]
                return True
            return False

    def confirm_terminal(self, scope, pin_id, thread, turn, status):
        _identifier(pin_id); _identifier(thread); _identifier(turn)
        if status not in TERMINAL:
            return False
        with self._transaction(scope) as state:
            pin = state['pins'].get(pin_id)
            if not pin or pin['kind'] != 'turn' or (pin['thread'], pin['turn']) != (thread, turn):
                return False
            del state['pins'][pin_id]
            return True

    def finish_turn(self, scope, thread, turn, status):
        _identifier(thread); _identifier(turn)
        if status not in TERMINAL:
            return False
        with self._transaction(scope) as state:
            keys = [key for key, pin in state['pins'].items()
                    if pin['kind'] == 'turn' and (pin['thread'], pin['turn']) == (thread, turn)]
            for key in keys:
                del state['pins'][key]
            return bool(keys)

    def release_queue(self, scope, pin_id):
        _identifier(pin_id)
        with self._transaction(scope) as state:
            pin = state['pins'].get(pin_id)
            if not pin or pin['kind'] != 'queue':
                return False
            del state['pins'][pin_id]
            return True

    def inspect_cleanup(self, scope):
        """Inspect eligibility without deleting a source version."""
        with self._transaction(scope, write=False) as state:
            protected = {snapshot for pin in state['pins'].values() for snapshot in pin['snapshots']}
            empty = state['empty_since']
            ready = not state['pages'] and empty is not None and self._now() >= empty + self.grace
            return {'deletion_enabled': True, 'page_count': len(state['pages']),
                    'pin_count': len(state['pins']), 'empty_since': empty,
                    'candidates': sorted(snapshot for snapshot, mode in state['snapshots'].items()
                                         if ready and mode == 'temporary' and snapshot not in protected),
                    'protected': sorted(protected), 'retention': copy.deepcopy(state['snapshots'])}

    def require_page(self, scope, token, *, locked=False):
        _identifier(token)
        with self._transaction(scope, write=False, locked=locked) as state:
            if token not in state['pages']:
                raise ProjectContextError('This project page is not registered. Reconnect and synchronize again.')

    @staticmethod
    def validate_mirror_paths(entries, base):
        """Virtual manuscript names are not automatically valid disk names."""
        def identity(value):
            if IS_WINDOWS:
                return value.upper()
            if sys.platform == 'darwin':
                # The usual macOS volume ignores case and Unicode canonical
                # spelling. In particular, differently named parent folders
                # can silently merge even when their leaf filenames differ.
                # Conservatively reject these aliases on case-sensitive Mac
                # volumes too, so a retained mirror stays portable between
                # supported macOS installations. Never rename project paths.
                return unicodedata.normalize('NFD', value).casefold()
            return value

        names = set()
        directories = {}
        for entry in entries:
            path = entry['path']
            parts = path.split('/')
            # A file cannot also be the parent directory of another file.
            for i in range(1, len(parts)):
                parent = '/'.join(parts[:i])
                key = identity(parent)
                if key in names:
                    raise ProjectContextError('The local mirror contains a file/directory name collision.')
                if key in directories and directories[key] != parent:
                    raise ProjectContextError('The local mirror cannot safely preserve directory names differing only in case or Unicode spelling.')
                directories[key] = parent
            name = identity(path)
            if name in names or any(other.startswith(name + '/') for other in names):
                raise ProjectContextError('The local mirror cannot represent colliding project paths.')
            names.add(name)
            if IS_WINDOWS:
                for part in parts:
                    if (part.endswith(('.', ' ')) or any(c in part for c in '<>"|?*')
                            or re.fullmatch(r'(?i:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])', part.split('.')[0])
                            or len(part.encode('utf-16-le')) // 2 > 255):
                        raise ProjectContextError('Keep locally cannot preserve this Windows filename: ' + path)
                if len(str(base / path).encode('utf-16-le')) // 2 >= 32700:
                    raise ProjectContextError('Keep locally cannot preserve this path within the Windows mirror path limit: ' + path)

    def _mirror(self, scope, snapshot, contents):
        mirrors = self.store.root / 'mirrors'
        parent = mirrors / scope
        destination = parent / snapshot
        self.validate_mirror_paths(contents['manifest'], destination)
        _check_components(destination)
        if destination.exists():
            # Never overwrite user edits to an assistant-managed mirror.
            expected = {item['path'] for item in contents['files']}
            actual = set()
            for root, dirs, files in os.walk(destination):
                for name in [*dirs, *files]:
                    candidate = Path(root) / name
                    if is_link(candidate) or not is_private(candidate):
                        raise ProjectContextError('The retained mirror contains an unowned or linked entry.')
                actual.update((Path(root) / name).relative_to(destination).as_posix() for name in files)
            if actual != expected:
                raise ProjectContextError('The retained mirror was edited. It was not overwritten; clear it explicitly before synchronizing.')
            for item, entry in zip(contents['files'], contents['manifest']):
                if _read_bytes(destination / item['path'], entry['bytes']) != item['content'].encode('utf-8'):
                    raise ProjectContextError('The retained mirror was edited. It was not overwritten; clear it explicitly before synchronizing.')
            return
        _directory(mirrors, True); _directory(parent, True)
        staging = parent / ('.new-' + uuid.uuid4().hex)
        _directory(staging, True)
        try:
            for item in contents['files']:
                path = staging / item['path']
                _directory(path.parent, True)
                _atomic_bytes(path, item['content'].encode('utf-8'), immutable=True)
            for root, directories, _files in os.walk(staging, topdown=False):
                _check_components(Path(root))
                private_permissions(Path(root), 0o500)
            os.rename(staging, destination)
        finally:
            if staging.exists():
                self._remove_mirror(staging)

    def _remove_mirror(self, path):
        # Called only for a generated scope/version or staging path below mirrors.
        allowed = self.store.root / 'mirrors'
        if not path.absolute().is_relative_to(allowed.absolute()):
            raise ProjectContextError('Invalid mirror cleanup boundary.')
        _check_components(path)
        if not path.exists():
            return
        if not is_private(path):
            raise ProjectContextError('Unowned local mirror; cleanup stopped.')
        for root, dirs, files in os.walk(path):
            for name in [*dirs, *files]:
                candidate = Path(root) / name
                if is_link(candidate) or not is_private(candidate):
                    raise ProjectContextError('Local source contains an unowned or linked entry; cleanup stopped.')
            private_permissions(Path(root), 0o700)
        shutil.rmtree(path)

    def _mirror_directories(self, scope):
        parent = self.store.root / 'mirrors' / scope
        _check_components(parent)
        if not parent.exists():
            return []
        return [path for path in parent.iterdir() if _HEX.fullmatch(path.name)
                or re.fullmatch(r'\.new-[a-f0-9]{32}', path.name)]

    def _tree_bytes(self, path):
        _check_components(path)
        if not path.is_dir() or not is_private(path):
            raise ProjectContextError('Invalid private source directory.')
        total = 0
        for root, dirs, files in os.walk(path):
            for name in [*dirs, *files]:
                candidate = Path(root) / name
                if is_link(candidate) or not is_private(candidate):
                    raise ProjectContextError('Unowned or linked cached source; inspection stopped.')
            total += sum((Path(root) / name).stat().st_size for name in files)
        return total

    def _uploads(self, scope):
        result = {}
        for directory in self.store.uploads.iterdir():
            if not UPLOAD.fullmatch(directory.name):
                continue
            metadata = _read_json(directory / 'manifest.json', 4 * 1024 * 1024)
            if not isinstance(metadata, dict):
                raise ProjectContextError('Invalid upload metadata; cleanup stopped.')
            if metadata.get('scope') == scope:
                _manifest(metadata.get('root_path'), metadata.get('manifest'))
                if metadata.get('upload_id') != directory.name:
                    raise ProjectContextError('Invalid upload identity; cleanup stopped.')
                result[directory] = metadata
        return result

    def _snapshot_metadata(self, scope):
        result = {}
        for path in self.store.snapshots.iterdir():
            if not path.name.endswith('.json') or not _HEX.fullmatch(path.stem):
                continue
            data = _read_json(path)
            if not isinstance(data, dict) or data.get('version') not in (1, 2) or data.get('snapshot_id') != path.stem:
                raise ProjectContextError('Invalid snapshot metadata; source cleanup stopped.')
            if data.get('scope') == scope:
                _manifest(data.get('root_path'), data.get('manifest'))
                result[path.stem] = data
        return result

    def _info(self, scope, state):
        snapshots = self._snapshot_metadata(scope)
        counts = {'temporary': 0, 'persistent': 0, 'legacy': 0}
        for snapshot in snapshots:
            counts[state['snapshots'].get(snapshot, 'legacy')] += 1
        uploads = self._uploads(scope)
        revision = hashlib.sha256(_json_bytes({'scope': scope, 'snapshots': snapshots,
                                               'uploads': sorted(path.name for path in uploads),
                                               'retention': state['snapshots'], 'pins': state['pins']})).hexdigest()
        folder = self.store.root / 'mirrors' / scope
        blob_directory = self.store.blobs / scope
        _check_components(blob_directory)
        blob_bytes = 0
        if blob_directory.exists():
            for path in blob_directory.iterdir():
                if path.suffix == '.utf8' and _HEX.fullmatch(path.stem):
                    _check_components(path)
                    if not path.is_file() or not is_private(path):
                        raise ProjectContextError('Unowned cached source; cache inspection stopped.')
                    blob_bytes += path.stat().st_size
        inline_bytes = sum(sum(e['bytes'] for e in s['manifest']) for s in snapshots.values() if s['version'] == 1)
        mirror_bytes = sum(self._tree_bytes(path) for path in self._mirror_directories(scope))
        upload_bytes = sum(self._tree_bytes(path) for path in uploads)
        return {'folder': str(folder) if folder.exists() else None, 'snapshotCount': len(snapshots),
                'totalBytes': blob_bytes + inline_bytes + mirror_bytes + upload_bytes,
                'lastSyncedAt': max((s.get('created_at', 0) for s in snapshots.values()), default=0),
                'temporaryCount': counts['temporary'], 'persistentCount': counts['persistent'], 'legacyCount': counts['legacy'],
                'pageCount': len(state['pages']), 'pinCount': len(state['pins']),
                'cleanupPending': not state['pages'] and state['empty_since'] is not None and counts['temporary'] > 0,
                'cacheRevision': revision}

    def info(self, scope):
        with self._transaction(scope, write=False) as state:
            return self._info(scope, state)

    def pins(self, scope):
        with self._transaction(scope, write=False) as state:
            return copy.deepcopy(state['pins'])

    def _delete_versions(self, scope, state, targets, snapshots):
        remaining = {key: value for key, value in snapshots.items() if key not in targets}
        # Check every target before changing any content; never follow a mirror link.
        for key in targets:
            _check_components(self.store.snapshots / (key + '.json'))
            _check_components(self.store.root / 'mirrors' / scope / key)
        for key in targets:
            self._remove_mirror(self.store.root / 'mirrors' / scope / key)
            (self.store.snapshots / (key + '.json')).unlink()
            state['snapshots'].pop(key, None)
        for path in self.store.dedup.iterdir():
            if path.suffix == '.json' and _HEX.fullmatch(path.stem):
                data = _read_json(path)
                if data.get('scope') == scope and data.get('snapshot_id') in targets:
                    path.unlink()
        # Recompute references even when the previous process died after
        # unlinking a manifest. Orphan source must not become invisible forever.
        self._prune_unreferenced_blobs(scope, state, remaining)

    def _prune_unreferenced_blobs(self, scope, state, snapshots):
        protected = {snapshot for pin in state['pins'].values() for snapshot in pin['snapshots']}
        if protected - set(snapshots):
            return  # A missing pinned manifest cannot prove its bytes unused.
        referenced = {e['sha256'] for value in snapshots.values() if value['version'] == 2 for e in value['manifest']}
        for metadata in self._uploads(scope).values():
            referenced.update(entry['sha256'] for entry in metadata['manifest'])
        directory = self.store.blobs / scope
        _check_components(directory)
        if not directory.exists():
            return
        for path in directory.iterdir():
            if path.suffix != '.utf8' or not _HEX.fullmatch(path.stem) or path.stem in referenced:
                continue
            _check_components(path)
            if not is_private(path) or not path.is_file():
                raise ProjectContextError('Unowned cached source; cleanup stopped.')
            path.unlink()

    def sweep(self, scope):
        with self._transaction(scope) as state:
            empty = state['empty_since']
            if not state['pages'] and empty is not None and self._now() >= empty + self.grace:
                for directory in self._mirror_directories(scope):
                    if directory.name.startswith('.new-'):
                        self._remove_mirror(directory)
                protected = {snapshot for pin in state['pins'].values() for snapshot in pin['snapshots']}
                snapshots = self._snapshot_metadata(scope)
                targets = {key for key in snapshots if state['snapshots'].get(key) == 'temporary' and key not in protected}
                self._delete_versions(scope, state, targets, snapshots)
            return self._info(scope, state)

    def clear(self, scope, revision):
        _identifier(revision, _HEX)
        with self._transaction(scope) as state:
            if state['pins']:
                raise ProjectContextError('Queued, active or unconfirmed replies still use these sources. Resolve them before clearing the local cache.')
            if self._info(scope, state)['cacheRevision'] != revision:
                raise ProjectContextError('The cached versions changed. Review the current list before clearing again.')
            for directory in self._uploads(scope):
                self._tree_bytes(directory)  # Prove owned, no reparse points.
                shutil.rmtree(directory)
            snapshots = self._snapshot_metadata(scope)
            self._delete_versions(scope, state, set(snapshots), snapshots)
            for directory in self._mirror_directories(scope):
                self._remove_mirror(directory)
            return self._info(scope, state)
