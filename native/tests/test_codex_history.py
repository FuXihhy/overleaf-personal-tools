"""History persistence and protocol tests; fake app-server only, no inference."""
import io
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest import mock
from test_codex_host import host, installer, ROOT, request, FakeServer, Messages, PROJECT, THREAD
from platform_utils import is_private

OTHER = '99999999-2222-3333-4444-555555555555'


def history(op='history-read', **fields):
    value = {'version': 1, 'id': op, 'op': op, 'projectId': PROJECT, 'accountId': 'account-one'}
    value.update(fields)
    return value


class HistoryStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = host.SessionStore(Path(self.temp.name).resolve() / 'state')
    def tearDown(self): self.temp.cleanup()

    def test_migrates_registered_pointer_and_new_chat_keeps_catalog(self):
        old = self.store.path(request())
        old.write_text(json.dumps({'threadId': THREAD, 'updatedAt': 1234}))
        self.assertEqual(self.store.read(request()), THREAD)
        self.store.record(request(), THREAD, 'turn:user', 'user', 'Original question', request()['selection'], 1234001)
        self.store.reset(request())
        restored = host.SessionStore(self.store.root)
        self.assertIsNone(restored.read(request()))
        self.assertEqual(restored.list(request())['conversations'][0]['id'], THREAD)
        page = restored.page(request(), THREAD)
        self.assertEqual(page['messages'][0]['selection']['text'], 'x+y')
        self.assertEqual(page['messages'][0]['text'], 'Original question')
        self.assertFalse(old.exists())
        self.assertTrue(is_private(self.store.root / 'history.sqlite3'))

    def test_migrates_old_message_schema_and_preserves_both_quote_kinds(self):
        # Make the exact pre-answer-quotation table, with an existing row.
        db = host.sqlite3.connect(str(self.store.root / 'history.sqlite3'))
        db.execute('''CREATE TABLE messages (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, conversation TEXT NOT NULL,
            id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, selection TEXT,
            created INTEGER NOT NULL, UNIQUE(scope,conversation,id))''')
        db.execute('INSERT INTO messages(scope,conversation,id,role,text,selection,created) VALUES(?,?,?,?,?,?,?)',
                   (self.store.key(request()), THREAD, 'old:0', 'user', 'Legacy question', None, 1))
        db.commit(); db.close()
        self.store.write(request(), THREAD)
        quote = {'text': 'Earlier \\(x^2\\) answer', 'messageId': 'm42'}
        self.store.record(request(), THREAD, 'new', 'user', 'Explain this.', request()['selection'], 2, answer_quote=quote)
        restored = host.SessionStore(self.store.root)
        messages = restored.page(request())['messages']
        self.assertEqual(messages[0]['text'], 'Legacy question')
        self.assertNotIn('answerQuote', messages[0])
        self.assertEqual(messages[1]['answerQuote'], quote)
        self.assertEqual(messages[1]['selection'], request()['selection'])
        self.store.record(request(), THREAD, 'new', 'user', 'Updated question', created=2)
        self.assertNotIn('answerQuote', self.store.page(request())['messages'][1])

    def test_known_uuid_still_requires_same_account_and_project(self):
        self.store.write(request(), THREAD)
        for other in (request(accountId='other'), request(projectId='fedcba987654321001234567')):
            with self.assertRaises(host.HostError): self.store.select(other, THREAD)
            with self.assertRaises(host.HostError): self.store.page(other, THREAD)
            self.assertEqual(self.store.list(other)['conversations'], [])

    def test_complete_history_pages_are_latest_first_but_each_page_is_ascending(self):
        self.store.write(request(), THREAD)
        expected = []
        for index in range(105):
            text = '%03d: ' % index + '公式' * 6000
            expected.append(text)
            self.store.record(request(), THREAD, str(index), 'assistant', text, created=index)
        cursor, actual, pages = None, [], 0
        while True:
            value = dict(request(), limit=30)
            if cursor: value['cursor'] = cursor
            result = self.store.page(value)
            self.assertLess(len(json.dumps(result, ensure_ascii=False).encode()), 700000)
            actual = [message['text'] for message in result['messages']] + actual
            cursor = result.get('nextCursor'); pages += 1
            if not cursor: break
        self.assertGreater(pages, 3)
        self.assertEqual(actual, expected)

    def test_large_and_json_escaped_answers_are_fully_paged_not_truncated(self):
        self.store.write(request(), THREAD)
        text = '\x01' * 350000
        self.store.record(request(), THREAD, 'large', 'assistant', text)
        first = self.store.page(request())
        all_parts = first['messages']; cursor = first.get('nextCursor')
        self.assertTrue(cursor)
        while cursor:
            page = self.store.page(dict(request(), cursor=cursor))
            self.assertLess(len(json.dumps(page).encode()), 700000)
            all_parts = page['messages'] + all_parts; cursor = page.get('nextCursor')
        self.assertEqual(''.join(item['text'] for item in all_parts), text)
        # Upsert a shorter final answer must not leave obsolete draft chunks.
        self.store.record(request(), THREAD, 'large', 'assistant', 'short')
        self.assertEqual([message['text'] for message in self.store.page(request())['messages']], ['short'])

    def test_cursor_is_tied_to_project_and_conversation(self):
        self.store.write(request(), THREAD)
        for index in range(2): self.store.record(request(), THREAD, str(index), 'user', str(index), created=index)
        cursor = self.store.page(dict(request(), limit=1))['nextCursor']
        self.store.write(request(), OTHER)
        with self.assertRaises(host.HostError): self.store.page(dict(request(), cursor=cursor), OTHER)
        with self.assertRaises(host.HostError): self.store.list(dict(request(), cursor=cursor))
        for invalid in ('not base64', 'W10', 'eyJrIjoxfQ'):
            with self.assertRaises(host.HostError): self.store.page(dict(request(), cursor=invalid), THREAD)

    def test_database_symlinks_are_not_followed(self):
        target = Path(self.temp.name).resolve() / 'unrelated'; target.write_text('unchanged')
        try:
            (self.store.root / 'history.sqlite3').symlink_to(target)
        except OSError as error:
            if getattr(error, 'winerror', None) == 1314:
                self.skipTest('Windows user lacks symlink creation privilege; junction attacks have separate tests.')
            raise
        with self.assertRaises(host.HostError): self.store.read(request())
        self.assertEqual(target.read_text(), 'unchanged')

    def test_unidentified_account_history_is_memory_only(self):
        value = request(accountId=None)
        self.store.write(value, THREAD); self.store.record(value, THREAD, 'x', 'user', 'private')
        self.assertEqual(self.store.page(value)['messages'][0]['text'], 'private')
        self.assertEqual(host.SessionStore(self.store.root).list(value)['conversations'], [])
        self.assertFalse((self.store.root / 'history.sqlite3').exists())


