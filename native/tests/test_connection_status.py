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
        def factory(cwd, **kwargs):
            value = FakeServer(cwd)
            original = value.request
            effect = self.effects.pop(0) if self.effects else None
            def call(method, params, timeout=None):
                if effect and method == effect[0]:
                    value.calls.append((method, params))
                    raise effect[1]
                return original(method, params, timeout)
            value.request = call
            self.servers.append(value)
            self.deadlines.append(kwargs.get('deadline'))
            return value
        self.native = host.NativeHost(io.BytesIO(), host.SessionStore(Path(self.temp.name)/'state'), factory)

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
