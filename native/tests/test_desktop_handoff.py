"""Owner handoff integration, with fake Desktop IPC and durable history only."""
import copy
import io
import json
from pathlib import Path
import queue
import tempfile
import threading
import unittest
from unittest import mock

from test_codex_host import host, request, Messages, THREAD, TURN, assert_additional_context_contract
from test_codex_history import history
from test_codex_sync import World, turn


class FakeIPC:
    def __init__(self, world):
        self.world = world
        self.events = queue.Queue()
        self.calls = []
        self.closed = False
        self.owner = True
        self.finished = True
        self.fail_start = None
        self.bad_result = False
        self.on_settings = None
        self.on_follow = None
        self.steered_turn = None
        self.settings = {'model': 'test-desktop-model', 'reasoningEffort': 'high'}
        self.entered_start = threading.Event()
        self.release_start = threading.Event()
        self.block_start = False

    def discover_owner(self, identifier):
        self.calls.append(('discover', identifier))
        return {'clientId': 'desktop-owner', 'supportsUntrustedAppInput': True} if self.owner else None

    def read_model_settings(self):
        self.calls.append(('settings', None))
        if self.on_settings:
            self.on_settings()
        return self.settings

    def follow(self):
        self.calls.append(('follow', None))
        if self.on_follow:
            self.on_follow()

    def start_turn(self, params, context=None):
        assert_additional_context_contract(params)
        self.calls.append(('start', (copy.deepcopy(params), copy.deepcopy(context))))
        self.entered_start.set()
        if self.block_start:
            if not self.release_start.wait(3):
                raise AssertionError('Test did not release fake Desktop request')
            if self.closed:
                raise host.DesktopIPCError('transport closed', outcome_unknown=True)
        if self.fail_start:
            raise self.fail_start
        if self.bad_result:
            return {}
        self.world.turns.append(turn(TURN, params['input'][0]['text'], 'Desktop-owned answer.',
                                     'completed' if self.finished else 'inProgress', timestamp=200))
        return {'turn': {'id': TURN}}

    def steer_turn(self, params, restore_message):
        assert_additional_context_contract(params)
        self.calls.append(('steer', (copy.deepcopy(params), copy.deepcopy(restore_message))))
        identifier = self.steered_turn or TURN
        target = next(t for t in self.world.turns if t['id'] == identifier)
        target['items'].insert(-1, {'type':'userMessage', 'clientId':params['clientUserMessageId'], 'content':params['input']})
        return {'turnId': identifier}

    def interrupt(self, identifier):
        self.calls.append(('interrupt', identifier))
        for value in self.world.turns:
            if value['id'] == identifier:
                value['status'] = 'interrupted'
                value['completedAt'] = 202
        # Wake the worker without waiting for the persisted-history poll period.
        self.events.put({'type': 'snapshot', 'revision': 1, 'conversationState': {
            'id': THREAD, 'turns': [{'turnId': identifier, 'status': 'interrupted', 'items': []}]}})

    def close(self):
        self.closed = True
        self.release_start.set()
        self.calls.append(('close', None))


class DesktopHandoffTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.messages = Messages()
        self.patch = mock.patch.object(host, 'write_message', self.messages.add)
        self.patch.start()
        self.world = World()
        self.world.turns = [turn('desktop-existing', 'Existing question', 'Existing answer')]
        self.world.owner = 'desktop'
        self.ipc = FakeIPC(self.world)
        self.factory = mock.Mock(return_value=self.ipc)
        self.store = host.SessionStore(Path(self.temp.name).resolve() / 'state')
        self.store.write(request(), THREAD)
        self.native = host.NativeHost(io.BytesIO(), self.store, self.server, desktop_factory=self.factory)
        self.native.handle(history(id='initial'))
        self.revision = self.messages.wait('history', 'initial')['syncRevision']

    def server(self, cwd, **kwargs):
        server = self.world.server(cwd)
        server.disabled_plugins = ['example@test']
        return server

    def tearDown(self):
        self.native.close()
        self.patch.stop()
        self.temp.cleanup()

    def ask(self, **fields):
        self.native.handle(request(expectedConversationId=THREAD, expectedSyncRevision=self.revision, **fields))

    def methods(self):
        return [method for server in self.world.instances for method, _ in server.calls]

    def assert_owner_retained(self):
        self.assertEqual(self.world.owner, 'desktop')
        self.assertEqual(self.store.read(request()), THREAD)
        self.assertEqual(self.methods().count('thread/resume'), 1)
        self.assertNotIn('thread/start', self.methods())
        self.assertNotIn('turn/start', self.methods())
        self.assertNotIn('turn/interrupt', self.methods())

    def after_first_receive_iteration(self):
        """Return a checkpoint reached only if the first iteration kept waiting."""
        original_get = self.ipc.events.get
        processed = threading.Event()
        calls = []

        def checked_get(*args, **kwargs):
            calls.append(True)
            if len(calls) >= 2:
                processed.set()
            return original_get(*args, **kwargs)

        self.ipc.events.get = checked_get
        return processed

    def misleading_observer_status(self, status='interrupted'):
        """Mimic a separate app-server misclassifying Desktop's live turn."""
        original_poll = self.native._desktop_turn

        def checked_poll(*args, **kwargs):
            value = original_poll(*args, **kwargs)
            if value and value.get('status') == 'inProgress':
                value['status'] = status
            return value

        self.native._desktop_turn = checked_poll

    def owner_snapshot(self, status, revision=1, text=None, runtime=None):
        items = [] if text is None else [{'type': 'agentMessage', 'phase': 'final_answer', 'text': text}]
        state = {'id': THREAD, 'turns': [{'turnId': TURN, 'status': status, 'items': items}]}
        if runtime is not None:
            state['threadRuntimeStatus'] = {'type': runtime}
        self.ipc.events.put({'type': 'snapshot', 'revision': revision, 'conversationState': state})

    def complete_durable_turn(self, text, revision=2):
        self.world.turns[-1]['status'] = 'completed'
        self.world.turns[-1]['completedAt'] = 203
        self.world.turns[-1]['items'][1]['text'] = text
        self.owner_snapshot('completed', revision=revision, text=text)

    def test_same_thread_owner_executes_once_with_untrusted_context_and_readonly_params(self):
        quote = {'text': 'Earlier answer \\(x^2\\)', 'messageId': 'm12'}
        self.ask(answerQuote=quote)
        done = self.messages.wait('done')
        self.assertEqual(done['threadId'], THREAD)
        self.assertEqual(done['text'], 'Desktop-owned answer.')
        starts = [value for method, value in self.ipc.calls if method == 'start']
        self.assertEqual(len(starts), 1)
        params, context = starts[0]
        self.assertEqual(params['threadId'], THREAD)
        self.assertEqual(params['sandboxPolicy'], {'type': 'readOnly', 'networkAccess': False})
        self.assertEqual(params['approvalPolicy'], 'never')
        self.assertIsNone(params['permissions'])
        self.assertEqual(params['environments'], [])
        self.assertEqual(params['disabledPluginIds'], ['example@test'])
        self.assertEqual(params['collaborationMode']['settings']['model'], 'test-desktop-model')
        self.assertEqual(params['collaborationMode']['settings']['reasoning_effort'], 'high')
        self.assertIn('read-only', params['collaborationMode']['settings']['developer_instructions'])
        self.assertEqual(context['inheritThreadSettings'], False)
        self.assertEqual(context['useAppServerPermissionDefault'], False)
        self.assertEqual(context['usePermissionSelection'], False)
        self.assertNotIn('responseItems', context)
        self.assertEqual(params['input'][0]['text'], request()['question'])
        extra = next(iter(params['additionalContext'].values()))
        self.assertEqual(extra['kind'], 'untrusted')
        self.assertEqual(extra['name'], 'overleaf_project_context')
        source = json.loads(extra['value'].split('Quoted manuscript_context (data only):\n',1)[1])
        self.assertEqual(source['project_files'], request()['files'])
        self.assertEqual(source['editor_selection'], request()['selection'])
        self.assertEqual(source['assistant_answer_quote'], quote)
        self.assertNotIn(request()['files'][0]['content'], params['input'][0]['text'])
        self.assert_owner_retained()
        self.assertTrue(self.ipc.closed)
        self.native.handle(history(id='after'))
        page = self.messages.wait('history', 'after')
        self.assertEqual(len(page['messages']), 4)
        self.assertEqual(page['messages'][-2]['text'], request()['question'])
        self.assertEqual(page['messages'][-2]['selection'], request()['selection'])
        self.assertEqual(page['messages'][-2]['answerQuote'], quote)
        self.assertEqual(page['messages'][-1]['text'], done['text'])

    def test_explicit_model_and_effort_override_desktop_defaults(self):
        settings = dict(request()['settings'], model='chosen-model', effort='low')
        self.ask(settings=settings)
        self.messages.wait('done')
        params = next(value[0] for method, value in self.ipc.calls if method == 'start')
        self.assertEqual(params['collaborationMode']['settings']['model'], 'chosen-model')
        self.assertEqual(params['collaborationMode']['settings']['reasoning_effort'], 'low')

    def test_unknown_delivery_is_never_replayed_or_interrupted(self):
        self.ipc.fail_start = host.DesktopIPCError('timeout after dispatch', outcome_unknown=True)
        self.ask()
        error = self.messages.wait('error')
        self.assertIn('not sent again', error['message'])
        self.assertEqual(sum(method == 'start' for method, _ in self.ipc.calls), 1)
        self.assertFalse(any(method == 'interrupt' for method, _ in self.ipc.calls))
        self.assertFalse(any(value['type'] == 'started' for value in self.messages.values))
        self.assert_owner_retained()

    def test_missing_turn_confirmation_fails_closed_without_recording_an_answer(self):
        self.ipc.bad_result = True
        self.ask()
        self.assertIn('not sent again', self.messages.wait('error')['message'])
        self.assertEqual(len(self.store.page(request())['messages']), 2)
        self.assertFalse(any(method == 'interrupt' for method, _ in self.ipc.calls))
        self.assert_owner_retained()

    def test_revision_is_checked_again_after_owner_discovery(self):
        self.ipc.on_settings = lambda: self.world.turns.append(turn('raced', 'Another desktop question', 'Answer', timestamp=20))
        self.ask()
        self.assertIn('New messages arrived', self.messages.wait('error')['message'])
        self.assertFalse(any(method == 'start' for method, _ in self.ipc.calls))
        self.assert_owner_retained()

    def test_unavailable_or_unsupported_desktop_does_not_steal_writer(self):
        self.factory.side_effect = host.DesktopIPCError('Desktop protocol unsupported')
        self.ask()
        self.assertIn('Could not connect', self.messages.wait('error')['message'])
        self.assert_owner_retained()
        self.assertIsNone(self.native.server)

    def test_desktop_steer_appends_two_messages_without_replacing_original(self):
        self.ipc.finished = False; self.ask()
        started = self.messages.wait('started')
        self.assertTrue(started['canSteer']); self.assertEqual(started['turnId'], TURN)
        acknowledgements = []
        for i in range(2):
            self.native.handle(request(id='steer-'+str(i), op='steer', expectedConversationId=THREAD,
                                       expectedTurnId=TURN, question='Steer '+str(i)))
            acknowledgements.append(self.messages.wait('steered', 'steer-'+str(i)))
        self.complete_durable_turn('Final steered answer')
        self.messages.wait('done')
        self.native.handle(history(id='after-steer'))
        page = self.messages.wait('history','after-steer')
        users = [m for m in page['messages'] if m['role']=='user']
        self.assertEqual([m['text'] for m in users], ['Existing question', request()['question'], 'Steer 0', 'Steer 1'])
        self.assertEqual([m['messageId'] for m in users[-2:]], [a['userMessageId'] for a in acknowledgements])
        self.assertEqual(sum(method=='start' for method,_ in self.ipc.calls),1)
        self.assertEqual(sum(method=='steer' for method,_ in self.ipc.calls),2)
        self.assertFalse(any(method=='interrupt' for method,_ in self.ipc.calls))

    def test_desktop_steer_acknowledges_newer_active_turn_in_same_chat(self):
        self.ipc.finished = False; self.ask(); self.messages.wait('started')
        self.world.turns.append(turn('new-current-turn', 'Desktop follow-up', 'New draft', 'inProgress', timestamp=250))
        self.ipc.steered_turn = 'new-current-turn'
        self.native.handle(request(id='steer-newer', op='steer', expectedConversationId=THREAD,
                                   expectedTurnId=TURN, question='Guide the current reply'))
        ack = self.messages.wait('steered','steer-newer')
        self.assertEqual(ack['turnId'], 'new-current-turn');self.assertEqual(ack['threadId'], THREAD)
        self.assertEqual(sum(method=='start' for method,_ in self.ipc.calls),1)
        self.assertFalse(any(method=='interrupt' for method,_ in self.ipc.calls))
        params = next(value[0] for method,value in self.ipc.calls if method=='steer')
        self.assertEqual(params['input'][0]['text'], 'Guide the current reply')
        context = next(iter(params['additionalContext'].values()))
        self.assertEqual(context['kind'], 'untrusted')
        self.assertIn(request()['selection']['text'],context['value'])
        self.assertIn(request()['files'][0]['content'],context['value'])

    def test_missing_owner_does_not_send(self):
        self.ipc.owner = False
        self.ask()
        self.assertIn('owner is not available', self.messages.wait('error')['message'])
        self.assertFalse(any(method == 'start' for method, _ in self.ipc.calls))
        self.assertEqual(self.world.owner, 'desktop')
        self.assertEqual(self.store.read(request()), THREAD)
        self.assertEqual(self.methods().count('thread/resume'), 2)
        self.assertNotIn('turn/start', self.methods())

    def test_missing_owner_can_recover_same_thread_after_old_writer_releases(self):
        original = self.ipc.discover_owner
        def discover(identifier):
            original(identifier)
            self.world.owner = None
            return None
        self.ipc.discover_owner = discover
        self.ask()
        done = self.messages.wait('done')
        self.assertEqual(done['threadId'], THREAD)
        self.assertEqual(self.store.read(request()), THREAD)
        self.assertEqual(self.methods().count('thread/resume'), 2)
        self.assertEqual(self.methods().count('turn/start'), 1)
        self.assertNotIn('thread/start', self.methods())
        self.assertFalse(any(method == 'start' for method, _ in self.ipc.calls))

    def test_other_resume_errors_do_not_attempt_desktop_handoff(self):
        original_factory = self.native.server_factory

        def failing_server(cwd):
            server = original_factory(cwd)
            original_request = server.request

            def checked_request(method, params, timeout=None):
                if method == 'thread/resume':
                    server.calls.append((method, params))
                    raise host.HostError('Synthetic invalid configuration')
                return original_request(method, params, timeout)

            server.request = checked_request
            return server

        self.native.server_factory = failing_server
        self.ask()
        self.assertIn('Synthetic invalid configuration', self.messages.wait('error')['message'])
        self.factory.assert_not_called()
        self.assert_owner_retained()

    def test_cancel_waits_for_confirmation_and_interrupts_only_that_turn(self):
        self.ipc.block_start = True
        self.ipc.finished = False
        self.ask()
        self.assertTrue(self.ipc.entered_start.wait(2))
        self.native.handle({'version': 1, 'id': 'cancel', 'op': 'cancel', 'projectId': request()['projectId']})
        self.messages.wait('done', 'cancel')
        self.assertFalse(any(method == 'interrupt' for method, _ in self.ipc.calls))
        self.ipc.release_start.set()
        done = self.messages.wait('done')
        self.assertTrue(done['cancelled'])
        self.assertEqual([value for method, value in self.ipc.calls if method == 'interrupt'], [TURN])
        self.assert_owner_retained()

    def test_page_close_does_not_interrupt_desktop_turn_or_close_its_owner(self):
        self.ipc.block_start = True
        self.ask()
        self.assertTrue(self.ipc.entered_start.wait(2))
        self.native.close()
        self.assertTrue(self.ipc.closed)
        self.assertFalse(any(method == 'interrupt' for method, _ in self.ipc.calls))
        self.assertEqual(sum(method == 'start' for method, _ in self.ipc.calls), 1)
        self.assert_owner_retained()

    def test_page_close_after_confirmation_leaves_desktop_turn_running(self):
        self.ipc.finished = False
        self.ask()
        self.messages.wait('started')
        self.native.close()
        self.assertTrue(self.ipc.closed)
        self.assertFalse(any(method == 'interrupt' for method, _ in self.ipc.calls))
        self.assertEqual(self.world.turns[-1]['status'], 'inProgress')
        self.assert_owner_retained()

    def test_optimistic_interrupted_snapshot_cannot_complete_pending_durable_turn(self):
        self.ipc.finished = False
        self.ipc.events.put({'type': 'snapshot', 'revision': 1, 'conversationState': {
            'id': THREAD, 'turns': [{'turnId': TURN, 'status': 'interrupted', 'items': []}]}})
        original_get = self.ipc.events.get
        processed_snapshot = threading.Event()
        reads = []

        def get_after_prior_iteration(*args, **kwargs):
            reads.append(True)
            if len(reads) >= 2:
                # Reaching another receive proves the preceding snapshot did
                # not finish the turn. Avoid a timing-based negative assertion.
                processed_snapshot.set()
            return original_get(*args, **kwargs)

        self.ipc.events.get = get_after_prior_iteration
        self.ask()
        self.messages.wait('started')
        self.assertTrue(processed_snapshot.wait(2), self.messages.values)
        self.assertFalse(any(value['type'] == 'done' for value in self.messages.values))
        self.assertEqual(self.world.turns[-1]['status'], 'inProgress')
        self.world.turns[-1]['status'] = 'completed'
        self.world.turns[-1]['completedAt'] = 203
        self.world.turns[-1]['items'][1]['text'] = 'Durably completed answer.'
        self.ipc.events.put({'type': 'snapshot', 'revision': 2, 'conversationState': {
            'id': THREAD, 'turns': [{'turnId': TURN, 'status': 'completed', 'items': []}]}})
        done = self.messages.wait('done')
        self.assertEqual(done['text'], 'Durably completed answer.')
        self.assertFalse(done['cancelled'])
        self.assert_owner_retained()

    def test_observer_interrupted_without_owner_snapshot_keeps_waiting(self):
        self.ipc.finished = False
        self.misleading_observer_status()
        processed = self.after_first_receive_iteration()
        self.ask()
        self.messages.wait('started')
        self.assertTrue(processed.wait(2), self.messages.values)
        self.assertFalse(any(value['type'] == 'done' for value in self.messages.values))
        self.complete_durable_turn('Completed after observer misreported interruption.')
        done = self.messages.wait('done')
        self.assertEqual(done['text'], 'Completed after observer misreported interruption.')
        self.assertFalse(done['cancelled'])
        self.assert_owner_retained()

    def test_active_owner_stream_is_not_overwritten_by_observer_interrupted(self):
        self.ipc.finished = False
        self.misleading_observer_status()
        self.owner_snapshot('inProgress', text='Streaming answer.')
        processed = self.after_first_receive_iteration()
        self.ask()
        self.messages.wait('started')
        self.assertTrue(processed.wait(2), self.messages.values)
        self.assertFalse(any(value['type'] == 'done' for value in self.messages.values))
        deltas = [value['text'] for value in self.messages.values if value['type'] == 'delta']
        self.assertEqual(deltas, ['Streaming answer.'])
        self.complete_durable_turn('Streaming answer. Complete.')
        done = self.messages.wait('done')
        self.assertEqual(done['text'], 'Streaming answer. Complete.')
        self.assertFalse(done['cancelled'])
        self.assert_owner_retained()

    def test_owner_interrupted_after_active_finishes_even_when_observer_is_pending(self):
        self.ipc.finished = False
        self.owner_snapshot('inProgress', text='Partial answer.')
        processed = self.after_first_receive_iteration()
        self.ask()
        self.messages.wait('started')
        self.assertTrue(processed.wait(2), self.messages.values)
        self.assertFalse(any(value['type'] == 'done' for value in self.messages.values))
        self.owner_snapshot('interrupted', revision=2, text='Partial answer.')
        done = self.messages.wait('done')
        self.assertTrue(done['cancelled'])
        self.assertEqual(done['text'], 'Partial answer.')
        self.assertEqual(self.world.turns[-1]['status'], 'inProgress')
        self.assertFalse(any(method == 'interrupt' for method, _ in self.ipc.calls))
        self.assert_owner_retained()

    def test_owner_empty_stop_snapshot_preserves_delivered_partial(self):
        self.ipc.finished = False
        self.owner_snapshot('inProgress', text='Partial answer.')
        self.ask()
        self.assertEqual(self.messages.wait('delta')['text'], 'Partial answer.')
        self.native.handle({'version': 1, 'id': 'stop', 'op': 'cancel', 'projectId': request()['projectId']})
        self.messages.wait('done', 'stop')
        done = self.messages.wait('done')
        self.assertTrue(done['cancelled'])
        self.assertEqual(done['text'], 'Partial answer.')
        self.assertEqual(self.store.page(request())['messages'][-1]['text'], 'Partial answer.')
        self.assertEqual([value for method, value in self.ipc.calls if method == 'interrupt'], [TURN])
        self.assert_owner_retained()

    def test_durable_completion_wins_over_empty_owner_stop_snapshot(self):
        self.ipc.finished = False
        self.owner_snapshot('inProgress', text='A longer unfinished answer.')
        self.ask()
        self.messages.wait('delta')
        self.world.turns[-1]['status'] = 'completed'
        self.world.turns[-1]['items'][1]['text'] = 'Final.'
        self.owner_snapshot('interrupted', revision=2)
        done = self.messages.wait('done')
        self.assertFalse(done['cancelled'])
        self.assertEqual(done['text'], 'Final.')
        self.assertEqual(self.store.page(request())['messages'][-1]['text'], 'Final.')
        self.assert_owner_retained()

    def test_owner_empty_active_snapshot_does_not_erase_stop_fallback(self):
        self.ipc.finished = False
        self.owner_snapshot('inProgress', text='Delivered partial.')
        self.ask()
        self.messages.wait('delta')
        self.owner_snapshot('inProgress', revision=2)
        self.owner_snapshot('interrupted', revision=3)
        done = self.messages.wait('done')
        self.assertTrue(done['cancelled'])
        self.assertEqual(done['text'], 'Delivered partial.')
        self.assertEqual(self.store.page(request())['messages'][-1]['text'], 'Delivered partial.')
        self.assert_owner_retained()

    def test_durable_empty_completion_does_not_retain_streamed_draft(self):
        self.ipc.finished = False
        self.owner_snapshot('inProgress', text='Discarded draft.')
        self.ask()
        self.messages.wait('delta')
        self.world.turns[-1]['status'] = 'completed'
        self.world.turns[-1]['items'][1]['text'] = ''
        self.owner_snapshot('interrupted', revision=2)
        done = self.messages.wait('done')
        self.assertFalse(done['cancelled'])
        self.assertEqual(done['text'], '')
        with self.store.database(request()) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM messages WHERE conversation=? AND id=?',
                                         (THREAD, TURN + ':assistant:0')).fetchone()[0], 0)
        self.assert_owner_retained()

    def test_owner_answer_limit_stops_only_the_confirmed_turn_once(self):
        self.ipc.finished = False
        self.owner_snapshot('inProgress', text='x' * 450001)
        self.ask()
        self.assertIn('response limit', self.messages.wait('error')['message'])
        self.assertEqual([value for method, value in self.ipc.calls if method == 'interrupt'], [TURN])
        self.assertEqual(sum(method == 'start' for method, _ in self.ipc.calls), 1)
        self.assertEqual(self.world.turns[-1]['status'], 'interrupted')
        self.assert_owner_retained()

    def test_fast_owner_stop_requires_fresh_explicit_idle_snapshot(self):
        self.ipc.finished = False
        self.owner_snapshot('interrupted', text='Stopped before streaming.')
        def fresh_after_probe():
            if sum(method == 'follow' for method, _ in self.ipc.calls) == 2:
                self.owner_snapshot('interrupted', revision=2, text='Stopped before streaming.', runtime='idle')
        self.ipc.on_follow = fresh_after_probe
        self.ask()
        done = self.messages.wait('done')
        self.assertTrue(done['cancelled'])
        self.assertEqual(done['text'], 'Stopped before streaming.')
        self.assertEqual(sum(method == 'follow' for method, _ in self.ipc.calls), 2)
        self.assertFalse(any(method == 'interrupt' for method, _ in self.ipc.calls))
        self.assertEqual(sum(method == 'start' for method, _ in self.ipc.calls), 1)
        self.assert_owner_retained()

    def test_fresh_interrupted_placeholder_with_active_runtime_keeps_waiting(self):
        self.ipc.finished = False
        self.owner_snapshot('interrupted', runtime='idle')
        processed = threading.Event()
        original_get = self.ipc.events.get
        reads = []
        def receive(*args, **kwargs):
            reads.append(True)
            if len(reads) >= 3:
                processed.set()
            return original_get(*args, **kwargs)
        self.ipc.events.get = receive
        def fresh_after_probe():
            if sum(method == 'follow' for method, _ in self.ipc.calls) == 2:
                self.owner_snapshot('interrupted', revision=2, runtime='active')
        self.ipc.on_follow = fresh_after_probe
        self.ask()
        self.messages.wait('started')
        self.assertTrue(processed.wait(2), self.messages.values)
        self.assertFalse(any(value['type'] == 'done' for value in self.messages.values))
        self.complete_durable_turn('Completed after placeholder.', revision=3)
        self.assertFalse(self.messages.wait('done')['cancelled'])
        self.assertFalse(any(method == 'interrupt' for method, _ in self.ipc.calls))
        self.assert_owner_retained()

    def test_unknown_owner_stop_confirmation_is_bounded_and_not_replayed(self):
        self.ipc.finished = False
        self.owner_snapshot('interrupted')
        def fresh_after_probe():
            if sum(method == 'follow' for method, _ in self.ipc.calls) == 2:
                self.owner_snapshot('interrupted', revision=2)
        self.ipc.on_follow = fresh_after_probe
        with mock.patch.object(host, 'DESKTOP_INTERRUPT_CONFIRM_TIMEOUT', 0.1):
            self.ask()
            error = self.messages.wait('error')
        self.assertIn('not confirmed whether this reply stopped', error['message'])
        self.assertFalse(any(value['type'] == 'done' for value in self.messages.values))
        self.assertFalse(any(method == 'interrupt' for method, _ in self.ipc.calls))
        self.assertEqual(sum(method == 'start' for method, _ in self.ipc.calls), 1)
        self.assert_owner_retained()

    def test_durable_failed_turn_ends_without_owner_snapshot(self):
        self.ipc.finished = False
        self.misleading_observer_status('failed')
        self.ask()
        self.assertIn('could not complete', self.messages.wait('error')['message'])
        self.assertFalse(any(value['type'] == 'done' for value in self.messages.values))
        self.assertFalse(any(method == 'interrupt' for method, _ in self.ipc.calls))
        self.assert_owner_retained()

    def test_connection_loss_after_admission_is_not_replayed_or_interrupted(self):
        self.ipc.finished = False
        self.ipc.events.put({'type': 'connection-error'})
        self.ask()
        error = self.messages.wait('error')
        self.assertIn('will not be sent again', error['message'])
        self.assertEqual(sum(method == 'start' for method, _ in self.ipc.calls), 1)
        self.assertFalse(any(method == 'interrupt' for method, _ in self.ipc.calls))
        self.assert_owner_retained()


if __name__ == '__main__':
    unittest.main()
