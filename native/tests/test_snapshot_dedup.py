"""Storage growth and staging cleanup tests; no model or user manuscript is used."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from platform_test_support import assert_private, make_symlink, private_permissions
import uuid
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import project_context as context

SCOPE = hashlib.sha256(b'account/project').hexdigest()
OTHER = hashlib.sha256(b'another-account/project').hexdigest()


def manifest(files):
    return [{'path': path, 'bytes': len(text.encode('utf-8')),
             'sha256': hashlib.sha256(text.encode('utf-8')).hexdigest()}
            for path, text in files.items()]


def prepare(store, files, root='main.tex', scope=SCOPE):
    upload_id = store.begin(scope, root, manifest(files))
    for path, text in files.items():
        if text:
            store.chunk(scope, upload_id, path, 0, text)
    return upload_id


def publish(store, files, root='main.tex', scope=SCOPE):
    return store.commit(scope, prepare(store, files, root, scope))


def process_commit(root, upload_id, ready, result):
    try:
        store = context.ProjectContextStore(Path(root))
        ready.wait(5)
        result.put(('ok', store.commit(SCOPE, upload_id)))
    except Exception as error:
        result.put(('error', str(error)))


class SnapshotStorageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name).resolve()
        self.store = context.ProjectContextStore(self.base / 'context')

    def tearDown(self):
        self.temporary.cleanup()

    def index_for(self, files, root='main.tex', scope=SCOPE):
        key = self.store._fingerprint(scope, root, manifest(files))
        return self.store.dedup / (key + '.json')

    def age_upload(self, upload_id):
        past = time.time() - context.UPLOAD_IDLE_TTL - 60
        os.utime(self.store.uploads / upload_id, (past, past))

    def test_repeated_empty_and_unicode_sources_reuse_private_capabilities(self):
        for files, root in [({}, ''), ({'main.tex': ''}, 'main.tex'),
                            ({'main.tex': '中文😀\\cN\n正文', 'defs.sty': '宏定义'}, 'main.tex')]:
            with self.subTest(files=files):
                first = publish(self.store, files, root)
                before = (self.store.snapshots / (first + '.json')).read_bytes()
                for _ in range(3):
                    self.assertEqual(publish(context.ProjectContextStore(self.store.root), files, root), first)
                self.assertEqual((self.store.snapshots / (first + '.json')).read_bytes(), before)
                self.assertNotEqual(first, self.index_for(files, root).stem)
        self.assertEqual(len(list(self.store.snapshots.iterdir())), 3)
        self.assertEqual(list(self.store.uploads.iterdir()), [])

    def test_manifest_order_does_not_create_a_second_version(self):
        files = {'main.tex': '正文', 'defs.sty': 'definitions'}
        original = publish(self.store, files)
        self.assertEqual(publish(self.store, dict(reversed(list(files.items())))), original)

    def test_changed_revision_root_and_scope_never_share_a_capability(self):
        files = {'main.tex': 'original', 'other.tex': 'chapter'}
        first = publish(self.store, files)
        changed = publish(self.store, dict(files, **{'main.tex': 'revised'}))
        other_root = publish(self.store, files, 'other.tex')
        other_scope = publish(self.store, files, scope=OTHER)
        self.assertEqual(len({first, changed, other_root, other_scope}), 4)
        self.assertEqual(publish(self.store, files), first)
        self.assertEqual(self.store.get(SCOPE, first)['files'][0]['content'], 'original')

    def test_independent_processes_commit_identical_uploads_as_one_snapshot(self):
        first = prepare(self.store, {'main.tex': 'concurrent 中文'})
        second = prepare(self.store, {'main.tex': 'concurrent 中文'})
        spawn = multiprocessing.get_context('spawn')
        ready, result = spawn.Event(), spawn.Queue()
        workers = [spawn.Process(target=process_commit, args=(str(self.store.root), upload, ready, result))
                   for upload in (first, second)]
        try:
            for worker in workers:
                worker.start()
            ready.set()
            outcomes = [result.get(timeout=10) for _ in workers]
            for worker in workers:
                worker.join(10)
                self.assertEqual(worker.exitcode, 0)
            self.assertEqual([outcome[0] for outcome in outcomes], ['ok', 'ok'])
            self.assertEqual(outcomes[0][1], outcomes[1][1])
            self.assertEqual(len(list(self.store.snapshots.iterdir())), 1)
        finally:
            for worker in workers:
                if worker.is_alive():
                    worker.terminate(); worker.join(3)
            result.close()

    def test_corrupt_or_foreign_index_never_substitutes_another_snapshot(self):
        files = {'main.tex': 'expected'}
        original = publish(self.store, files)
        foreign = publish(self.store, {'main.tex': 'different'}, scope=OTHER)
        index = self.index_for(files)
        value = json.loads(index.read_text())
        value['snapshot_id'] = foreign
        index.write_text(json.dumps(value))
        repaired = publish(self.store, files)
        self.assertNotEqual(repaired, foreign)
        self.assertEqual(self.store.get(SCOPE, repaired)['files'][0]['content'], 'expected')
        self.assertEqual(self.store.get(SCOPE, original)['files'][0]['content'], 'expected')
        index.write_bytes(b'{invalid json')
        again = publish(self.store, files)
        self.assertEqual(publish(self.store, files), again)
        self.assertEqual(self.store.get(OTHER, foreign)['files'][0]['content'], 'different')

    def test_corrupt_index_target_is_not_reused_or_overwritten(self):
        files = {'main.tex': 'expected'}
        original = publish(self.store, files)
        path = self.store.snapshots / (original + '.json')
        value = json.loads(path.read_text()); value['root_path'] = 'corrupted-missing-root.tex'
        private_permissions(path, 0o600); path.write_text(json.dumps(value))
        saved = path.read_bytes()
        repaired = publish(self.store, files)
        self.assertNotEqual(original, repaired)
        self.assertEqual(self.store.get(SCOPE, repaired)['files'][0]['content'], 'expected')
        self.assertEqual(path.read_bytes(), saved)

    def test_symlink_index_is_rejected_without_touching_its_target(self):
        files = {'main.tex': 'expected'}
        original = publish(self.store, files)
        index = self.index_for(files)
        target = self.base / 'outside'; target.write_text('keep')
        index.unlink(); make_symlink(index, target)
        with self.assertRaisesRegex(context.ProjectContextError, 'symlink'):
            publish(self.store, files)
        self.assertEqual(target.read_text(), 'keep')
        self.assertEqual(self.store.get(SCOPE, original)['files'][0]['content'], 'expected')

    def test_old_snapshot_without_an_index_remains_readable_and_readonly(self):
        snapshot_id = publish(self.store, {'main.tex': 'legacy'})
        index = self.index_for({'main.tex': 'legacy'}); index.unlink(); self.store.dedup.rmdir()
        before = (self.store.snapshots / (snapshot_id + '.json')).read_bytes()
        reader = context.ProjectContextStore(self.store.root, read_only=True)
        self.assertEqual(reader.read_snapshot(snapshot_id)['files'][0]['content'], 'legacy')
        self.assertFalse(self.store.dedup.exists())
        self.assertEqual((self.store.snapshots / (snapshot_id + '.json')).read_bytes(), before)

    def test_cleanup_removes_only_idle_uploads_not_old_published_versions(self):
        snapshot = publish(self.store, {'main.tex': 'keep forever'})
        published = self.store.snapshots / (snapshot + '.json')
        old = time.time() - context.UPLOAD_IDLE_TTL - 60
        private_permissions(published, 0o600)
        os.utime(published, (old, old))
        private_permissions(published, 0o400)
        expired = self.store.begin(SCOPE, 'main.tex', manifest({'main.tex': 'unfinished'}))
        active = self.store.begin(SCOPE, 'main.tex', manifest({'main.tex': 'active'}))
        self.age_upload(expired)
        fresh = self.store.begin(SCOPE, 'main.tex', manifest({'main.tex': 'new'}))
        self.assertFalse((self.store.uploads / expired).exists())
        self.assertTrue((self.store.uploads / active).exists())
        self.assertTrue((self.store.uploads / fresh).exists())
        self.assertEqual(self.store.read_snapshot(snapshot)['files'][0]['content'], 'keep forever')

    def test_last_valid_chunk_activity_keeps_an_old_upload_alive(self):
        upload = self.store.begin(SCOPE, 'main.tex', manifest({'main.tex': 'part1part2'}))
        self.age_upload(upload)
        self.store.chunk(SCOPE, upload, 'main.tex', 0, 'part1')
        self.store.begin(SCOPE, '', [])
        self.assertTrue((self.store.uploads / upload).exists())
        self.store.chunk(SCOPE, upload, 'main.tex', 5, 'part2')
        self.assertEqual(self.store.get(SCOPE, self.store.commit(SCOPE, upload))['files'][0]['content'], 'part1part2')

    def test_cleanup_waits_for_inflight_chunk_before_deciding_its_age(self):
        upload = self.store.begin(SCOPE, 'main.tex', manifest({'main.tex': 'part'}))
        self.age_upload(upload)
        entered, release = threading.Event(), threading.Event()
        original = context._atomic_bytes

        def blocked_write(path, data, immutable=False):
            if path.suffix == '.part':
                entered.set()
                if not release.wait(5):
                    raise RuntimeError('Test release timed out')
            return original(path, data, immutable)

        with ThreadPoolExecutor(max_workers=2) as pool, mock.patch.object(context, '_atomic_bytes', side_effect=blocked_write):
            writing = pool.submit(self.store.chunk, SCOPE, upload, 'main.tex', 0, 'part')
            self.assertTrue(entered.wait(5))
            other_store = context.ProjectContextStore(self.store.root)
            cleaning = pool.submit(other_store.begin, SCOPE, '', [])
            self.assertFalse(cleaning.done())
            release.set()
            writing.result(5); cleaning.result(5)
        self.assertTrue((self.store.uploads / upload).exists())
        self.store.commit(SCOPE, upload)

    def test_cleanup_never_follows_upload_directory_symlinks(self):
        outside = self.base / 'outside'; outside.mkdir(); (outside / 'keep').write_text('private')
        link = self.store.uploads / str(uuid.uuid4()); make_symlink(link, outside, target_is_directory=True)
        self.store.begin(SCOPE, '', [])
        self.assertTrue(link.is_symlink())
        self.assertEqual((outside / 'keep').read_text(), 'private')


if __name__ == '__main__':
    unittest.main()
