"""Cross-client sync tests using an in-memory durable app-server model.

No real account, chat contents or model inference are used.
"""
import copy
import io
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from test_codex_host import host, request, FakeServer, Messages, PROJECT, THREAD
from test_codex_history import history, OTHER
from test_prompt_display import envelope


def turn(identifier, question, answer, status='completed', timestamp=10):
    return {'id': identifier, 'status': status, 'startedAt': timestamp,
            'completedAt': timestamp + 1 if status != 'inProgress' else None,
            'items': [{'type': 'userMessage', 'content': [{'type': 'text', 'text': question}]},
                      {'type': 'agentMessage', 'phase': 'final_answer', 'text': answer}]}


class World:
    def __init__(self):
        self.turns = []; self.updated = 100; self.owner = None
        self.instances = []; self.contexts = []; self.before_resume = None
        self.mode = 'paginated'; self.offline = False; self.fail_after_resume = False; self.resume_id = THREAD
    def server(self, cwd, **kwargs):
        value = DurableServer(cwd, self); self.instances.append(value); return value


class DurableServer(FakeServer):
    def __init__(self, cwd, world):
        super().__init__(cwd); self.world = world; self.loaded = None
    def request(self, method, params, timeout=None):
        world = self.world
        if world.offline: raise host.HostError('offline')
        if method in ('thread/start', 'thread/resume', 'thread/read', 'thread/turns/list'):
            self.calls.append((method, params))
            if method in ('thread/start', 'thread/resume'):
                if world.owner and world.owner is not self:
                    raise host.HostError('thread-store conflict: thread already has an active writer')
                if world.before_resume and method == 'thread/resume':
                    callback = world.before_resume; world.before_resume = None; callback()
                world.owner = self; self.loaded = copy.deepcopy(world.turns)
                return {'thread': {'id': world.resume_id if method == 'thread/resume' else THREAD},
                        'model': 'test-model', 'reasoningEffort': 'high'}
            if method == 'thread/read':
                if self.loaded is not None and world.fail_after_resume:
                    raise host.HostError('Read failed after ownership was acquired')
                return {'thread': {'id': params['threadId'], 'updatedAt': world.updated,
                                  'historyMode': world.mode, 'status': {'type': 'notLoaded'}}}
            values = self.loaded if self.loaded is not None else world.turns
            values = list(reversed(values)) if params['sortDirection'] == 'desc' else values
            offset = int(params.get('cursor', '0')); limit = params['limit']
            return {'data': copy.deepcopy(values[offset:offset + limit]),
                    'nextCursor': str(offset + limit) if offset + limit < len(values) else None}
        if method == 'turn/start':
            world.contexts.append(copy.deepcopy(self.loaded))
            result = super().request(method, params, timeout)
            world.turns.append(turn(self.current_turn, params['input'][0]['text'], 'First answer.', timestamp=100 + len(world.turns)))
            return result
        return super().request(method, params, timeout)
    def close(self):
        if self.world.owner is self: self.world.owner = None
        super().close()


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.world = World(); self.messages = Messages()
        self.patch = mock.patch.object(host, 'write_message', self.messages.add); self.patch.start()
        self.store = host.SessionStore(Path(self.temp.name).resolve()/'state')
        self.store.write(request(), THREAD)
        self.native = host.NativeHost(io.BytesIO(), self.store, self.world.server)
        self.number = 0
    def tearDown(self): self.native.close(); self.patch.stop(); self.temp.cleanup()
    def sync(self, **fields):
        self.number += 1; identifier = 'sync-' + str(self.number)
        self.native.handle(history(id=identifier, **fields))
        return self.messages.wait('history', identifier)

    def test_desktop_plain_text_partial_and_final_update_stable_ids_with_same_second_timestamp(self):
        self.world.turns = [turn('desktop-1', 'A plain desktop question', 'Draft', 'inProgress')]
        first = self.sync(); self.assertEqual(first['remoteState'], 'active')
        self.assertEqual([m['text'] for m in first['messages']], ['A plain desktop question', 'Draft'])
        ids = [m['messageId'] for m in first['messages']]
        self.world.turns[0]['items'][1]['text'] = 'A longer partial response'
        second = self.sync()
        self.assertNotEqual(first['syncRevision'], second['syncRevision'])
        self.assertEqual([m['messageId'] for m in second['messages']], ids)
        self.world.turns[0]['status'] = 'completed'; self.world.turns[0]['completedAt'] = 11
        self.world.turns[0]['items'][1]['text'] = 'Final'
        third = self.sync(); fourth = self.sync()
        self.assertEqual(third['remoteState'], 'idle')
        self.assertNotEqual(second['syncRevision'], third['syncRevision'])
        self.assertEqual(third['syncRevision'], fourth['syncRevision'])
        self.assertEqual([m['messageId'] for m in third['messages']], ids)
        self.assertEqual([m['text'] for m in third['messages']], ['A plain desktop question', 'Final'])
        self.assertEqual(len(fourth['messages']), 2)
        self.assertFalse(any(method in ('thread/resume', 'turn/start') for server in self.world.instances for method, _ in server.calls))
        self.native.close()
        self.native = host.NativeHost(io.BytesIO(), host.SessionStore(self.store.root), self.world.server)
        reloaded = self.sync()
        self.assertEqual(reloaded['messages'], third['messages'])
        self.assertEqual(reloaded['syncRevision'], third['syncRevision'])

    def test_multiple_user_items_in_one_steered_turn_are_not_replacements(self):
        value = turn('steered', 'Initial question', 'Final answer')
        value['items'][1:1] = [
            {'type': 'userMessage', 'content': [{'type': 'text', 'text': 'First steering message'}]},
            {'type': 'userMessage', 'content': [{'type': 'text', 'text': 'Second steering message'}]},
        ]
        self.world.turns = [value]
        first = self.sync(); again = self.sync()
        self.assertEqual([m['text'] for m in first['messages']],
                         ['Initial question', 'First steering message', 'Second steering message', 'Final answer'])
        self.assertEqual(len({m['messageId'] for m in first['messages']}), 4)
        self.assertEqual(first['messages'], again['messages'])

    def test_compact_user_history_preserves_local_citations_until_text_changes(self):
        quote = {'text': 'Quoted answer'}
        self.store.record(request(), THREAD, 'compact:user', 'user', 'Small question', request()['selection'], answer_quote=quote)
        original = self.store.page(request())['messages'][0]['messageId']
        self.world.turns = [turn('compact', 'Small question', 'Answer')]
        page = self.sync()
        user = page['messages'][0]
        self.assertEqual(user['messageId'],original)
        self.assertEqual(user['selection'],request()['selection'])
        self.assertEqual(user['answerQuote'],quote)
        self.world.turns[0]['items'][0]['content'][0]['text'] = 'Edited question'
        self.world.updated += 1
        user = self.sync()['messages'][0]
        self.assertEqual(user['text'],'Edited question')
        self.assertNotIn('selection',user);self.assertNotIn('answerQuote',user)

    def test_annotation_wrapper_sync_is_compact_but_preserves_question_and_quote(self):
        wrapped = envelope(question='Actual follow-up')
        self.world.turns = [turn('annotation', wrapped, 'Answer')]
        message = self.sync()['messages'][0]
        self.assertEqual(message['text'],'Actual follow-up')
        self.assertIn('C_2',message['answerQuote']['text'])
        self.assertNotIn('response-annotations',message['text'])
        self.assertEqual(self.world.turns[0]['items'][0]['content'][0]['text'],wrapped)

    def test_existing_cached_annotation_rows_compact_on_read_without_rewriting_source(self):
        wrapped = envelope(question='Cached actual question')
        self.store.record(request(), THREAD, 'cached:user', 'user', wrapped)
        message = self.store.page(request())['messages'][0]
        self.assertEqual(message['text'],'Cached actual question')
        self.assertIn('answerQuote',message)
        with self.store.database(request()) as db:
            self.assertEqual(db.execute('SELECT text FROM messages WHERE id=?',('cached:user:0',)).fetchone()[0],wrapped)
        literal = 'Explain this marker:\n## My request:\nKeep this text'
        self.store.record(request(), THREAD, 'literal:user', 'user', literal)
        self.assertEqual(self.store.page(request())['messages'][-1]['text'],literal)

    def test_new_desktop_turns_and_older_completed_edit_are_upserted_without_duplicates(self):
        self.world.turns = [turn('old', 'Original question', 'Original answer')]
        first = self.sync(); original_id = first['messages'][1]['messageId']
        self.world.turns.extend([turn('new-1', 'Desktop follow-up one', 'One', timestamp=12),
                                 turn('new-2', 'Desktop follow-up two', 'Two', timestamp=14)])
        second = self.sync(); self.assertEqual(len(second['messages']), 6)
        self.assertEqual(second['messages'][-1]['text'], 'Two')
        self.world.turns[0]['items'][1]['text'] = 'Revised older answer'; self.world.updated += 1
        third = self.sync(); self.assertEqual(len(third['messages']), 6)
        self.assertEqual(third['messages'][1]['text'], 'Revised older answer')
        self.assertEqual(third['messages'][1]['messageId'], original_id)
        self.assertNotEqual(second['syncRevision'], third['syncRevision'])
        self.assertEqual(third['messages'], self.sync()['messages'])

    def test_interrupted_partial_fragments_yield_to_later_authoritative_answers(self):
        partial = 'Unfinished streamed answer. ' * 20000
        self.store.record(request(), THREAD, 'stopped:assistant', 'assistant', partial, created=11000)
        original = self.store.page(request())['messages'][0]['messageId']
        self.world.turns = [turn('stopped', 'Question', '', 'interrupted')]
        self.world.turns[0]['items'].pop()
        first = self.sync()
        assistants = [item for item in first['messages'] if item['role'] == 'assistant']
        self.assertGreater(len(assistants), 1)
        self.assertEqual(''.join(item['text'] for item in assistants), partial)
        self.assertEqual(first['messages'], self.sync()['messages'])

        # A later canonical answer, even a shorter one, replaces the fallback
        # under its existing display ID and removes every obsolete fragment.
        for status, answer in [('interrupted', 'Canonical partial.'),
                               ('completed', 'Final.'), ('completed', 'Later Desktop edit.')]:
            self.world.turns[0] = turn('stopped', 'Question', answer, status)
            self.world.updated += 1
            page = self.sync()
            self.assertEqual([item['text'] for item in page['messages']], ['Question', answer])
            self.assertEqual(page['messages'][1]['messageId'], original)
            self.assertEqual(page['messages'], self.sync()['messages'])

    def test_completed_without_answer_still_clears_streamed_fallback(self):
        self.store.record(request(), THREAD, 'completed:assistant', 'assistant', 'Discarded draft', created=11000)
        self.world.turns = [turn('completed', 'Question', '')]
        self.world.turns[0]['items'].pop()
        page = self.sync()
        self.assertEqual([item['text'] for item in page['messages']], ['Question'])
        self.assertEqual(page['messages'], self.sync()['messages'])

    def test_fresh_writer_resumes_desktop_context_and_closes_after_each_answer(self):
        self.world.turns = [turn('desktop', 'Question written in Codex desktop', 'Desktop answer')]
        page = self.sync(); observer = self.native.server
        self.native.handle(request(expectedConversationId=THREAD, expectedSyncRevision=page['syncRevision']))
        self.messages.wait('done')
        self.assertTrue(observer.closed)
        writer = self.world.instances[-1]
        self.assertTrue(writer.closed); self.assertIsNone(self.world.owner); self.assertIsNone(self.native.server)
        self.assertEqual(self.world.contexts[0][0]['items'][0]['content'][0]['text'], 'Question written in Codex desktop')
        self.world.turns.append(turn('desktop-again', 'Another desktop question', 'Its answer', timestamp=120))
        page = self.sync()
        self.native.handle(request(id='next', expectedConversationId=THREAD, expectedSyncRevision=page['syncRevision']))
        self.messages.wait('done', 'next')
        self.assertEqual(self.world.contexts[1][-1]['id'], 'desktop-again')
        self.assertTrue(self.world.instances[-1].closed)

    def test_busy_desktop_turn_blocks_before_resume_or_model_start(self):
        self.world.turns = [turn('desktop', 'Question', 'Draft', 'inProgress')]
        page = self.sync()
        self.native.handle(request(expectedConversationId=THREAD, expectedSyncRevision=page['syncRevision']))
        event = self.messages.wait('error')
        self.assertIn('still answering', event['message'])
        self.assertFalse(any(method in ('thread/resume', 'turn/start', 'turn/interrupt') for server in self.world.instances for method, _ in server.calls))

    def test_idle_desktop_writer_conflict_is_not_stolen_or_retried(self):
        self.world.turns = [turn('desktop', 'Question', 'Done')]; self.world.owner = 'desktop'
        self.native.desktop_factory = mock.Mock(side_effect=host.DesktopIPCError('Synthetic unavailable Desktop'))
        page = self.sync(); self.assertEqual(page['remoteState'], 'idle')
        self.native.handle(request(expectedConversationId=THREAD, expectedSyncRevision=page['syncRevision']))
        error = self.messages.wait('error')
        self.assertIn('Could not connect to this conversation in Codex Desktop', error['message'])
        self.assertEqual(self.world.owner, 'desktop')
        methods = [method for server in self.world.instances for method, _ in server.calls]
        self.assertEqual(methods.count('thread/resume'), 1)
        self.assertNotIn('turn/start', methods); self.assertNotIn('turn/interrupt', methods)
        self.assertIsNone(self.native.server)

    def test_history_change_before_resume_and_after_preflight_rejects_without_model_turn(self):
        self.world.turns = [turn('old', 'Question', 'Answer')]
        page = self.sync()
        self.world.before_resume = lambda: self.world.turns.append(turn('raced', 'New desktop question', 'Answer', timestamp=20))
        self.native.handle(request(expectedConversationId=THREAD, expectedSyncRevision=page['syncRevision']))
        error = self.messages.wait('error'); self.assertIn('New messages arrived', error['message'])
        self.assertIsNone(self.world.owner)
        self.assertFalse(self.world.contexts)
        refreshed = self.sync(); self.assertEqual(len(refreshed['messages']), 4)

    def test_offline_refresh_returns_cached_unknown_and_scope_is_checked_before_rpc(self):
        self.world.turns = [turn('desktop', 'Question', 'Answer')]
        page = self.sync(); self.world.offline = True
        offline = self.sync(); self.assertEqual(offline['remoteState'], 'unknown')
        self.assertEqual(offline['messages'], page['messages'])
        self.assertNotEqual(offline['syncRevision'], page['syncRevision'])
        count = sum(len(server.calls) for server in self.world.instances)
        self.native.handle(history(id='foreign', conversationId=THREAD, accountId='another-account'))
        self.messages.wait('error', 'foreign')
        self.assertEqual(count, sum(len(server.calls) for server in self.world.instances))

    def test_read_failure_after_acquiring_writer_releases_only_its_own_server(self):
        self.world.turns = [turn('desktop', 'Question', 'Answer')]
        page = self.sync(); self.world.fail_after_resume = True
        self.native.handle(request(expectedConversationId=THREAD, expectedSyncRevision=page['syncRevision']))
        self.messages.wait('error')
        self.assertIsNone(self.world.owner); self.assertTrue(self.world.instances[-1].closed)
        self.assertFalse(self.world.contexts)

    def test_unexpected_resume_identity_never_changes_scoped_binding_or_sends(self):
        self.world.turns = [turn('desktop', 'Question', 'Answer')]
        page = self.sync(); self.world.resume_id = OTHER
        self.native.handle(request(expectedConversationId=THREAD, expectedSyncRevision=page['syncRevision']))
        error = self.messages.wait('error')
        self.assertIn('unexpected conversation', error['message'])
        self.assertEqual(self.store.read(request()), THREAD)
        self.assertIsNone(self.world.owner); self.assertFalse(self.world.contexts)

    def test_sync_revision_validation_and_legacy_history_fail_closed(self):
        for value in ('a'*63, 'z'*64, None, 42):
            with self.assertRaises(host.HostError): host.validate_request(request(expectedSyncRevision=value))
        self.world.turns = [turn('legacy', 'Question', 'Answer')]; self.world.mode = 'legacy'
        page = self.sync(); self.assertEqual(page['remoteState'], 'unknown')
        self.native.handle(request(expectedConversationId=THREAD, expectedSyncRevision=page['syncRevision']))
        self.messages.wait('error')
        self.assertFalse(any(method in ('thread/resume', 'turn/start') for server in self.world.instances for method, _ in server.calls))


if __name__ == '__main__': unittest.main()