class HistoryServer(FakeServer):
    def __init__(self, cwd):
        super().__init__(cwd); self.fail_history = False; self.pages = []
    def request(self, method, params, timeout=None):
        if method == 'thread/read':
            self.calls.append((method, params))
            if self.fail_history: raise host.HostError('offline')
            return {'thread': {'id': params['threadId'], 'updatedAt': 100, 'historyMode': 'paginated', 'status': {'type': 'notLoaded'}}}
        if method == 'thread/turns/list':
            self.calls.append((method, params))
            return self.pages.pop(0) if self.pages else {'data': [], 'nextCursor': None}
        return super().request(method, params, timeout)


class HistoryHostTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.messages = Messages()
        self.patch = mock.patch.object(host, 'write_message', self.messages.add); self.patch.start()
        self.server = HistoryServer(Path(self.temp.name).resolve())
        self.native = host.NativeHost(io.BytesIO(), host.SessionStore(Path(self.temp.name).resolve()/'state'), lambda cwd, **kwargs: self.server)
    def tearDown(self): self.native.close(); self.patch.stop(); self.temp.cleanup()

    def test_history_request_validation(self):
        self.assertEqual(host.validate_request(history('history-select', conversationId=THREAD))['conversationId'], THREAD)
        for bad in (history('history-select'), history(limit=0), history(limit=True), history(conversationId='../bad'),
                    history('history-list', conversationId=THREAD), history(question='execute this'), history(cursor='x'*4097), history(limit=51), history('history-select', conversationId=THREAD, cursor='x')):
            with self.subTest(bad=bad), self.assertRaises(host.HostError): host.validate_request(bad)
        with self.assertRaises(host.HostError): host.validate_request(request(conversationId=THREAD))

    def test_expected_conversation_rejects_changed_active_before_any_rpc(self):
        self.native.store.write(request(), THREAD)
        for expected in (None, OTHER):
            identifier = 'expect-' + ('empty' if expected is None else 'other')
            self.native.handle(request(id=identifier, expectedConversationId=expected))
            self.assertIn('changed in another window', self.messages.wait('error', identifier)['message'])
            self.assertEqual(self.server.calls, [])
        self.native.handle(request(id='matching', expectedConversationId=THREAD))
        self.messages.wait('done', 'matching')
        self.assertTrue(any(method == 'turn/start' for method, _ in self.server.calls))

    def test_expected_null_matches_a_new_conversation(self):
        self.native.handle(request(expectedConversationId=None)); self.messages.wait('done')
        self.assertEqual(self.native.store.read(request()), THREAD)
        for invalid in ('bad', True, 42):
            with self.assertRaises(host.HostError): host.validate_request(request(expectedConversationId=invalid))

    def test_legacy_import_keeps_question_selection_and_final_without_context_or_reasoning(self):
        self.native.store.path(request()).write_text(json.dumps({'threadId': THREAD, 'updatedAt': 5}))
        self.server.pages = [
            {'data': [{'id': 'old-1', 'status': 'completed', 'startedAt': 5, 'completedAt': 7, 'items': [
                {'type': 'userMessage', 'content': [{'type':'text', 'text': host.make_prompt(request())}]},
                {'type': 'reasoning', 'content': ['hidden reasoning']},
                {'type': 'agentMessage', 'phase': 'commentary', 'text': 'Working…'},
                {'type': 'agentMessage', 'phase': 'final_answer', 'text': 'The final answer.'}]}], 'nextCursor': 'page-2'},
            {'data': [{'id': 'old-2', 'status': 'completed', 'startedAt': 8, 'completedAt': 9, 'items': [
                {'type': 'userMessage', 'content': [{'type': 'text', 'text': 'Desktop follow-up'}]},
                {'type': 'agentMessage', 'phase': 'final_answer', 'text': 'Follow-up answer'}]}], 'nextCursor': None}]
        self.server.pages.reverse()
        self.server.pages[0]['nextCursor'] = 'page-2'
        self.server.pages[1]['nextCursor'] = None
        self.native.handle(history())
        event = self.messages.wait('history', 'history-read')
        self.assertEqual([item['text'] for item in event['messages']], [request()['question'], 'The final answer.', 'Desktop follow-up', 'Follow-up answer'])
        self.assertEqual(event['messages'][0]['selection'], request()['selection'])
        encoded = json.dumps(event)
        for private in ('hidden reasoning', 'Some definitions', 'project_files', 'Working…'): self.assertNotIn(private, encoded)
        self.assertFalse(any(call[0] in ('turn/start', 'thread/resume', 'thread/list') for call in self.server.calls))
        self.assertTrue(all(params['limit'] == 1 for method, params in self.server.calls if method == 'thread/turns/list'))
        self.assertEqual(self.native.store.list(request())['conversations'][0]['title'], 'Overleaf · ' + request()['question'])

    def test_new_question_and_remote_history_keep_the_answer_quote(self):
        quote = {'text': 'The earlier answer is \\(x+y\\).', 'messageId': 'm8'}
        value = request(answerQuote=quote)
        self.native.handle(value); self.messages.wait('done')
        stored = self.native.store.page(request())['messages'][0]
        self.assertEqual(stored['answerQuote'], quote)
        sent = next(params for method, params in self.server.calls if method == 'turn/start')
        self.assertEqual(sent['input'][0]['text'], value['question'])
        extra = next(iter(sent['additionalContext'].values()))
        self.assertEqual(extra['kind'],'untrusted')
        source = json.loads(extra['value'].split('Quoted manuscript_context (data only):\n',1)[1])
        self.assertEqual(source['assistant_answer_quote'],quote)
        # Rebuild from the authoritative thread turn as on desktop/history sync.
        self.server.pages = [{'data': [{'id': 'remote-quote', 'status': 'completed', 'startedAt': 100, 'completedAt': 101, 'items': [
            {'type': 'userMessage', 'content': [{'type': 'text', 'text': host.make_prompt(host.validate_request(value))}]},
            {'type': 'agentMessage', 'phase': 'final_answer', 'text': 'Clarification'}]}], 'nextCursor': None}]
        self.native.handle(history()); event = self.messages.wait('history', 'history-read')
        restored = [m for m in event['messages'] if m['text'] == value['question']]
        self.assertTrue(restored)
        self.assertTrue(all(m['answerQuote'] == quote for m in restored))

    def test_select_known_conversation_uses_offline_cache_without_starting_a_turn(self):
        self.native.store.write(request(), THREAD)
        self.native.store.record(request(), THREAD, 'a', 'user', 'Original')
        self.native.store.write(request(), OTHER); self.server.fail_history = True
        self.native.handle(history('history-select', conversationId=THREAD))
        result = self.messages.wait('history', 'history-select')
        self.assertEqual(result['activeConversationId'], THREAD)
        self.assertEqual([message['text'] for message in result['messages']], ['Original'])
        self.assertEqual(result['remoteState'], 'unknown')
        self.assertFalse(any(call[0] in ('thread/resume', 'turn/start') for call in self.server.calls))

    def test_unknown_selection_is_rejected_before_any_codex_access(self):
        self.native.handle(history('history-select', conversationId=THREAD))
        self.messages.wait('error', 'history-select'); self.assertEqual(self.server.calls, [])

    def test_new_chat_preserves_finished_history_and_names_thread_once(self):
        self.native.handle(request()); self.messages.wait('done')
        self.native.handle(request(id='second')); self.messages.wait('done', 'second')
        self.assertEqual(len([c for c in self.server.calls if c[0] == 'thread/name/set']), 1)
        self.native.handle(history('new-chat')); self.messages.wait('done', 'new-chat')
        self.native.handle(history('history-list')); result = self.messages.wait('history', 'history-list')
        self.assertIsNone(result['activeConversationId']); self.assertEqual(result['conversations'][0]['messageCount'], 4)
        self.assertEqual(len(self.native.store.page(request(), THREAD)['messages']), 4)

    def test_disconnect_saves_question_and_partial_answer(self):
        self.server.finish = False
        self.native.handle(request()); self.messages.wait('delta')
        self.server.events.put({'method': 'bridge/disconnected'})
        self.messages.wait('error')
        messages = self.native.store.page(request())['messages']
        self.assertEqual(messages[0]['text'], request()['question'])
        self.assertEqual(messages[1]['text'], 'First ')
        self.assertEqual(messages[0]['selection'], request()['selection'])

    def test_stop_partial_survives_canonical_refresh_and_helper_restart(self):
        self.server.finish = False
        self.native.handle(request()); self.messages.wait('delta')
        self.native.handle({'version': 1, 'id': 'stop', 'op': 'cancel', 'projectId': PROJECT})
        self.messages.wait('done', 'stop')
        done = self.messages.wait('done')
        self.assertTrue(done['cancelled'])
        self.assertEqual(done['text'], 'First ')
        saved = self.native.store.page(request())['messages']
        self.assertEqual([item['text'] for item in saved], [request()['question'], 'First '])
        # The real app-server can persist the interrupted turn without an
        # agentMessage item even though it already delivered assistant deltas.
        canonical = {'data': [{'id': self.server.current_turn, 'status': 'interrupted',
                              'items': [{'type': 'userMessage', 'content': [
                                  {'type': 'text', 'text': request()['question']}]}]}], 'nextCursor': None}
        self.server.pages = [canonical]
        self.native.handle(history(id='after-stop'))
        refreshed = self.messages.wait('history', 'after-stop')
        self.assertEqual(refreshed['messages'], saved)
        self.assertEqual(refreshed['remoteState'], 'idle')
        self.assertEqual(sum(method == 'turn/start' for method, _ in self.server.calls), 1)

        root = self.native.store.root
        self.native.close()
        self.server = HistoryServer(Path(self.temp.name).resolve())
        self.server.pages = [canonical]
        self.native = host.NativeHost(io.BytesIO(), host.SessionStore(root), lambda cwd, **kwargs: self.server)
        self.native.handle(history(id='after-restart'))
        restored = self.messages.wait('history', 'after-restart')
        self.assertEqual(restored['messages'], saved)
        self.assertFalse(any(method in ('thread/start', 'thread/resume', 'turn/start')
                             for method, _ in self.server.calls))

    def test_stop_keeps_unfinished_item_after_an_earlier_completed_item(self):
        self.server.finish = False
        self.native.handle(request()); self.messages.wait('delta')
        turn_id = self.server.current_turn
        self.server.events.put({'method': 'item/completed', 'params': {'threadId': THREAD,
            'turnId': turn_id, 'item': {'id': 'answer', 'type': 'agentMessage',
                                      'phase': 'final_answer', 'text': 'First section.'}}})
        self.server.events.put({'method': 'item/agentMessage/delta', 'params': {
            'threadId': THREAD, 'turnId': turn_id, 'itemId': 'second', 'delta': 'Second partial.'}})
        self.native.handle({'version': 1, 'id': 'stop', 'op': 'cancel', 'projectId': PROJECT})
        self.messages.wait('done', 'stop')
        done = self.messages.wait('done')
        self.assertTrue(done['cancelled'])
        self.assertEqual(done['text'], 'First section.\n\nSecond partial.')
        messages = self.native.store.page(request())['messages']
        self.assertEqual([item['text'] for item in messages], [request()['question'], done['text']])

    def test_rejected_start_does_not_store_a_ghost_question(self):
        original = self.server.request
        def rejecting(method, params, timeout=None):
            if method == 'turn/start':
                raise host.AppServerRPCError(method, {'code': -32600, 'message': 'additional context name is invalid'})
            return original(method, params, timeout)
        self.server.request = rejecting
        self.native.handle(request())
        error = self.messages.wait('error')
        self.assertTrue(error.get('notAccepted'))
        self.assertEqual(self.native.store.page(request())['messages'], [])
        self.assertFalse(any(event['type'] == 'started' for event in self.messages.values))

    def test_unacknowledged_start_is_not_replayed_or_reported_as_rejected(self):
        original = self.server.request
        calls = []
        def uncertain(method, params, timeout=None):
            if method == 'turn/start':
                calls.append(params)
                raise host.HostError('Codex did not respond to turn/start in time.')
            return original(method, params, timeout)
        self.server.request = uncertain
        self.native.handle(request())
        error = self.messages.wait('error')
        self.assertNotIn('notAccepted', error)
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.native.store.page(request())['messages'], [])

    def test_busy_history_select_does_not_change_active_binding(self):
        self.native.store.write(request(), OTHER)
        self.native.store.write(request(), THREAD)
        self.server.finish = False
        self.native.handle(request()); self.messages.wait('delta')
        self.native.handle(history('history-select', conversationId=OTHER))
        self.messages.wait('error', 'history-select')
        self.assertEqual(self.native.store.read(request()), THREAD)

    def test_other_tab_read_returns_scoped_cache_while_answer_holds_project_lock(self):
        self.native.store.write(request(), THREAD)
        self.native.store.record(request(), THREAD, 'earlier:user', 'user', 'Earlier question')
        self.server.finish = False
        other_server = HistoryServer(Path(self.temp.name).resolve())
        other = host.NativeHost(io.BytesIO(), host.SessionStore(self.native.store.root), lambda cwd, **kwargs: other_server)
        try:
            self.native.handle(request()); self.messages.wait('delta')
            other.handle(history(id='other-tab-read', conversationId=THREAD))
            event = self.messages.wait('history', 'other-tab-read')
            self.assertTrue(event['syncPending'])
            self.assertEqual(event['remoteState'], 'unknown')
            self.assertNotIn('syncRevision', event)
            self.assertEqual(event['conversationId'], THREAD)
            self.assertEqual(event['activeConversationId'], THREAD)
            self.assertEqual(event['messages'][0]['text'], 'Earlier question')
            self.assertEqual(other_server.calls, [])
            self.assertTrue(self.native.busy)
            self.server.complete(); self.messages.wait('done')
            other.handle(history(id='after-release', conversationId=THREAD))
            fresh = self.messages.wait('history', 'after-release')
            self.assertEqual(fresh['remoteState'], 'idle')
            self.assertNotIn('syncPending', fresh)
            self.assertIn('syncRevision', fresh)
            self.assertTrue(any(method == 'thread/read' for method, _ in other_server.calls))
        finally:
            other.close()

    def test_contended_read_without_existing_chat_is_pending_not_falsely_idle(self):
        other_store = host.SessionStore(self.native.store.root)
        with other_store.lock(request()):
            self.native.handle(history(id='empty-contended'))
            event = self.messages.wait('history', 'empty-contended')
        self.assertEqual(event['messages'], [])
        self.assertIsNone(event['activeConversationId'])
        self.assertEqual(event['remoteState'], 'unknown')
        self.assertTrue(event['syncPending'])
        self.assertNotIn('syncRevision', event)
        self.assertEqual(self.server.calls, [])

    def test_contended_reads_validate_scope_and_do_not_relax_mutation_locks(self):
        self.native.store.write(request(), OTHER)
        self.native.store.write(request(), THREAD)
        other_store = host.SessionStore(self.native.store.root)
        with other_store.lock(request()):
            for value in (request(id='blocked-send'), history('new-chat', id='blocked-new'),
                          history('history-select', id='blocked-select', conversationId=OTHER)):
                self.native.handle(value)
                self.assertIn('busy in another window', self.messages.wait('error', value['id'])['message'])
            self.assertEqual(self.native.store.read(request()), THREAD)
            # A different project is independent even in the same account.
            self.native.handle(history(id='other-project', projectId='fedcba987654321001234567'))
            independent = self.messages.wait('history', 'other-project')
            self.assertEqual(independent['remoteState'], 'idle')
            self.assertEqual(independent['messages'], [])
        foreign = history(id='foreign-cache', accountId='another-account', conversationId=THREAD)
        with other_store.lock(foreign):
            self.native.handle(foreign)
            self.assertIn('does not belong', self.messages.wait('error', 'foreign-cache')['message'])
        self.assertEqual(self.server.calls, [])

    def test_terminal_history_callback_can_immediately_request_the_next_page(self):
        self.native.store.write(request(), THREAD)
        self.native.store.record(request(), THREAD, 'a', 'user', 'Cached'); self.server.fail_history = True
        def receive(stream, event):
            self.messages.add(stream, event)
            if event['type'] == 'history' and event['id'] == 'history-list':
                self.assertFalse(self.native.busy)
                self.native.handle(history())
        with mock.patch.object(host, 'write_message', receive):
            self.native.handle(history('history-list')); self.messages.wait('history', 'history-read')


