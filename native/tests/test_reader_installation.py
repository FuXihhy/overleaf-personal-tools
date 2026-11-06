"""Scoped MCP registration and conservative Desktop upgrade checks, all synthetic."""
import json
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from platform_test_support import assert_private, make_symlink, private_permissions
from unittest import mock

from test_codex_host import host, installer, request, THREAD, TURN


class ReaderInstallationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name).resolve()
        self.script = self.directory / 'manuscript_mcp.py'
        self.script.write_text('# synthetic reader\n')
        self.marker = self.directory / installer.READER_MARKER
        self.executable = '/synthetic/codex'

    def tearDown(self):
        self.temp.cleanup()

    def registration(self, command=None, args=None, **extra):
        return SimpleNamespace(returncode=0, stdout=json.dumps(dict({
            'transport': {'command': command or installer.PYTHON,
                          'args': args if args is not None else [str(self.script)]},
            'enabled': True,
        }, **extra)))

    def record(self, timestamp=100):
        self.marker.write_text(json.dumps({'version': 1, 'registeredAt': timestamp, 'script': str(self.script)}))

    def test_matching_registration_keeps_original_timestamp_on_repeat_install(self):
        with mock.patch.object(installer.subprocess, 'run', return_value=self.registration()) as run:
            with mock.patch.object(installer.time, 'time', return_value=100):
                installer.configure_reader_mcp(self.directory, self.executable)
            first = self.marker.read_bytes()
            with mock.patch.object(installer.time, 'time', return_value=200):
                installer.configure_reader_mcp(self.directory, self.executable)
        self.assertEqual(self.marker.read_bytes(), first)
        self.assertEqual(json.loads(first)['registeredAt'], 100)
        assert_private(self, self.marker, 0o600)
        self.assertEqual([call.args[0][1:3] for call in run.call_args_list], [['mcp', 'get'], ['mcp', 'get']])

    def test_new_registration_replaces_stale_gate_timestamp(self):
        self.record(10)
        with mock.patch.object(installer.subprocess, 'run', side_effect=[SimpleNamespace(returncode=1), SimpleNamespace(returncode=0)]) as run:
            with mock.patch.object(installer.time, 'time', return_value=200):
                installer.configure_reader_mcp(self.directory, self.executable)
        self.assertEqual(json.loads(self.marker.read_text())['registeredAt'], 200)
        self.assertEqual(run.call_args_list[-1].args[0], [self.executable, 'mcp', 'add', 'overleaf_project', '--', installer.PYTHON, str(self.script)])

    def test_permission_dependency_update_also_requires_reader_restart(self):
        dependency = self.directory / 'platform_utils.py'
        dependency.write_text('# synthetic ACL implementation v1\n')
        with mock.patch.object(installer.subprocess, 'run', return_value=self.registration()):
            with mock.patch.object(installer.time, 'time', return_value=100):
                installer.configure_reader_mcp(self.directory, self.executable)
            first = json.loads(self.marker.read_text())
            dependency.write_text('# synthetic ACL implementation v2\n')
            with mock.patch.object(installer.time, 'time', return_value=200):
                installer.configure_reader_mcp(self.directory, self.executable)
            second = json.loads(self.marker.read_text())
        self.assertNotEqual(first['readerDigest'], second['readerDigest'])
        self.assertEqual(second['registeredAt'], 200)

    def test_changed_reader_or_snapshot_decoder_advances_restart_gate_only_once(self):
        decoder = self.directory / 'project_context.py'
        decoder.write_text('# synthetic v1 decoder\n')
        with mock.patch.object(installer.subprocess, 'run', return_value=self.registration()):
            with mock.patch.object(installer.time, 'time', return_value=100):
                installer.configure_reader_mcp(self.directory, self.executable)
            first = json.loads(self.marker.read_text())
            decoder.write_text('# synthetic v1 and v2 decoder\n')
            with mock.patch.object(installer.time, 'time', return_value=200):
                installer.configure_reader_mcp(self.directory, self.executable)
            changed = json.loads(self.marker.read_text())
            self.assertEqual(changed['registeredAt'], 200)
            self.assertNotEqual(changed['readerDigest'], first['readerDigest'])
            # Unrelated host-only upgrades must not repeatedly require restart.
            (self.directory / 'codex_host.py').write_text('# unrelated change\n')
            with mock.patch.object(installer.time, 'time', return_value=300):
                installer.configure_reader_mcp(self.directory, self.executable)
            self.assertEqual(json.loads(self.marker.read_text()), changed)
            self.script.write_text('# updated reader\n')
            with mock.patch.object(installer.time, 'time', return_value=400):
                installer.configure_reader_mcp(self.directory, self.executable)
            self.assertEqual(json.loads(self.marker.read_text())['registeredAt'], 400)

    def test_legacy_marker_without_reader_digest_gets_one_upgrade_gate(self):
        self.record(10)
        with mock.patch.object(installer.subprocess, 'run', return_value=self.registration()):
            with mock.patch.object(installer.time, 'time', return_value=200):
                installer.configure_reader_mcp(self.directory, self.executable)
            updated = json.loads(self.marker.read_text())
            self.assertEqual(updated['registeredAt'], 200)
            self.assertRegex(updated['readerDigest'], r'^[a-f0-9]{64}$')

    def test_wrong_same_name_and_disabled_registration_are_not_changed(self):
        self.record()
        original = self.marker.read_bytes()
        for registration in [self.registration(args=['/another/reader.py']),
                             self.registration(command='/another/python'), self.registration(enabled=False)]:
            with self.subTest(registration=registration.stdout):
                with mock.patch.object(installer.subprocess, 'run', return_value=registration) as run:
                    with self.assertRaises(ValueError):
                        installer.configure_reader_mcp(self.directory, self.executable)
                self.assertEqual(run.call_count, 1)
                self.assertEqual(self.marker.read_bytes(), original)

    def test_failed_registration_does_not_create_a_startup_marker(self):
        with mock.patch.object(installer.subprocess, 'run', side_effect=[SimpleNamespace(returncode=1), SimpleNamespace(returncode=1)]):
            with self.assertRaisesRegex(ValueError, 'Could not register'):
                installer.configure_reader_mcp(self.directory, self.executable)
        self.assertFalse(self.marker.exists())

    def test_unregister_removes_only_exact_owned_command_and_arguments(self):
        with mock.patch.object(installer.subprocess, 'run', side_effect=[self.registration(), SimpleNamespace(returncode=0)]) as run:
            installer.unregister_reader_mcp(self.directory, self.executable)
        self.assertEqual(run.call_args_list[-1].args[0], [self.executable, 'mcp', 'remove', 'overleaf_project'])
        for registration in [self.registration(args=['/another/reader.py']),
                             self.registration(command='/another/python'), SimpleNamespace(returncode=1)]:
            with mock.patch.object(installer.subprocess, 'run', return_value=registration) as run:
                installer.unregister_reader_mcp(self.directory, self.executable)
            self.assertEqual(run.call_count, 1)

    def test_unregister_failure_is_reported_before_host_removal(self):
        with mock.patch.object(installer.subprocess, 'run', side_effect=[self.registration(), SimpleNamespace(returncode=1)]):
            with self.assertRaisesRegex(ValueError, 'Could not remove'):
                installer.unregister_reader_mcp(self.directory, self.executable)
        self.assertTrue(self.script.exists())


class DesktopReaderStartupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name).resolve()
        self.marker = self.directory / '.reader-registration.json'
        self.marker.write_text(json.dumps({'version': 1, 'registeredAt': 100,
                                          'script': str(self.directory / 'manuscript_mcp.py')}))
        self.file_patch = mock.patch.object(host, '__file__', str(self.directory / 'codex_host.py'))
        self.file_patch.start()
        self.time_patch = mock.patch.object(host.time, 'time', return_value=200)
        self.time_patch.start()
        self.native = host.NativeHost.__new__(host.NativeHost)
        self.native.steer_lock = threading.RLock()
        self.native.state_lock = threading.Lock()
        self.native.cancelled = threading.Event()
        self.native.closed = threading.Event()
        self.native.store = mock.Mock()
        self.native.store.key.return_value = 'a' * 64
        self.ipc = mock.Mock()
        self.ipc.peer_started_at = 50
        self.ipc.path.lstat.return_value = SimpleNamespace(st_birthtime=50, st_mtime=150, st_ctime=150)
        self.server = SimpleNamespace(desktop_reader_configured=True, request=mock.Mock(return_value={'data': [{
            'name': 'overleaf_project', 'tools': {name: {'name': name} for name in
                ['list_project_files', 'search_project', 'read_project_file']}}]}))

    def tearDown(self):
        self.time_patch.stop(); self.file_patch.stop(); self.temp.cleanup()

    def test_old_socket_cannot_become_fresh_through_new_metadata_timestamps(self):
        with self.assertRaisesRegex(host.HostError, 'Restart Codex Desktop once'):
            self.native.verify_desktop_reader_startup(self.server, self.ipc)
        self.server.request.assert_not_called()

    def test_fresh_socket_still_requires_independent_reader_to_be_available(self):
        self.ipc.peer_started_at = 150
        self.ipc.path.lstat.return_value = SimpleNamespace(st_birthtime=150)
        self.native.verify_desktop_reader_startup(self.server, self.ipc)
        self.assertEqual(self.server.request.call_args.args[0], 'mcpServerStatus/list')
        self.server.request.return_value = {'data': []}
        with self.assertRaisesRegex(host.HostError, 'reader is not connected'):
            self.native.verify_desktop_reader_startup(self.server, self.ipc)

    def test_missing_untrusted_or_unknown_marker_and_socket_fail_closed(self):
        original = self.marker.read_text()
        for content in ['invalid', '{}', '{"registeredAt":300}',
                        json.dumps({'version': 2, 'registeredAt': 100, 'script': str(self.directory / 'manuscript_mcp.py')}),
                        json.dumps({'version': 1, 'registeredAt': 100, 'script': '/other/reader.py'})]:
            self.marker.write_text(content)
            self.ipc.peer_started_at = 150
            self.ipc.path.lstat.return_value = SimpleNamespace(st_birthtime=150)
            with self.subTest(content=content), self.assertRaises(host.HostError):
                self.native.verify_desktop_reader_startup(self.server, self.ipc)
        self.marker.write_text(original)
        self.ipc.peer_started_at = None
        self.ipc.path.lstat.return_value = SimpleNamespace(st_mtime=150, st_ctime=150)
        with self.assertRaises(host.HostError):
            self.native.verify_desktop_reader_startup(self.server, self.ipc)
        self.marker.unlink()
        with self.assertRaises(host.HostError):
            self.native.verify_desktop_reader_startup(self.server, self.ipc)

    def test_unregistered_reader_is_rejected_even_for_new_desktop(self):
        self.server.desktop_reader_configured = False
        self.ipc.peer_started_at = 150
        self.ipc.path.lstat.return_value = SimpleNamespace(st_birthtime=150)
        with self.assertRaisesRegex(host.HostError, 'not registered'):
            self.native.verify_desktop_reader_startup(self.server, self.ipc)
        self.server.request.assert_not_called()

    def test_snapshot_start_is_stopped_before_desktop_receives_question(self):
        self.native.desktop_factory = mock.Mock(return_value=self.ipc)
        self.ipc.discover_owner.return_value = True
        with self.assertRaisesRegex(host.HostError, 'Restart Codex Desktop once'):
            self.native._ask_desktop(request(snapshotId='a' * 64), THREAD, self.server, 'Read-only')
        self.ipc.start_turn.assert_not_called()
        self.native.store.record.assert_not_called()
        self.ipc.close.assert_called_once()

    def test_snapshot_steer_uses_same_gate_before_sending_or_recording(self):
        self.native.busy = True
        self.native.active_op = 'ask'
        self.native.active_provider = None
        self.native.active_scope = 'a' * 64
        self.native.active_thread = THREAD
        self.native.active_turn = TURN
        self.native.server = self.server
        self.native.desktop_routed = True
        self.native.desktop = self.ipc
        with self.assertRaisesRegex(host.HostError, 'Restart Codex Desktop once'):
            self.native.steer(request(snapshotId='a' * 64, expectedConversationId=THREAD, expectedTurnId=TURN))
        self.ipc.steer_turn.assert_not_called()
        self.native.store.record.assert_not_called()


if __name__ == '__main__':
    unittest.main()
