import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from platform_test_support import assert_private, make_symlink, private_permissions

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from project_context import MAX_FILE_BYTES, ProjectContextError, ProjectContextStore

SCOPE = hashlib.sha256(b'account/project').hexdigest()
OTHER_SCOPE = hashlib.sha256(b'other-account/project').hexdigest()


def manifest(files):
    return [{'path': path, 'bytes': len(content.encode('utf-8')),
             'sha256': hashlib.sha256(content.encode('utf-8')).hexdigest()} for path, content in files.items()]


def upload(store, files, root=None):
    identifier = store.begin(SCOPE, root if root is not None else next(iter(files), ''), manifest(files))
    for path, content in files.items():
        offset = 0
        for start in range(0, len(content), 100000):
            part = content[start:start + 100000]
            acknowledgement = store.chunk(SCOPE, identifier, path, offset, part)
            offset += len(part.encode('utf-8'))
            if acknowledgement['offset'] != offset:
                raise AssertionError('Incorrect UTF-8 upload acknowledgement')
    return store.commit(SCOPE, identifier)


class ProjectContextTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name).resolve()
        self.store = ProjectContextStore(self.base / 'context')

    def tearDown(self):
        self.temporary.cleanup()

    def test_full_large_project_survives_restart_without_file_or_text_truncation(self):
        content = ('正文中文\\cN ' * 15000) + 'MIDDLE_MARKER' + (' tail' * 18000)
        files = {'main.tex': content}
        files.update({'chapters/%03d.tex' % i: 'complete file %s' % i for i in range(70)})
        snapshot_id = upload(self.store, files)
        restored = ProjectContextStore(self.store.root, read_only=True).get(SCOPE, snapshot_id)
        self.assertEqual({item['path']: item['content'] for item in restored['files']}, files)
        self.assertEqual(restored['root_path'], 'main.tex')
        self.assertEqual(len(restored['manifest']), 71)
        self.assertRegex(snapshot_id, r'^[a-f0-9]{64}$')
        self.assertFalse(list(self.store.uploads.iterdir()))
        self.assertFalse((self.base / 'main.tex').exists())

    def test_chinese_offsets_are_utf8_bytes_and_failed_chunk_is_atomic(self):
        content = '中文abc公式'
        identifier = self.store.begin(SCOPE, 'main.tex', manifest({'main.tex': content}))
        first = self.store.chunk(SCOPE, identifier, 'main.tex', 0, '中文abc')
        self.assertEqual(first['offset'], 9)
        with self.assertRaisesRegex(ProjectContextError, 'sequential'):
            self.store.chunk(SCOPE, identifier, 'main.tex', 5, '公式')
        self.assertFalse(list(self.store.snapshots.iterdir()))
        self.store.chunk(SCOPE, identifier, 'main.tex', 9, '公式')
        result = self.store.get(SCOPE, self.store.commit(SCOPE, identifier))
        self.assertEqual(result['files'][0]['content'], content)

    def test_cross_scope_upload_commit_and_snapshot_access_are_denied(self):
        identifier = self.store.begin(SCOPE, 'main.tex', manifest({'main.tex': 'private'}))
        with self.assertRaises(ProjectContextError):
            self.store.chunk(OTHER_SCOPE, identifier, 'main.tex', 0, 'private')
        with self.assertRaises(ProjectContextError):
            self.store.commit(OTHER_SCOPE, identifier)
        self.store.chunk(SCOPE, identifier, 'main.tex', 0, 'private')
        snapshot_id = self.store.commit(SCOPE, identifier)
        with self.assertRaisesRegex(ProjectContextError, 'current project'):
            self.store.get(OTHER_SCOPE, snapshot_id)
        self.assertEqual(self.store.read_snapshot(snapshot_id)['files'][0]['content'], 'private')

    def test_missing_chunks_and_hash_mismatch_never_publish_a_snapshot(self):
        identifier = self.store.begin(SCOPE, 'main.tex', manifest({'main.tex': 'correct', 'defs.sty': 'data'}))
        self.store.chunk(SCOPE, identifier, 'main.tex', 0, 'wrong!!')
        with self.assertRaisesRegex(ProjectContextError, 'incomplete|SHA256'):
            self.store.commit(SCOPE, identifier)
        self.assertFalse(list(self.store.snapshots.iterdir()))
        missing = self.store.begin(SCOPE, 'main.tex', manifest({'main.tex': 'a'}))
        with self.assertRaises(ProjectContextError):
            self.store.commit(SCOPE, missing)
        self.assertFalse(list(self.store.snapshots.iterdir()))

    def test_distinct_snapshots_are_immutable_and_identical_content_reuses_a_version(self):
        first = upload(self.store, {'main.tex': 'first'})
        original = (self.store.snapshots / (first + '.json')).read_bytes()
        second = upload(self.store, {'main.tex': 'second'})
        third = upload(self.store, {'main.tex': 'first'})
        self.assertEqual(len({first, second, third}), 2)
        self.assertEqual(third, first)
        self.assertEqual((self.store.snapshots / (first + '.json')).read_bytes(), original)
        self.assertEqual(self.store.get(SCOPE, first)['files'][0]['content'], 'first')
        assert_private(self, self.store.root, 0o700)
        assert_private(self, (self.store.snapshots / (first + '.json')), 0o400)

    def test_paths_root_and_manifest_limits_are_strict(self):
        for path in ('../main.tex', '/tmp/main.tex', 'a//b', 'a/./b', 'a\\b', 'a\x00b', 'C:main.tex'):
            with self.subTest(path=path), self.assertRaises(ProjectContextError):
                self.store.begin(SCOPE, path, manifest({path: 'x'}))
        with self.assertRaises(ProjectContextError):
            self.store.begin(SCOPE, 'missing.tex', manifest({'main.tex': 'x'}))
        with self.assertRaises(ProjectContextError):
            self.store.begin(SCOPE, 'main.tex', manifest({'main.tex': 'x'}) * 2)
        many = manifest({'%s.tex' % i: '' for i in range(2001)})
        with self.assertRaises(ProjectContextError):
            self.store.begin(SCOPE, '0.tex', many)
        oversized = manifest({'main.tex': ''}); oversized[0]['bytes'] = MAX_FILE_BYTES + 1
        with self.assertRaises(ProjectContextError):
            self.store.begin(SCOPE, 'main.tex', oversized)
        total = manifest({'%s.tex' % i: '' for i in range(9)})
        for entry in total:
            entry['bytes'] = MAX_FILE_BYTES
        with self.assertRaises(ProjectContextError):
            self.store.begin(SCOPE, '0.tex', total)
        with self.assertRaises(ProjectContextError):
            self.store.begin(SCOPE, {}, [])

    def test_chunk_limits_and_unknown_paths_are_rejected(self):
        identifier = self.store.begin(SCOPE, 'main.tex', manifest({'main.tex': 'x' * 300000}))
        for path, offset, content in [('other.tex', 0, 'x'), ('main.tex', True, 'x'),
                                      ('main.tex', 0, 'x' * 200001), ('main.tex', 0, '\ud800')]:
            with self.subTest(path=path, offset=offset), self.assertRaises(ProjectContextError):
                self.store.chunk(SCOPE, identifier, path, offset, content)
        with self.assertRaises(ProjectContextError):
            self.store.chunk(SCOPE, identifier, 'main.tex', 0, '\U0001f600' * 100001)

    def test_symlink_roots_parents_upload_blobs_and_snapshot_files_are_rejected(self):
        link = self.base / 'linked'; make_symlink(link, self.store.root, target_is_directory=True)
        with self.assertRaises(ProjectContextError):
            ProjectContextStore(link)
        with self.assertRaises(ProjectContextError):
            ProjectContextStore(link / 'child')
        target = self.base / 'private'; target.write_text('unchanged'); private_permissions(target, 0o600)
        identifier = self.store.begin(SCOPE, 'main.tex', manifest({'main.tex': 'x'}))
        blob = self.store._blob(self.store.uploads / identifier, 'main.tex'); make_symlink(blob, target)
        with self.assertRaises(ProjectContextError):
            self.store.chunk(SCOPE, identifier, 'main.tex', 0, 'x')
        with self.assertRaises(ProjectContextError):
            self.store.commit(SCOPE, identifier)
        snapshot_path = self.store.snapshots / ('a' * 64 + '.json'); make_symlink(snapshot_path, target)
        with self.assertRaises(ProjectContextError):
            self.store.read_snapshot('a' * 64)
        self.assertEqual(target.read_text(), 'unchanged')

    def test_disk_corruption_and_invalid_capability_are_detected(self):
        snapshot_id = upload(self.store, {'main.tex': 'original'})
        entry = manifest({'main.tex': 'original'})[0]
        path = self.store._content_blob(SCOPE, entry['sha256'])
        private_permissions(path, 0o600); path.write_text('replaced')
        with self.assertRaisesRegex(ProjectContextError, 'integrity'):
            self.store.read_snapshot(snapshot_id)
        with self.assertRaises(ProjectContextError):
            self.store.read_snapshot('../' + snapshot_id)

    def test_empty_selection_snapshot_and_read_only_mode(self):
        snapshot_id = upload(self.store, {}, '')
        readonly = ProjectContextStore(self.store.root, read_only=True)
        self.assertEqual(readonly.get(SCOPE, snapshot_id)['files'], [])
        with self.assertRaisesRegex(ProjectContextError, 'read-only'):
            readonly.begin(SCOPE, '', [])
        missing = self.base / 'not-created'
        ProjectContextStore(missing, read_only=True)
        self.assertFalse(missing.exists())

    def test_unknown_root_retains_all_files_without_guessing_an_entry_document(self):
        snapshot_id = upload(self.store, {'one.tex': 'one', 'two.tex': 'two'}, '')
        snapshot = self.store.get(SCOPE, snapshot_id)
        self.assertEqual(snapshot['root_path'], '')
        self.assertEqual(len(snapshot['files']), 2)


if __name__ == '__main__':
    unittest.main()