class WorkspaceTests(unittest.TestCase):
    def test_workspace_configuration_rejects_external_paths_and_invalid_shape(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve(); config = root/'workspace.json'
            self.assertEqual(host.workspace_configuration(root, config), (root, None))
            for value in ({'workspace': 'relative'}, {'workspace': str(root/'missing')},
                          {'workspace': str(root), 'projectId': 'bad'}, {'workspace': str(root), 'command': 'bad'}):
                config.write_text(json.dumps(value))
                with self.assertRaises(host.HostError): host.workspace_configuration(root, config)
    def test_workspace_configuration_rejects_symlink(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve(); config = root/'workspace.json'
            target = root/'other'; target.write_text('{}')
            try:
                config.symlink_to(target)
            except OSError as error:
                if getattr(error, 'winerror', None) == 1314:
                    self.skipTest('Windows user lacks symlink creation privilege; junction attacks have separate tests.')
                raise
            with self.assertRaises(host.HostError): host.workspace_configuration(root, config)

    def test_start_and_resume_use_configured_workspace_but_private_history_root(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve(); workspace = root/'Overleaf'; workspace.mkdir()
            config = root/'workspace.json'; config.write_text(json.dumps({'workspace': str(workspace), 'projectId': OTHER}))
            store = host.SessionStore(root/'private-history'); server = FakeServer(workspace); messages = Messages()
            factory = mock.Mock(return_value=server)
            with mock.patch.object(host, 'write_message', messages.add):
                native = host.NativeHost(io.BytesIO(), store, factory, workspace_config=config)
                try:
                    native.handle(request()); messages.wait('done')
                    native.handle(request(id='again')); messages.wait('done', 'again')
                    self.assertEqual(factory.call_args_list, [mock.call(workspace), mock.call(workspace)])
                    start = next(params for method, params in server.calls if method == 'thread/start')
                    resume = next(params for method, params in server.calls if method == 'thread/resume')
                    self.assertEqual(start['projectId'], OTHER); self.assertEqual(start['cwd'], str(workspace))
                    self.assertEqual(resume['cwd'], str(workspace)); self.assertNotIn('projectId', resume)
                    self.assertEqual(start['config']['project_doc_max_bytes'], 0)
                    self.assertEqual(start['sandbox'], 'read-only'); self.assertEqual(start['approvalPolicy'], 'never')
                    self.assertTrue((store.root/'history.sqlite3').exists())
                    self.assertFalse((workspace/'history.sqlite3').exists())
                finally: native.close()

    def test_installer_preserves_explicit_workspace_across_updates(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve(); workspace = root/'Overleaf'; workspace.mkdir()
            source = ROOT/'native/codex_host.py'
            directory, _ = installer.install('a'*32, source, root, workspace, OTHER)
            path = directory/'workspace.json'; original = path.read_text()
            self.assertEqual(json.loads(original), {'workspace': str(workspace.resolve()), 'projectId': OTHER})
            self.assertTrue(is_private(path))
            installer.install('a'*32, source, root)
            self.assertEqual(path.read_text(), original)

    def test_resolve_project_uses_existing_exact_root_and_name_without_thread_calls(self):
        workspace = Path('/known/Overleaf')
        server = mock.Mock()
        server.request.side_effect = [
            {'data': [{'id': 'wrong', 'name': 'Code', 'roots': [{'path': '/known'}]}], 'nextCursor': 'more'},
            {'data': [{'id': OTHER, 'name': 'Overleaf', 'roots': [{'path': str(workspace)}]}]}]
        self.assertEqual(installer.resolve_project_id(ROOT/'native/codex_host.py', workspace, lambda cwd: server), OTHER)
        self.assertEqual([call.args[0] for call in server.request.call_args_list], ['project/list', 'project/list'])
        server.close.assert_called_once()

    def test_resolve_project_does_not_create_when_ambiguous(self):
        server = mock.Mock(); server.request.return_value = {'data': []}
        with self.assertRaises(ValueError):
            installer.resolve_project_id(ROOT/'native/codex_host.py', Path('/known/Overleaf'), lambda cwd: server)
        self.assertEqual(server.request.call_args.args[0], 'project/list')
        server.close.assert_called_once()


if __name__ == '__main__': unittest.main()
