"""Production publication/deletion and native admission, synthetic sources only."""
import hashlib
import io
import multiprocessing
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from test_codex_host import host, FakeServer, Messages
from cache_lifecycle import CacheLifecycle
from project_context import ProjectContextError, ProjectContextStore
from platform_utils import IS_WINDOWS, private_permissions
from test_codex_steer import SteerServer

SCOPE = hashlib.sha256(b'cache-runtime').hexdigest()
OTHER = hashlib.sha256(b'other-cache-runtime').hexdigest()


def manifest(files):
    return [{'path': path, 'bytes': len(text.encode('utf-8')),
             'sha256': hashlib.sha256(text.encode('utf-8')).hexdigest()} for path, text in files.items()]


def crash_before_mirror_publication(root):
    store = ProjectContextStore(Path(root))
    upload = store.begin(SCOPE, 'main.tex', manifest({'main.tex': 'crash source'}), 'persistent', 'lease')
    store.chunk(SCOPE, upload, 'main.tex', 0, 'crash source')
    original = os.rename
    def interrupted(source, destination):
        if 'mirrors' in Path(destination).parts:
            os._exit(23)
        return original(source, destination)
    with mock.patch('os.rename', side_effect=interrupted):
        store.commit(SCOPE, upload)


class RuntimeCacheTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = ProjectContextStore(Path(self.tmp.name).resolve() / 'sources')
        self.now = 1000
        self.cache = CacheLifecycle(self.store, clock=lambda: self.now)
        self.cache.acquire_page(SCOPE, 'browser', 'doc', 'lease')

    def tearDown(self):
        self.tmp.cleanup()

    def capture(self, files=None, mode='on-demand', scope=SCOPE):
        files = files or {'main.tex': 'synthetic α\r\n\x1a'}
        args = (mode, 'lease') if mode else ()
        upload = self.store.begin(scope, next(iter(files)), manifest(files), *args)
        missing = self.store.missing_paths(scope, upload)
        for path, text in files.items():
            if path in missing:
                self.store.chunk(scope, upload, path, 0, text)
        return self.store.commit(scope, upload)

    def leave(self):
        self.cache.release_page(SCOPE, 'browser', 'doc', 'lease', confirmed_departure=True)
        self.now += 31

    def test_publication_is_registered_and_last_of_two_pages_reclaims_real_bytes(self):
        snapshot = self.capture()
        self.assertEqual(self.cache.info(SCOPE)['temporaryCount'], 1)
        self.cache.acquire_page(SCOPE, 'browser', 'doc2', 'lease2')
        self.leave()
        self.assertEqual(self.cache.sweep(SCOPE)['snapshotCount'], 1)
        self.cache.release_page(SCOPE, 'browser', 'doc2', 'lease2', confirmed_departure=True)
        self.assertEqual(self.cache.sweep(SCOPE)['snapshotCount'], 1)
        self.now += 31
        info = self.cache.sweep(SCOPE)
        self.assertEqual((info['snapshotCount'], info['totalBytes']), (0, 0))
        with self.assertRaises(ProjectContextError):
            self.store.get(SCOPE, snapshot)

    def test_commit_after_positive_departure_cannot_publish_new_snapshot(self):
        upload = self.store.begin(SCOPE, 'main.tex', manifest({'main.tex': 'x'}), 'on-demand', 'lease')
        self.store.chunk(SCOPE, upload, 'main.tex', 0, 'x')
        self.leave()
        with self.assertRaisesRegex(ProjectContextError, 'not registered'):
            self.store.commit(SCOPE, upload)
        self.assertEqual(self.cache.info(SCOPE)['snapshotCount'], 0)

    def test_normal_capture_and_unregistered_lease_are_rejected(self):
        for mode, token in [('normal', 'lease'), ('on-demand', 'foreign')]:
            with self.subTest(mode=mode), self.assertRaises(ProjectContextError):
                self.store.begin(SCOPE, 'main.tex', manifest({'main.tex': 'x'}), mode, token)

    def test_old_deduplicated_and_other_scope_versions_survive(self):
        legacy = self.capture({'main.tex': 'old'}, mode=None)
        self.assertEqual(self.capture({'main.tex': 'old'}), legacy)
        foreign = self.capture({'main.tex': 'foreign'}, mode=None, scope=OTHER)
        self.capture({'main.tex': 'new'})
        self.leave()
        info = self.cache.sweep(SCOPE)
        self.assertEqual((info['snapshotCount'], info['legacyCount']), (1, 1))
        self.assertTrue(self.store.get(SCOPE, legacy))
        self.assertTrue(self.store.get(OTHER, foreign))

    def test_shared_blob_retained_until_last_referencing_version_removed(self):
        kept = self.capture({'main.tex': 'shared', 'old.tex': 'old'}, mode=None)
        self.capture({'main.tex': 'shared', 'new.tex': 'new'})
        self.leave()
        self.cache.sweep(SCOPE)
        self.assertEqual(self.store.get(SCOPE, kept)['files'][0]['content'], 'shared')
        self.assertEqual(self.cache.info(SCOPE)['totalBytes'], len(b'sharedold'))
        self.cache.clear(SCOPE, self.cache.info(SCOPE)['cacheRevision'])
        self.assertEqual(self.cache.info(SCOPE)['totalBytes'], 0)

    def test_queue_and_accepted_and_unknown_pins_defer_actual_cleanup(self):
        snapshot = self.capture()
        self.cache.pin(SCOPE, 'queue:q', snapshot, kind='queue')
        self.cache.pin(SCOPE, 'turn:t', snapshot)
        self.cache.accept_turn(SCOPE, 'turn:t', 'thread', 'turn')
        self.cache.pin(SCOPE, 'turn:unknown', snapshot)
        self.cache.uncertain_turn(SCOPE, 'turn:unknown')
        self.leave()
        self.cache.release_queue(SCOPE, 'queue:q')
        self.cache.finish_turn(SCOPE, 'thread', 'turn', 'completed')
        restored = CacheLifecycle(ProjectContextStore(self.store.root), clock=lambda: self.now)
        self.assertEqual(restored.sweep(SCOPE)['snapshotCount'], 1)
        with self.assertRaisesRegex(ProjectContextError, 'unconfirmed'):
            restored.clear(SCOPE, restored.info(SCOPE)['cacheRevision'])

    def test_persistent_original_structure_readonly_and_no_implicit_downgrade(self):
        files = {'main.tex': 'root', '章节/part.tex': 'α\r\n\x1a'}
        snapshot = self.capture(files, 'persistent')
        root = self.store.root / 'mirrors' / SCOPE / snapshot
        self.assertEqual((root / '章节/part.tex').read_bytes(), files['章节/part.tex'].encode('utf-8'))
        with self.assertRaises(PermissionError):
            (root / 'main.tex').write_text('edit')
        self.assertEqual(self.capture(files), snapshot)
        self.leave()
        info = self.cache.sweep(SCOPE)
        self.assertEqual((info['snapshotCount'], info['persistentCount']), (1, 1))
        self.assertEqual(info['folder'], str(root.parent))

    def test_stale_clear_revision_and_current_pin_prevent_deletion(self):
        first = self.capture()
        revision = self.cache.info(SCOPE)['cacheRevision']
        second = self.capture({'main.tex': 'new'})
        with self.assertRaisesRegex(ProjectContextError, 'versions changed'):
            self.cache.clear(SCOPE, revision)
        self.cache.pin(SCOPE, 'queue:one', second, kind='queue')
        with self.assertRaisesRegex(ProjectContextError, 'Queued'):
            self.cache.clear(SCOPE, self.cache.info(SCOPE)['cacheRevision'])
        self.assertTrue(self.store.get(SCOPE, first))

    def test_sweep_preserves_in_progress_upload_reused_blob(self):
        files = {'main.tex': 'shared'}
        self.capture(files)
        upload = self.store.begin(SCOPE, 'main.tex', manifest(files))
        self.assertEqual(self.store.missing_paths(SCOPE, upload), [])
        self.leave()
        self.cache.sweep(SCOPE)
        self.assertGreater(self.cache.info(SCOPE)['totalBytes'], 0)
        new_snapshot = self.store.commit(SCOPE, upload)
        self.assertEqual(self.store.get(SCOPE, new_snapshot)['files'][0]['content'], 'shared')

    def test_explicit_clear_cancels_in_progress_upload_and_removes_its_bytes(self):
        upload = self.store.begin(SCOPE, 'main.tex', manifest({'main.tex': 'unfinished'}), 'on-demand', 'lease')
        self.store.chunk(SCOPE, upload, 'main.tex', 0, 'unfinished')
        self.assertGreater(self.cache.info(SCOPE)['totalBytes'], 0)
        result = self.cache.clear(SCOPE, self.cache.info(SCOPE)['cacheRevision'])
        self.assertEqual(result['totalBytes'], 0)
        with self.assertRaises(ProjectContextError):
            self.store.commit(SCOPE, upload)

    def test_real_process_death_keeps_staging_visible_and_clear_removes_it(self):
        worker = multiprocessing.get_context('spawn').Process(target=crash_before_mirror_publication, args=(str(self.store.root),))
        worker.start(); worker.join(20)
        if worker.is_alive():
            worker.terminate(); worker.join(5)
            self.fail('Mirror crash fixture timed out')
        self.assertEqual(worker.exitcode, 23)
        restored = CacheLifecycle(ProjectContextStore(self.store.root))
        directories = restored._mirror_directories(SCOPE)
        self.assertTrue(any(path.name.startswith('.new-') for path in directories))
        self.assertGreater(restored.info(SCOPE)['totalBytes'], len(b'crash source'))
        result = restored.clear(SCOPE, restored.info(SCOPE)['cacheRevision'])
        self.assertEqual((result['snapshotCount'], result['totalBytes']), (0, 0))
        self.assertEqual(restored._mirror_directories(SCOPE), [])

    def test_restart_after_manifest_unlink_recovers_orphan_source(self):
        self.capture()
        self.leave()
        with mock.patch.object(self.cache, '_prune_unreferenced_blobs', side_effect=OSError('simulated process death')):
            with self.assertRaises(OSError):
                self.cache.sweep(SCOPE)
        restored = CacheLifecycle(ProjectContextStore(self.store.root), clock=lambda: self.now)
        info = restored.info(SCOPE)
        self.assertEqual(info['snapshotCount'], 0)
        self.assertGreater(info['totalBytes'], 0)
        self.assertEqual(restored.sweep(SCOPE)['totalBytes'], 0)

    def test_missing_pinned_manifest_does_not_authorize_orphan_blob_deletion(self):
        snapshot = self.capture()
        self.cache.pin(SCOPE, 'unknown', snapshot)
        self.cache.uncertain_turn(SCOPE, 'unknown')
        (self.store.snapshots / (snapshot + '.json')).unlink()
        self.leave()
        self.assertGreater(self.cache.sweep(SCOPE)['totalBytes'], 0)

    @unittest.skipUnless(IS_WINDOWS, 'Windows disk naming rules')
    def test_unrepresentable_windows_paths_rejected_before_publication(self):
        cases = [{'NUL.tex': 'x'}, {'aux': 'x'}, {'part .tex.': 'x'},
                 {'Main.tex': 'x', 'main.tex': 'y'}, {'A/x.tex': 'x', 'a/y.tex': 'y'},
                 {'ı.tex': 'x', 'I.tex': 'y'}, {'main.tex': 'x', 'main.tex/x.tex': 'y'}]
        for files in cases:
            with self.subTest(files=files), self.assertRaises(ProjectContextError):
                self.capture(files, 'persistent')
        self.assertEqual(self.cache.info(SCOPE)['snapshotCount'], 0)

    def test_changed_retained_mirror_is_never_overwritten(self):
        files = {'main.tex': 'original'}
        snapshot = self.capture(files, 'persistent')
        path = self.store.root / 'mirrors' / SCOPE / snapshot / 'main.tex'
        private_permissions(path, 0o600)
        path.write_text('edited', encoding='utf-8')
        with self.assertRaisesRegex(ProjectContextError, 'not overwritten'):
            self.capture(files, 'persistent')
        self.assertEqual(path.read_text(encoding='utf-8'), 'edited')


class NativeCacheAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.host = host.NativeHost(io.BytesIO(), store=host.SessionStore(Path(self.tmp.name).resolve()))
        self.scope = self.host.store.key(self.request())
        self.cache = self.host.cache
        self.cache.acquire_page(self.scope, 'browser', 'doc', 'lease')
        files = {'main.tex': 'synthetic'}
        upload = self.host.project_context.begin(self.scope, 'main.tex', manifest(files), 'on-demand', 'lease')
        self.host.project_context.chunk(self.scope, upload, 'main.tex', 0, 'synthetic')
        self.snapshot = self.host.project_context.commit(self.scope, upload)

    def tearDown(self):
        self.host.close()
        self.tmp.cleanup()

    def request(self, **fields):
        return dict(version=1, id='request', op='ask', projectId='0' * 24, accountId='1' * 24,
                    question='read synthetic', **fields)

    def test_prepare_then_dispatch_unknown_then_ack_terminal_real_durable_pin(self):
        request = host.validate_request(self.request(snapshotId=self.snapshot))
        self.host.prepare_project_context(request)
        self.assertEqual(self.cache.info(self.scope)['pinCount'], 1)
        self.host._source_dispatched(request)
        self.host._source_rejected(request)
        self.assertEqual(self.cache.info(self.scope)['pinCount'], 1)
        self.host._source_accepted(request, 'thread', 'turn')
        self.host._source_terminal(request, 'thread', 'wrong', 'completed')
        self.assertEqual(self.cache.info(self.scope)['pinCount'], 1)
        self.host._source_terminal(request, 'thread', 'turn', 'completed')
        self.assertEqual(self.cache.info(self.scope)['pinCount'], 0)

    def test_cleanup_failure_does_not_hide_confirmed_answer(self):
        request = host.validate_request(self.request(snapshotId=self.snapshot))
        self.host.prepare_project_context(request)
        self.host._source_accepted(request, 'thread', 'turn')
        with mock.patch.object(self.cache, 'sweep', side_effect=ProjectContextError('bad cache')):
            self.host._source_terminal(request, 'thread', 'turn', 'completed')
        self.assertEqual(self.cache.info(self.scope)['pinCount'], 0)

    def test_native_cache_protocol_requires_complete_and_exact_fields(self):
        base = dict(version=1, id='request', projectId='0' * 24, accountId='1' * 24)
        good = dict(base, op='source-page-reconcile', browserId='browser', documents=['doc'], inventoryComplete=True)
        self.assertEqual(host.validate_request(good)['documents'], ['doc'])
        for invalid in [dict(good, inventoryComplete=False), dict(good, documents='doc'), dict(good, snapshotId=self.snapshot)]:
            with self.assertRaises(host.HostError):
                host.validate_request(invalid)

    def wire_server(self, server, failure=None, reader=True):
        original = server.request
        def request(method, params, timeout=None):
            if method == 'mcpServerStatus/list':
                names = ['list_project_files', 'search_project', 'read_project_file'] if reader else []
                return {'data': [{'name': 'overleaf_project', 'tools': {name: {'name': name} for name in names}}]}
            if method in ('turn/start', 'turn/steer'):
                self.assertIn('uncertain', {pin['state'] for pin in self.cache.pins(self.scope).values()})
                if failure:
                    raise failure
            return original(method, params, timeout)
        server.request = request
        self.host.server_factory = lambda cwd, **kwargs: server

    def test_real_worker_codex_submission_pins_before_rpc_and_releases_on_terminal(self):
        self.wire_server(FakeServer(Path(self.tmp.name).resolve()))
        events = Messages()
        with mock.patch.object(host, 'write_message', events.add):
            self.host.handle(self.request(snapshotId=self.snapshot))
            done = events.wait('done', 'request', timeout=5)
        self.assertEqual(done['text'], 'First answer.')
        self.assertEqual(self.cache.info(self.scope)['pinCount'], 0)

    def test_real_worker_lost_rpc_ack_retains_unknown_pin(self):
        self.wire_server(FakeServer(Path(self.tmp.name).resolve()), failure=host.HostError('transport disconnected'))
        events = Messages()
        with mock.patch.object(host, 'write_message', events.add):
            self.host.handle(self.request(snapshotId=self.snapshot))
            events.wait('error', 'request', timeout=5)
        pins = list(self.cache.pins(self.scope).values())
        self.assertEqual(len(pins), 1)
        self.assertEqual((pins[0]['state'], pins[0]['thread']), ('uncertain', None))

    def test_real_worker_reader_rejection_releases_only_unsubmitted_pin(self):
        server = FakeServer(Path(self.tmp.name).resolve())
        self.wire_server(server, reader=False)
        events = Messages()
        with mock.patch.object(host, 'write_message', events.add):
            self.host.handle(self.request(snapshotId=self.snapshot))
            events.wait('error', 'request', timeout=5)
        self.assertEqual(self.cache.info(self.scope)['pinCount'], 0)
        self.assertNotIn('turn/start', [method for method, _params in server.calls])

    def test_steer_pins_its_exact_version_until_original_turn_terminal(self):
        server = SteerServer(Path(self.tmp.name).resolve())
        self.wire_server(server)
        events = Messages()
        with mock.patch.object(host, 'write_message', events.add):
            self.host.handle(self.request(snapshotId=self.snapshot))
            started = events.wait('started', 'request', timeout=5)
            upload = self.host.project_context.begin(self.scope, 'main.tex', manifest({'main.tex': 'steered'}), 'on-demand', 'lease')
            self.host.project_context.chunk(self.scope, upload, 'main.tex', 0, 'steered')
            second = self.host.project_context.commit(self.scope, upload)
            request = self.request(snapshotId=second)
            request.update(id='steer', op='steer', expectedConversationId=started['threadId'], expectedTurnId=started['turnId'])
            self.host.handle(request)
            events.wait('steered', 'steer', timeout=5)
            self.assertEqual(self.cache.info(self.scope)['pinCount'], 2)
            self.assertEqual({pin['turn'] for pin in self.cache.pins(self.scope).values()}, {started['turnId']})
            server.complete()
            events.wait('done', 'request', timeout=5)
        self.assertEqual(self.cache.info(self.scope)['pinCount'], 0)

    def test_api_worker_binds_actual_database_turn_before_any_source_tool_loop(self):
        profile = self.host.profiles.save({'name': 'Synthetic', 'baseUrl': 'http://127.0.0.1:43124/v1', 'model': 'test', 'apiKey': ''})
        connection = mock.Mock()
        def stream(messages, on_delta, tools):
            pins = list(self.cache.pins(self.scope).values())
            self.assertEqual(len(pins), 1)
            self.assertEqual(pins[0]['state'], 'accepted')
            self.assertEqual(pins[0]['turn'], self.host.active_turn)
            on_delta('Synthetic API answer')
            return {'role': 'assistant', 'content': 'Synthetic API answer', 'tool_calls': []}
        connection.stream.side_effect = stream
        self.host.api_backend.connection_factory = lambda *args: connection
        events = Messages()
        with mock.patch.object(host, 'write_message', events.add):
            self.host.handle(self.request(snapshotId=self.snapshot, providerId=profile['id']))
            done = events.wait('done', 'request', timeout=5)
        self.assertEqual(done['text'], 'Synthetic API answer')
        self.assertEqual(self.cache.info(self.scope)['pinCount'], 0)
        connection.close.assert_called()

    def test_desktop_owner_route_pins_admission_and_releases_confirmed_turn(self):
        from test_desktop_handoff import FakeIPC
        from test_codex_sync import World
        from test_codex_host import THREAD
        world = World(); world.turns = []; world.owner = 'desktop'
        ipc = FakeIPC(world)
        self.host.server_factory = world.server
        self.host.desktop_factory = lambda: ipc
        self.host.store.write(self.request(), THREAD)
        original = ipc.start_turn
        def start(*args, **kwargs):
            self.assertEqual(next(iter(self.cache.pins(self.scope).values()))['state'], 'uncertain')
            return original(*args, **kwargs)
        ipc.start_turn = start
        events = Messages()
        with mock.patch.object(host, 'write_message', events.add), mock.patch.object(self.host, 'verify_desktop_reader_startup'):
            self.host.handle(self.request(snapshotId=self.snapshot))
            events.wait('done', 'request', timeout=5)
        self.assertEqual(self.cache.info(self.scope)['pinCount'], 0)
        self.assertTrue(any(name == 'start' for name, _args in ipc.calls))


if __name__ == '__main__':
    unittest.main()
