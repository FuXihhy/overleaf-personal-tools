"""Private source blobs work beyond MAX_PATH without changing machine policy."""
import hashlib
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parents[1]))
from project_context import ProjectContextStore


@unittest.skipUnless(os.name == 'nt', 'Windows extended-path integration')
class WindowsStoragePathTests(unittest.TestCase):
    def test_long_profile_snapshot_upload_commit_and_read_only_restart(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / ('a' * 70) / ('b' * 70)
            store = ProjectContextStore(root)
            scope = hashlib.sha256(b'only-synthetic-long-path-scope').hexdigest()
            content = '完整中文与emoji 😀\n' * 3
            raw = content.encode('utf-8')
            manifest = [{'path': '章节/测试😀.tex', 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}]
            try:
                self.assertTrue(str(store.root).startswith('\\\\?\\'))
                self.assertGreater(len(str(store.blobs / scope / (manifest[0]['sha256'] + '.utf8'))), 260)
                upload = store.begin(scope, manifest[0]['path'], manifest)
                store.chunk(scope, upload, manifest[0]['path'], 0, content)
                snapshot = store.commit(scope, upload)
                restored = ProjectContextStore(root, read_only=True).get(scope, snapshot)
                self.assertEqual(restored['files'], [{'path': manifest[0]['path'], 'content': content}])
            finally:
                # Remove only this test's validated child, using its extended
                # path so TemporaryDirectory's unprefixed walk stays short.
                actual = str(store.root)[4:]
                self.assertEqual(Path(actual), root)
                self.assertEqual(os.path.commonpath((str(root), temporary)), temporary)
                shutil.rmtree(store.root)


if __name__ == '__main__':
    unittest.main()
