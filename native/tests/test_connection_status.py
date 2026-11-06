"""Read-only health recovery must not repeat an inference request."""
import io
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from test_codex_host import host, FakeServer, Messages, request


class ConnectionStatusTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.messages = Messages()
        self.writer = mock.patch.object(host, 'write_message', self.messages.add)
        self.writer.start()
        self.servers = []
        self.effects = []
        self.deadlines = []
        self.reader_result = None
        self.rpc_timeouts = []
        self.after_model_list = None
        def factory(cwd, **kwargs):
            value = FakeServer(cwd)
            original = value.request
            effect = self.effects.pop(0) if self.effects else None
            def call(method, params, timeout=None):
                self.rpc_timeouts.append((method, timeout))
                if effect and method == effect[0]:
                    value.calls.append((method, params))
                    raise effect[1]
                if method == 'mcpServerStatus/list' and self.reader_result is not None:
                    value.calls.append((method, params))
                    return self.reader_result
                result = original(method, params, timeout)
                if method == 'model/list' and self.after_model_list:
                    self.after_model_list()
                return result
            value.request = call
            self.servers.append(value)
            self.deadlines.append(kwargs.get('deadline'))
            return value
        self.native = host.NativeHost(io.BytesIO(), host.SessionStore(Path(self.temp.name).resolve()/'state'), factory)

    def tearDown(self):
        self.native.close()
        self.writer.stop()
        self.temp.cleanup()

    def routing_error(self, method='account/read'):
        return (method, host.AppServerRPCError(method, {'code': -32603, 'message': 'workspace routing discovery timed out'}))

    def status(self):
        self.native.handle({'id': 'status', 'version': 1, 'op': 'status'})
        return self.messages.wait('status', 'status')

    def test_routing_timeout_rebuilds_once_and_returns_fresh_catalogue(self):
        self.effects = [self.routing_error(), None]
        result = self.status()
        self.assertTrue(result['authenticated'])
        self.assertEqual(result['models'][0]['id'], 'test-model')
        self.assertEqual(len(self.servers), 2)
        self.assertTrue(self.servers[0].closed)
        self.assertEqual(self.deadlines[0], self.deadlines[1])
        self.assertFalse(any(m.startswith('thread/') or m.startswith('turn/') for s in self.servers for m, _ in s.calls))

    def test_repeated_routing_failure_is_bounded_and_structured(self):
        self.effects = [self.routing_error(), self.routing_error()]
        result = self.status()
        self.assertEqual(result['errorCode'], 'routing_timeout')
        self.assertTrue(result['retryable'])
        self.assertEqual(result['models'], [])
        self.assertNotIn('-32603', result['message'])
        self.assertIn('-32603', result['diagnostic'])
        self.assertEqual(len(self.servers), 2)

    def test_model_list_failure_revalidates_account_on_new_connection(self):
        self.effects = [self.routing_error('model/list'), None]
        result = self.status()
        self.assertTrue(result['authenticated'])
        self.assertEqual([s.calls[0][0] for s in self.servers], ['account/read', 'account/read'])

    def test_signed_out_is_not_transient_and_never_lists_models(self):
        with mock.patch.object(FakeServer, 'request', return_value={'account': None, 'requiresOpenaiAuth': True}) as rpc:
            result = self.status()
        self.assertFalse(result['authenticated'])
        self.assertEqual(result['errorCode'], 'auth_required')
        self.assertFalse(result['retryable'])
        self.assertEqual(len(self.servers), 1)
        self.assertEqual([c.args[0] for c in rpc.call_args_list], ['account/read'])
        self.assertFalse(result['projectReaderReady'])
        self.assertEqual(result['connectionKind'], 'standalone')

    def test_standalone_reader_check_works_without_desktop_or_any_model_turn(self):
        self.native.desktop_factory = mock.Mock(side_effect=AssertionError('Desktop is closed'))
        result = self.status()
        self.assertTrue(result['available'])
        self.assertTrue(result['authenticated'])
        self.assertTrue(result['projectReaderReady'])
        self.assertEqual(result['connectionKind'], 'standalone')
        self.assertIn('No model request was run', result['message'])
        self.native.desktop_factory.assert_not_called()
        self.assertEqual([method for method, _ in self.servers[0].calls],
                         ['account/read', 'model/list', 'mcpServerStatus/list'])
        self.assertEqual(self.servers[0].calls[-1][1],
                         {'serverName': 'overleaf_project', 'detail': 'toolsAndAuthOnly'})

    def test_missing_or_partial_or_failed_reader_preserves_auth_and_models(self):
        cases = [[], [{'name': 'overleaf_project', 'tools': {'one': {'name': 'read_project_file'}}}],
                 [{'name': 'overleaf_project', 'toolsError': 'startup failed', 'tools': {name: {'name': name}
                   for name in ('list_project_files', 'search_project', 'read_project_file')}}]]
        for index, data in enumerate(cases):
            with self.subTest(data=data):
                self.reader_result = {'data': data}
                self.native.status({'id': 'reader-' + str(index)})
                result = self.messages.wait('status', 'reader-' + str(index))
                self.assertTrue(result['available']); self.assertTrue(result['authenticated'])
                self.assertEqual(result['models'][0]['id'], 'test-model')
                self.assertFalse(result['projectReaderReady'])
                self.assertIn('reader', result['readerError'])

    def test_reader_rpc_failure_is_redacted_and_does_not_repeat_check(self):
        self.effects = [('mcpServerStatus/list', host.HostError('Reader failed: bearer private-token sk-private-secret'))]
        result = self.status()
        self.assertTrue(result['available']); self.assertTrue(result['authenticated'])
        self.assertFalse(result['projectReaderReady'])
        self.assertEqual(result['models'][0]['id'], 'test-model')
        self.assertNotIn('private-token', str(result)); self.assertNotIn('sk-private-secret', str(result))
        self.assertEqual(len(self.servers), 1)

    def test_reader_uses_only_the_remaining_shared_status_budget(self):
        clock = [100.0]
        self.after_model_list = lambda: clock.__setitem__(0, 135.75)
        with mock.patch.object(host.time, 'monotonic', side_effect=lambda: clock[0]):
            self.native.status({'id': 'budget'})
        result = self.messages.wait('status', 'budget')
        self.assertTrue(result['projectReaderReady'])
        self.assertEqual(self.rpc_timeouts[-1], ('mcpServerStatus/list', .25))
        self.assertEqual(self.deadlines, [136.0])

    def test_budget_exhausted_after_models_keeps_evidence_without_starting_reader(self):
        clock = [100.0]
        self.after_model_list = lambda: clock.__setitem__(0, 136.1)
        with mock.patch.object(host.time, 'monotonic', side_effect=lambda: clock[0]):
            self.native.status({'id': 'expired-reader'})
        result = self.messages.wait('status', 'expired-reader')
        self.assertTrue(result['available']); self.assertTrue(result['authenticated'])
        self.assertEqual(result['models'][0]['id'], 'test-model')
        self.assertFalse(result['projectReaderReady']); self.assertIn('timed out', result['readerError'])
        self.assertEqual([method for method, _ in self.servers[0].calls], ['account/read', 'model/list'])

    def test_permanent_failure_does_not_loop_or_leak_bearer(self):
        self.effects = [('account/read', host.HostError('Authorization failed: bearer private-token'))]
        result = self.status()
        self.assertFalse(result['retryable'])
        self.assertEqual(len(self.servers), 1)
        self.assertNotIn('private-token', str(result))

    def test_expired_budget_prevents_another_process(self):
        self.effects = [self.routing_error()]
        with mock.patch.object(host, 'STATUS_TIMEOUT', 0):
            result = self.status()
        self.assertEqual(len(self.servers), 1)
        self.assertEqual(result['errorCode'], 'disconnected')
        self.assertEqual(self.servers[0].calls, [])

    def test_ask_is_not_automatically_repeated(self):
        self.effects = [self.routing_error(), None]
        self.native.handle(request())
        self.messages.wait('error')
        self.assertEqual(len(self.servers), 1)
        self.assertFalse(any(m.startswith('turn/') for m, _ in self.servers[0].calls))


if __name__ == '__main__':
    unittest.main()
