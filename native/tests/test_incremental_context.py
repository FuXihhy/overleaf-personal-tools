"""Incremental local source snapshots; synthetic files only, no model/network."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from platform_test_support import assert_private, make_symlink, private_permissions

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from project_context import ProjectContextError, ProjectContextStore
from test_project_context import SCOPE, OTHER_SCOPE, manifest, upload


class IncrementalContextTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name).resolve()
        self.store = ProjectContextStore(self.base / 'context')

    def tearDown(self):
        self.temporary.cleanup()

    def delta(self, files, scope=SCOPE, root='main.tex'):
        identifier = self.store.begin(scope, root, manifest(files))
        missing = self.store.missing_paths(scope, identifier)
        for path in missing:
            if files[path]:
                self.store.chunk(scope, identifier, path, 0, files[path])
        return self.store.commit(scope, identifier), missing

    def test_unchanged_content_reuses_snapshot_and_never_rewrites_blobs(self):
        files = {'main.tex': '中文正文', 'defs.sty': 'macro definition', 'empty.tex': ''}
        first, missing = self.delta(files)
        self.assertEqual(set(missing), {'main.tex', 'defs.sty'})
        blob_stats = {p.name: (p.stat().st_ino, p.stat().st_mtime_ns) for p in (self.store.blobs / SCOPE).iterdir()}
        second, missing = self.delta(files)
        self.assertEqual((first, missing), (second, []))
        self.assertEqual(blob_stats, {p.name: (p.stat().st_ino, p.stat().st_mtime_ns) for p in (self.store.blobs / SCOPE).iterdir()})
        stored = json.loads((self.store.snapshots / (first + '.json')).read_text())
        self.assertEqual(stored['version'], 2)
        self.assertNotIn('files', stored)
        self.assertNotIn('macro definition', json.dumps(stored))

    def test_one_changed_file_writes_one_blob_and_preserves_old_version(self):
        first, _ = self.delta({'main.tex': 'first', 'defs.sty': 'unchanged'})
        before = {p.name: p.stat().st_ino for p in (self.store.blobs / SCOPE).iterdir()}
        second, missing = self.delta({'main.tex': 'second', 'defs.sty': 'unchanged'})
        after = {p.name: p.stat().st_ino for p in (self.store.blobs / SCOPE).iterdir()}
        self.assertEqual(missing, ['main.tex'])
        self.assertEqual(len(set(after) - set(before)), 1)
        self.assertTrue(all(after[name] == inode for name, inode in before.items()))
        self.assertEqual(self.store.get(SCOPE, first)['files'][0]['content'], 'first')
        self.assertEqual(self.store.get(SCOPE, second)['files'][0]['content'], 'second')

    def test_deleted_and_renamed_files_use_exact_current_manifest(self):
        first, _ = self.delta({'main.tex': 'body', 'old.tex': 'same bytes', 'delete.tex': 'deleted'})
        second, missing = self.delta({'main.tex': 'body', 'new/path.tex': 'same bytes'})
        self.assertEqual(missing, [])
        self.assertEqual([entry['path'] for entry in self.store.get(SCOPE, second)['files']], ['main.tex', 'new/path.tex'])
        self.assertEqual(len(self.store.get(SCOPE, first)['files']), 3)

    def test_reuse_never_crosses_account_project_scope(self):
        files = {'main.tex': 'identical bytes'}
        first, _ = self.delta(files)
        second, missing = self.delta(files, OTHER_SCOPE)
        self.assertEqual(missing, ['main.tex'])
        self.assertNotEqual(first, second)
        for scope in (SCOPE, OTHER_SCOPE):
            self.assertEqual(len(list((self.store.blobs / scope).iterdir())), 1)
        with self.assertRaises(ProjectContextError):
            self.store.missing_paths(OTHER_SCOPE, self.store.begin(SCOPE, 'main.tex', manifest(files)))

    def test_missing_or_corrupt_blob_requires_upload_and_heals_same_snapshot(self):
        files = {'main.tex': 'exact bytes', 'defs.sty': 'keep'}
        original, _ = self.delta(files)
        entry = manifest(files)[0]
        blob = self.store._content_blob(SCOPE, entry['sha256'])
        for corrupt in (True, False):
            if corrupt:
                private_permissions(blob, 0o600); blob.write_bytes(b'incorrect')
            else:
                blob.unlink()
            with self.assertRaises(ProjectContextError):
                self.store.get(SCOPE, original)
            recovered, missing = self.delta(files)
            self.assertEqual(missing, ['main.tex'])
            self.assertEqual(recovered, original)
            self.assertEqual(self.store.get(SCOPE, original)['files'][0]['content'], files['main.tex'])
            assert_private(self, blob, 0o400)

    def test_corruption_after_missing_list_never_publishes_partial_snapshot(self):
        files = {'main.tex': 'exact bytes'}
        self.delta(files)
        identifier = self.store.begin(SCOPE, 'main.tex', manifest(files))
        self.assertEqual(self.store.missing_paths(SCOPE, identifier), [])
        blob = self.store._content_blob(SCOPE, manifest(files)[0]['sha256'])
        blob.unlink()
        with self.assertRaisesRegex(ProjectContextError, 'incomplete|unavailable'):
            self.store.commit(SCOPE, identifier)
        self.assertEqual(len(list(self.store.snapshots.iterdir())), 1)

    def test_changed_download_cannot_relabel_old_snapshot_with_new_source(self):
        first, _ = self.delta({'main.tex': 'old content'})
        old_blob = self.store._content_blob(SCOPE, manifest({'main.tex': 'old content'})[0]['sha256'])
        old_blob.unlink()
        second, missing = self.delta({'main.tex': 'new content'})
        self.assertNotEqual(first, second)
        with self.assertRaises(ProjectContextError):
            self.store.get(SCOPE, first)
        self.assertEqual(self.store.get(SCOPE, second)['files'][0]['content'], 'new content')

    def test_legacy_v1_snapshot_remains_readable_without_blob_migration(self):
        snapshot_id = 'a' * 64
        files = {'main.tex': 'legacy text'}
        path = self.store.snapshots / (snapshot_id + '.json')
        value = {'version': 1, 'snapshot_id': snapshot_id, 'scope': SCOPE, 'root_path': 'main.tex',
                 'manifest': manifest(files), 'files': [{'path': p, 'content': text} for p, text in files.items()], 'created_at': 1}
        path.write_text(json.dumps(value)); private_permissions(path, 0o400)
        reader = ProjectContextStore(self.store.root, read_only=True)
        self.assertEqual(reader.get(SCOPE, snapshot_id)['files'], value['files'])
        self.assertEqual(list(self.store.blobs.iterdir()), [])
        self.assertEqual(json.loads(path.read_text()), value)
        # A legacy client can still send all files, including unchanged ones.
        second = upload(self.store, files)
        self.assertEqual(upload(self.store, files), second)
        self.assertEqual(reader.get(SCOPE, snapshot_id)['files'], value['files'])

    def test_content_blob_symlink_is_not_followed_or_replaced(self):
        files = {'main.tex': 'safe'}
        self.delta(files)
        blob = self.store._content_blob(SCOPE, manifest(files)[0]['sha256'])
        blob.unlink()
        outside = self.base / 'outside'; outside.write_text('never modify'); private_permissions(outside, 0o600)
        make_symlink(blob, outside)
        identifier = self.store.begin(SCOPE, 'main.tex', manifest(files))
        self.assertEqual(self.store.missing_paths(SCOPE, identifier), ['main.tex'])
        self.store.chunk(SCOPE, identifier, 'main.tex', 0, 'safe')
        with self.assertRaisesRegex(ProjectContextError, 'symlink'):
            self.store.commit(SCOPE, identifier)
        self.assertEqual(outside.read_text(), 'never modify')
        self.assertTrue(blob.is_symlink())


if __name__ == '__main__':
    unittest.main()
