"""Strict active-turn steering and fresh-login tests without model inference."""
import io
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock
from test_codex_host import host, request, FakeServer, Messages, THREAD, assert_additional_context_contract
from test_codex_history import history


class SteerServer(FakeServer):
    def __init__(self, cwd):
        super().__init__(cwd, finish=False)
        self.steer_error = None
        self.steer_turn = None
    def request(self, method, params, timeout=None):
        if method == 'turn/steer':
            assert_additional_context_contract(params)
            self.calls.append((method, params))
            if self.steer_error:
                raise host.HostError(self.steer_error)
            return {'turnId': self.steer_turn or self.current_turn}
        return super().request(method, params, timeout)


class SteeringTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.messages = Messages()
        self.patch = mock.patch.object(host, 'write_message', self.messages.add); self.patch.start()
        self.servers = []
        def server(cwd, **kwargs):
            result = SteerServer(cwd); self.servers.append(result); return result
        self.store = host.SessionStore(Path(self.temp.name).resolve() / 'state')
        self.native = host.NativeHost(io.BytesIO(), self.store, server)
    def tearDown(self):
        self.native.close(); self.patch.stop(); self.temp.cleanup()
    def start(self):
        self.native.handle(request())
        started = self.messages.wait('started')
        self.assertTrue(started['canSteer']); self.assertEqual(started['turnId'], self.servers[-1].current_turn)
        return started
    def steer(self, started, **values):
        self.native.handle(request(id='steer-1', op='steer', expectedConversationId=started['threadId'],
                                   expectedTurnId=started['turnId'], **values))
    def test_two_steers_append_distinct_messages_and_preserve_initial_context(self):
        started = self.start(); server = self.servers[-1]
        self.steer(started, question='Use chirality.', answerQuote={'text': 'Earlier explanation'})
        first = self.messages.wait('steered', 'steer-1')
        self.native.handle(request(id='steer-2', op='steer', expectedConversationId=THREAD,
                                   expectedTurnId=started['turnId'], question='Also explain the signs.'))
        second = self.messages.wait('steered', 'steer-2')
        self.assertNotEqual(first['userMessageId'], second['userMessageId'])
        calls = [params for method, params in server.calls if method == 'turn/steer']
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0]['expectedTurnId'], started['turnId'])
        self.assertEqual(calls[0]['input'][0]['text'], 'Use chirality.')
        context = next(iter(calls[0]['additionalContext'].values()))
        self.assertEqual(context['kind'], 'untrusted')
        self.assertIn('Some definitions.', context['value'])
        self.assertIn('Earlier explanation', context['value'])
        self.assertNotEqual(calls[0]['clientUserMessageId'], calls[1]['clientUserMessageId'])
        self.assertFalse(any(method == 'turn/interrupt' for method, _ in server.calls))
        self.assertEqual(sum(method == 'turn/start' for method, _ in server.calls), 1)
        server.complete(); self.messages.wait('done')
        users = [m for m in self.store.page(request())['messages'] if m['role'] == 'user']
        self.assertEqual([m['text'] for m in users], [request()['question'], 'Use chirality.', 'Also explain the signs.'])
        self.assertEqual([m['messageId'] for m in users[1:]], [first['userMessageId'], second['userMessageId']])
    def test_wrong_turn_account_project_or_source_cannot_steer(self):
        started = self.start(); server = self.servers[-1]
        for i,fields in enumerate([{'expectedTurnId':'stale-turn'}, {'accountId':'another-account'},
                                   {'projectId':'fedcba987654321001234567'}, {'providerId':THREAD}]):
            values = dict(id='bad-'+str(i), op='steer', expectedConversationId=THREAD, expectedTurnId=started['turnId'])
            values.update(fields); self.native.handle(request(**values))
            self.messages.wait('error', values['id'])
        self.assertFalse(any(method == 'turn/steer' for method, _ in server.calls))
    def test_finished_or_uncertain_steer_never_restarts_replays_or_replaces_answer(self):
        started = self.start(); server = self.servers[-1]
        server.steer_error = 'no active turn to steer'
        self.steer(started); self.assertIn('not automatically queued',self.messages.wait('error','steer-1')['message'])
        server.steer_error = 'Codex did not respond to turn/steer in time.'
        self.native.handle(request(id='uncertain', op='steer', expectedConversationId=THREAD, expectedTurnId=started['turnId']))
        self.assertIn('may already have been received',self.messages.wait('error','uncertain')['message'])
        self.assertEqual(sum(method == 'turn/steer' for method,_ in server.calls),2)
        self.assertEqual(sum(method == 'turn/start' for method,_ in server.calls),1)
        self.assertFalse(any(method == 'turn/interrupt' for method,_ in server.calls))
        self.assertEqual(len(self.store.page(request())['messages']),1)
    def test_closed_desktop_route_does_not_accidentally_steer_independent_reader(self):
        started = self.start();self.native.desktop_routed = True
        self.steer(started)
        self.assertIn('reply connection has ended',self.messages.wait('error','steer-1')['message'])
        self.assertFalse(any(method=='turn/steer' for method,_ in self.servers[-1].calls))
        self.native.desktop_routed = False
    def test_pending_steer_does_not_block_cancel_acknowledgement(self):
        started = self.start(); server = self.servers[-1]
        entered, release = threading.Event(), threading.Event()
        original = server.request
        def delayed(method, params, timeout=None):
            if method == 'turn/steer':
                entered.set()
                if not release.wait(2): raise host.HostError('synthetic timed out')
            return original(method, params, timeout)
        server.request = delayed
        self.steer(started)
        self.assertTrue(entered.wait(1))
        self.native.handle({'version':1,'id':'cancel','op':'cancel'})
        self.assertTrue(self.messages.wait('done','cancel')['cancelled'])
        release.set();self.messages.wait('steered','steer-1');self.messages.wait('done')

    def test_check_connection_always_uses_current_login_process(self):
        for i in range(2):
            self.native.handle({'version':1,'id':'status-'+str(i),'op':'status'})
            self.messages.wait('status','status-'+str(i))
        self.assertEqual(len(self.servers),2)
        self.assertTrue(self.servers[0].closed)
    def test_steer_requires_identity_and_does_not_accept_turn_override_on_ask(self):
        for fields in ({'op':'steer'}, {'op':'steer','expectedConversationId':THREAD},
                       {'op':'steer','expectedConversationId':THREAD,'expectedTurnId':'bad/id'},
                       {'expectedTurnId':'turn'}):
            with self.assertRaises(host.HostError): host.validate_request(request(**fields))

if __name__ == '__main__':unittest.main()
