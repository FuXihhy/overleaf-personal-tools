"""Real storage lifecycle tests using only synthetic manuscript sources."""
import hashlib
import multiprocessing
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cache_lifecycle
from cache_lifecycle import CacheLifecycle
from project_context import ProjectContextError, ProjectContextStore

SCOPE = hashlib.sha256(b'account/project').hexdigest()
OTHER = hashlib.sha256(b'other-account/project').hexdigest()


def publish(store, text='synthetic source', scope=SCOPE):
    raw = text.encode('utf-8')
    upload = store.begin(scope, 'main.tex', [{'path': 'main.tex', 'bytes': len(raw),
                                           'sha256': hashlib.sha256(raw).hexdigest()}])
    store.chunk(scope, upload, 'main.tex', 0, text)
    return store.commit(scope, upload)


def acquire_in_process(root, suffix, start, result):
    try:
        store = ProjectContextStore(Path(root))
        lifecycle = CacheLifecycle(store)
        start.wait(10)
        lifecycle.acquire_page(SCOPE, 'browser-' + suffix, 'document-' + suffix, 'token-' + suffix)
        result.put(('ok', suffix))
    except Exception as error:
        result.put(('error', str(error)))


class CacheLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve() / 'source'
        self.store = ProjectContextStore(self.root)
        self.now = 1000
        self.cache = CacheLifecycle(self.store, clock=lambda: self.now)
        self.snapshot = publish(self.store)
        self.cache.manage_snapshot(SCOPE, self.snapshot, 'on-demand', newly_created=True)

    def tearDown(self):
        self.temporary.cleanup()

    def page(self, suffix='1', browser='browser'):
        self.cache.acquire_page(SCOPE, browser, 'doc-' + suffix, 'token-' + suffix)

    def leave(self, suffix='1', browser='browser'):
        return self.cache.release_page(SCOPE, browser, 'doc-' + suffix, 'token-' + suffix,
                                       confirmed_departure=True)

    def exited(self):
        self.page(); self.leave(); self.now += 31

    def candidates(self):
        return self.cache.inspect_cleanup(SCOPE)['candidates']

    def test_one_of_two_pages_cannot_make_cache_eligible(self):
        self.page(); self.page('2'); self.leave(); self.now += 1000
        self.assertEqual(self.cache.inspect_cleanup(SCOPE)['page_count'], 1)
        self.assertEqual(self.candidates(), [])
        self.assertEqual(self.store.get(SCOPE, self.snapshot)['files'][0]['content'], 'synthetic source')

    def test_last_confirmed_departure_waits_for_grace(self):
        self.page(); self.leave()
        self.now += 29
        self.assertEqual(self.candidates(), [])
        self.now += 1
        self.assertEqual(self.candidates(), [self.snapshot])
        self.assertTrue(self.cache.inspect_cleanup(SCOPE)['deletion_enabled'])
        self.assertTrue((self.store.snapshots / (self.snapshot + '.json')).exists())

    def test_no_observed_page_is_not_evidence_all_pages_left(self):
        self.now += 100000
        self.assertEqual(self.candidates(), [])

    def test_reload_and_delayed_release_cannot_retire_replacement(self):
        self.page(); self.leave(); self.page('replacement')
        self.assertFalse(self.leave())
        self.now += 100000
        self.assertEqual(self.candidates(), [])
        with self.assertRaisesRegex(ProjectContextError, 'departed'):
            self.page()

    def test_reacquire_cancels_existing_cleanup_pending(self):
        self.exited()
        self.assertEqual(self.candidates(), [self.snapshot])
        self.page('new')
        state = self.cache.inspect_cleanup(SCOPE)
        self.assertIsNone(state['empty_since'])
        self.assertEqual(state['candidates'], [])

    def test_worker_disconnect_and_missing_heartbeat_never_retire_page(self):
        self.page()
        self.assertFalse(self.cache.release_page(SCOPE, 'browser', 'doc-1', 'token-1'))
        self.now += 365 * 24 * 3600
        self.assertEqual(self.cache.reconcile_browser(SCOPE, 'browser', []), 0)
        self.assertEqual(self.candidates(), [])

    def test_complete_inventory_retires_only_that_browser_missing_documents(self):
        self.page(); self.page('2'); self.page('other', browser='other-browser')
        self.assertEqual(self.cache.reconcile_browser(SCOPE, 'browser', ['doc-2'], inventory_complete=True), 1)
        self.assertEqual(self.cache.inspect_cleanup(SCOPE)['page_count'], 2)
        self.assertEqual(self.cache.reconcile_browser(SCOPE, 'browser', [], inventory_complete=True), 1)
        self.now += 1000
        self.assertEqual(self.candidates(), [])
        self.leave('other', browser='other-browser'); self.now += 31
        self.assertEqual(self.candidates(), [self.snapshot])

    def test_account_scope_and_page_identity_are_checked(self):
        self.page()
        self.assertFalse(self.cache.release_page(OTHER, 'browser', 'doc-1', 'token-1', confirmed_departure=True))
        self.assertFalse(self.cache.release_page(SCOPE, 'wrong-browser', 'doc-1', 'token-1', confirmed_departure=True))
        self.assertFalse(self.cache.release_page(SCOPE, 'browser', 'old-document', 'token-1', confirmed_departure=True))
        self.assertEqual(self.cache.inspect_cleanup(SCOPE)['page_count'], 1)

    def test_acquisition_is_idempotent_but_tokens_cannot_change_identity(self):
        self.page(); self.page()
        self.assertEqual(self.cache.inspect_cleanup(SCOPE)['page_count'], 1)
        with self.assertRaises(ProjectContextError):
            self.cache.acquire_page(SCOPE, 'other', 'doc-1', 'token-1')
        self.cache.acquire_page(SCOPE, 'browser', 'doc-1', 'different-token', 'token-1')
        self.assertEqual(self.cache.inspect_cleanup(SCOPE)['page_count'], 1)
        self.assertFalse(self.leave())
        with self.assertRaises(ProjectContextError):
            self.page()

    def test_bfcache_replacement_fences_a_predecessor_never_acquired_on_disk(self):
        self.cache.acquire_page(SCOPE, 'browser', 'doc', 'new', 'old')
        with self.assertRaisesRegex(ProjectContextError, 'departed'):
            self.cache.acquire_page(SCOPE, 'browser', 'doc', 'old')
        self.assertFalse(self.cache.release_page(SCOPE, 'browser', 'doc', 'old', confirmed_departure=True))
        self.assertEqual(self.cache.inspect_cleanup(SCOPE)['page_count'], 1)
        with self.assertRaisesRegex(ProjectContextError, 'different page generation'):
            self.cache.acquire_page(SCOPE, 'browser', 'doc', 'unknown')

    def test_provisional_pin_blocks_cleanup_before_rpc_is_sent(self):
        self.cache.pin(SCOPE, 'request-1', self.snapshot)
        self.exited()
        self.assertEqual(self.candidates(), [])
        self.assertTrue(self.cache.reject_before_submission(SCOPE, 'request-1'))
        self.assertEqual(self.candidates(), [self.snapshot])

    def test_lost_admission_ack_survives_process_restart_and_cannot_be_rejected(self):
        self.cache.pin(SCOPE, 'request-1', self.snapshot)
        self.cache.uncertain_turn(SCOPE, 'request-1')
        self.exited()
        self.cache = CacheLifecycle(ProjectContextStore(self.root), clock=lambda: self.now)
        self.assertEqual(self.candidates(), [])
        self.assertFalse(self.cache.reject_before_submission(SCOPE, 'request-1'))
        self.assertFalse(self.cache.confirm_terminal(SCOPE, 'request-1', 'thread', 'turn', 'completed'))

    def test_accepted_reply_requires_matching_terminal_confirmation(self):
        self.cache.pin(SCOPE, 'request-1', self.snapshot)
        self.cache.accept_turn(SCOPE, 'request-1', 'thread', 'turn')
        self.exited()
        for thread, turn, status in [('thread', 'turn', 'cancel-requested'),
                                      ('thread', 'other-turn', 'completed'),
                                      ('other-thread', 'turn', 'completed')]:
            self.assertFalse(self.cache.confirm_terminal(SCOPE, 'request-1', thread, turn, status))
            self.assertEqual(self.candidates(), [])
        self.cache.uncertain_turn(SCOPE, 'request-1')
        self.assertTrue(self.cache.confirm_terminal(SCOPE, 'request-1', 'thread', 'turn', 'interrupted'))
        self.assertEqual(self.candidates(), [self.snapshot])

    def test_turn_identity_cannot_be_rebound(self):
        self.cache.pin(SCOPE, 'request-1', self.snapshot)
        self.cache.accept_turn(SCOPE, 'request-1', 'thread', 'turn')
        self.cache.accept_turn(SCOPE, 'request-1', 'thread', 'turn')
        with self.assertRaises(ProjectContextError):
            self.cache.accept_turn(SCOPE, 'request-1', 'thread', 'another-turn')

    def test_steering_protects_multiple_immutable_versions_until_same_turn_finishes(self):
        second = publish(self.store, 'second version')
        self.cache.manage_snapshot(SCOPE, second, 'on-demand', newly_created=True)
        self.cache.pin(SCOPE, 'request-1', self.snapshot)
        self.cache.accept_turn(SCOPE, 'request-1', 'thread', 'turn')
        self.cache.pin(SCOPE, 'request-1', second)
        self.exited()
        self.assertEqual(self.candidates(), [])
        self.assertEqual(self.cache.inspect_cleanup(SCOPE)['protected'], sorted([self.snapshot, second]))
        self.cache.confirm_terminal(SCOPE, 'request-1', 'thread', 'turn', 'completed')
        self.assertEqual(self.candidates(), sorted([self.snapshot, second]))

    def test_only_exact_accepted_version_is_pinned(self):
        unused = publish(self.store, 'unused revision')
        self.cache.manage_snapshot(SCOPE, unused, 'on-demand', newly_created=True)
        self.cache.pin(SCOPE, 'request-1', self.snapshot)
        self.exited()
        self.assertEqual(self.candidates(), [unused])

    def test_restorable_queue_pins_are_independent_of_turns(self):
        self.cache.pin(SCOPE, 'queue-1', self.snapshot, kind='queue')
        self.exited()
        self.assertFalse(self.cache.reject_before_submission(SCOPE, 'queue-1'))
        self.assertFalse(self.cache.confirm_terminal(SCOPE, 'queue-1', 'thread', 'turn', 'completed'))
        self.assertEqual(self.candidates(), [])
        self.assertTrue(self.cache.release_queue(SCOPE, 'queue-1'))
        self.assertEqual(self.candidates(), [self.snapshot])

    def test_legacy_snapshots_are_not_silently_migrated_by_new_default(self):
        old = publish(self.store, 'old source')
        self.cache.manage_snapshot(SCOPE, old, 'on-demand')
        self.cache.manage_snapshot(SCOPE, old, 'on-demand', newly_created=True)
        self.exited()
        self.assertEqual(self.cache.inspect_cleanup(SCOPE)['retention'][old], 'legacy')
        self.assertEqual(self.candidates(), [self.snapshot])

    def test_persistent_retention_never_downgrades_from_setting_change(self):
        self.cache.manage_snapshot(SCOPE, self.snapshot, 'persistent')
        self.cache.manage_snapshot(SCOPE, self.snapshot, 'on-demand', newly_created=True)
        self.exited()
        self.assertEqual(self.candidates(), [])
        self.assertEqual(self.cache.inspect_cleanup(SCOPE)['retention'][self.snapshot], 'persistent')

    def test_mac_mirror_rejects_case_and_unicode_aliases_before_source_publication(self):
        # Different leaf names used to hide a parent-directory alias: the first
        # capture succeeded on APFS, then the next capture reported user edits.
        pairs = [
            ('Chapter/a.tex', 'chapter/b.tex'),
            ('Caf\u00e9/a.tex', 'Cafe\u0301/b.tex'),
            ('Equation.tex', 'equation.tex'),
            ('caf\u00e9.tex', 'cafe\u0301.tex'),
            ('Chapter', 'chapter/child.tex'),
        ]
        self.page()
        before = self.cache.info(SCOPE)
        with mock.patch.object(cache_lifecycle, 'IS_WINDOWS', False), mock.patch.object(cache_lifecycle.sys, 'platform', 'darwin'):
            for pair in pairs:
                for paths in (pair, tuple(reversed(pair))):
                    with self.subTest(paths=paths):
                        files = {'main.tex': 'synthetic root', paths[0]: 'first source', paths[1]: 'second source'}
                        manifest = [{'path': path, 'bytes': len(content.encode('utf-8')),
                                     'sha256': hashlib.sha256(content.encode('utf-8')).hexdigest()}
                                    for path, content in files.items()]
                        with self.assertRaisesRegex(ProjectContextError, 'local mirror'):
                            self.store.begin(SCOPE, 'main.tex', manifest, 'persistent', 'token-1')
        self.assertEqual(self.cache.info(SCOPE), before)
        self.assertEqual(list(self.store.uploads.iterdir()), [])
        self.assertFalse((self.root / 'mirrors').exists())

    def test_mac_noncolliding_unicode_mirror_can_be_synchronized_again(self):
        self.page()
        files = {'main.tex': 'synthetic root', 'Caf\u00e9/\u7ae0\u8282.tex': 'exact \u03b1\r\n\x1a source',
                 'Caf\u00e9/other.tex': 'another file in the same directory'}
        manifest = [{'path': path, 'bytes': len(content.encode('utf-8')),
                     'sha256': hashlib.sha256(content.encode('utf-8')).hexdigest()}
                    for path, content in files.items()]
        with mock.patch.object(cache_lifecycle, 'IS_WINDOWS', False), mock.patch.object(cache_lifecycle.sys, 'platform', 'darwin'):
            upload = self.store.begin(SCOPE, 'main.tex', manifest, 'persistent', 'token-1')
            for path, content in files.items():
                self.store.chunk(SCOPE, upload, path, 0, content)
            snapshot = self.store.commit(SCOPE, upload)
            self.cache.manage_snapshot(SCOPE, snapshot, 'persistent')
            # Repeating a real capture must reuse the same immutable version.
            repeated = self.store.begin(SCOPE, 'main.tex', manifest, 'persistent', 'token-1')
            self.assertEqual(self.store.missing_paths(SCOPE, repeated), [])
            self.assertEqual(self.store.commit(SCOPE, repeated), snapshot)
        mirror = self.root / 'mirrors' / SCOPE / snapshot
        self.assertEqual({path.relative_to(mirror).as_posix(): path.read_bytes()
                          for path in mirror.rglob('*') if path.is_file()},
                         {path: content.encode('utf-8') for path, content in files.items()})

    def test_normal_mode_cannot_register_full_project_source(self):
        with self.assertRaisesRegex(ProjectContextError, 'Normal context'):
            self.cache.manage_snapshot(SCOPE, self.snapshot, 'normal')

    def test_snapshot_scope_and_integrity_verified_before_registration_and_pin(self):
        foreign = publish(self.store, 'foreign', OTHER)
        with self.assertRaises(ProjectContextError):
            self.cache.manage_snapshot(SCOPE, foreign, 'on-demand', newly_created=True)
        with self.assertRaises(ProjectContextError):
            self.cache.pin(SCOPE, 'request-1', foreign)
        with self.assertRaises(ProjectContextError):
            self.cache.pin(SCOPE, 'request-1', '0' * 64)

    def test_missing_source_during_reply_never_releases_its_durable_pin(self):
        self.cache.pin(SCOPE, 'request-1', self.snapshot)
        self.cache.accept_turn(SCOPE, 'request-1', 'thread', 'turn')
        self.exited()
        (self.store.snapshots / (self.snapshot + '.json')).unlink()
        with self.assertRaises(ProjectContextError):
            self.cache.pin(SCOPE, 'another-request', self.snapshot)
        restored = CacheLifecycle(ProjectContextStore(self.root), clock=lambda: self.now)
        state = restored.inspect_cleanup(SCOPE)
        self.assertEqual(state['protected'], [self.snapshot])
        self.assertEqual(state['pin_count'], 1)
        self.assertEqual(state['candidates'], [])

    def test_corrupt_metadata_fails_closed_and_does_not_overwrite_or_delete_sources(self):
        self.page()
        self.cache.path.write_bytes(b'{corrupt')
        before = self.cache.path.read_bytes()
        for operation in (self.candidates, lambda: self.page('2')):
            with self.assertRaises(ProjectContextError):
                operation()
        self.assertEqual(self.cache.path.read_bytes(), before)
        self.assertTrue(self.store.get(SCOPE, self.snapshot))

    def test_invalid_metadata_shape_fails_closed(self):
        self.page()
        self.cache.path.write_text('{"version":1,"scopes":{"' + SCOPE + '":{}}}', encoding='utf-8')
        with self.assertRaisesRegex(ProjectContextError, 'cleanup is blocked'):
            self.candidates()

    def test_backward_clock_defers_cleanup(self):
        self.page(); self.leave(); self.now -= 1000
        self.assertEqual(self.candidates(), [])

    def test_real_separate_processes_preserve_all_page_leases(self):
        spawn = multiprocessing.get_context('spawn')
        start, result = spawn.Event(), spawn.Queue()
        workers = [spawn.Process(target=acquire_in_process, args=(str(self.root), str(i), start, result)) for i in range(3)]
        try:
            for worker in workers:
                worker.start()
            start.set()
            outcomes = [result.get(timeout=30) for _ in workers]
            for worker in workers:
                worker.join(10)
                self.assertEqual(worker.exitcode, 0)
            self.assertEqual([item[0] for item in outcomes], ['ok', 'ok', 'ok'], outcomes)
            self.assertEqual(self.cache.inspect_cleanup(SCOPE)['page_count'], 3)
        finally:
            for worker in workers:
                if worker.is_alive():
                    worker.terminate(); worker.join(5)
            result.close()


if __name__ == '__main__':
    unittest.main()
