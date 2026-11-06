"""Custom API adapter tests. Only synthetic profiles and local fake transports."""
import io
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import queue
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from platform_test_support import assert_private, make_symlink, private_permissions
from unittest import mock
import uuid

from test_codex_host import host, request
from test_codex_history import history
import api_provider
from api_provider import APIBackend, APIConnection, APIError, APIModelsUnavailable, APIAuthenticationError, ProfileStore, normalize_base_url


class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = ProfileStore(Path(self.temp.name).resolve() / 'profiles')
    def tearDown(self): self.temp.cleanup()
    def make(self, **values):
        return self.store.save(dict({'name': 'Test API', 'baseUrl': 'https://example.invalid/v1',
                                     'model': 'lab/model:1', 'apiKey': 'synthetic-private-key'}, **values))

    def test_private_storage_and_redacted_metadata_survive_restart(self):
        profile = self.make()
        self.assertNotIn('apiKey', profile)
        self.assertTrue(profile['hasKey'])
        restored = ProfileStore(self.store.root)
        self.assertEqual(restored.list(), [profile])
        self.assertEqual(restored.get(profile['id'])['apiKey'], 'synthetic-private-key')
        assert_private(self, self.store.root, 0o700)
        assert_private(self, self.store.path, 0o600)
        self.assertNotIn('synthetic-private-key', json.dumps(restored.list()))

    def test_blank_key_preserves_secret_and_address_cannot_change(self):
        profile = self.make()
        updated = self.make(id=profile['id'], name='Renamed', model='new-model', apiKey='')
        self.assertEqual(updated['name'], 'Renamed')
        self.assertEqual(self.store.get(profile['id'])['apiKey'], 'synthetic-private-key')
        with self.assertRaisesRegex(APIError, 'new connection'):
            self.make(id=profile['id'], baseUrl='https://another.invalid/v1')
        self.assertEqual(self.store.get(profile['id'])['baseUrl'], 'https://example.invalid/v1')

    def test_url_normalization_and_unsafe_urls(self):
        self.assertEqual(normalize_base_url('https://api.example.invalid/v1/chat/completions/'), 'https://api.example.invalid/v1')
        self.assertEqual(normalize_base_url('http://[::1]:43124/v1'), 'http://[::1]:43124/v1')
        for url in ['http://example.invalid/v1', 'https://u:pass@example.invalid', 'https://example.invalid?api_key=bad',
                    'https://example.invalid/#fragment', 'file:///tmp/api', 'https://example.invalid/../v1',
                    'https://example.invalid\r\nX: bad', 'https://example.invalid\\@bad.invalid', 'https://example.invalid:99999']:
            with self.subTest(url=url), self.assertRaises(APIError): normalize_base_url(url)

    def test_remote_needs_key_loopback_does_not_and_header_controls_rejected(self):
        with self.assertRaises(APIError): self.make(apiKey='')
        profile = self.make(baseUrl='http://127.0.0.1:43124/v1', apiKey='')
        self.assertFalse(profile['hasKey'])
        for key in ['line\nbreak', 'key\x7f', '秘密']:
            with self.assertRaises(APIError): self.make(apiKey=key)

    def test_loading_existing_profile_repairs_broad_file_permissions(self):
        profile = self.make()
        os.chmod(self.store.path, 0o644)
        self.assertEqual(self.store.get(profile['id'])['apiKey'], 'synthetic-private-key')
        assert_private(self, self.store.path, 0o600)

    def test_delete_does_not_expose_secret_or_allow_unknown_update(self):
        profile = self.make()
        self.store.delete(profile['id'])
        self.assertEqual(self.store.list(), [])
        with self.assertRaises(APIError): self.store.get(profile['id'])
        with self.assertRaises(APIError): self.make(id=profile['id'])

    def test_symlink_files_refused(self):
        target = Path(self.temp.name).resolve() / 'other'; target.write_text('[]')
        make_symlink(self.store.path, target)
        with self.assertRaises(APIError): self.make()
        self.assertEqual(target.read_text(), '[]')


class Response:
    def __init__(self, data, status=200, content_type='text/event-stream'):
        self.data = io.BytesIO(data)
        self.status = status
        self.content_type = content_type
    def getheader(self, name, default=''): return self.content_type
    def readline(self, limit): return self.data.readline(limit)
    def read(self, size): return self.data.read(size)


class Connection:
    def __init__(self, response):
        self.response = response; self.calls = []; self.closed = False; self.sock = None; self.connected = False
    def connect(self): self.connected = True
    def request(self, method, path, **kwargs): self.calls.append((method, path, kwargs))
    def getresponse(self): return self.response
    def close(self): self.closed = True


def event(value): return ('data: ' + json.dumps(value, ensure_ascii=False) + '\n\n').encode('utf-8')
def chunk(text=None, reason=None, **delta):
    if text is not None: delta['content'] = text
    return {'choices': [{'index': 0, 'delta': delta, 'finish_reason': reason}]}


class TransportTests(unittest.TestCase):
    profile = {'baseUrl': 'https://example.invalid/v1', 'model': 'profile-model', 'apiKey': 'DO_NOT_LEAK'}
    def transport(self, response):
        raw = Connection(response)
        api = APIConnection(self.profile, connection_factory=lambda _: raw)
        return api, raw

    def test_stream_comments_multiline_json_unicode_and_no_reasoning_or_tools(self):
        data = b': keep alive\r\n\r\n' + event(chunk(reasoning_content='private reasoning'))
        data += b'data: {"choices":\ndata: [{"delta":{"content":"x"},"finish_reason":null}]}\n\n'
        data += event(chunk('公式 \\(x^2\\)')) + event(chunk(reason='stop')) + b'data: [DONE]\n\n'
        api, raw = self.transport(Response(data)); values = []
        api.stream([{'role': 'user', 'content': 'Synthetic context'}], values.append)
        self.assertEqual(''.join(values), 'x公式 \\(x^2\\)')
        self.assertEqual(len(raw.calls), 1)
        method, path, request_data = raw.calls[0]
        payload = json.loads(request_data['body'])
        self.assertEqual((method, path), ('POST', '/v1/chat/completions'))
        self.assertEqual(payload['model'], 'profile-model')
        self.assertTrue(payload['stream'])
        self.assertNotIn('tools', payload)
        self.assertTrue(raw.closed)

    def test_nonstream_json_fallback(self):
        body = json.dumps({'choices': [{'message': {'content': 'JSON answer'}, 'finish_reason': 'stop'}]}).encode()
        api, raw = self.transport(Response(body, content_type='application/json')); values=[]
        api.stream([], values.append)
        self.assertEqual(values, ['JSON answer'])

    def test_streamed_tool_arguments_and_reasoning_are_reassembled_without_displaying_them(self):
        tools = [{'type': 'function', 'function': {'name': 'read_project_file', 'parameters': {'type': 'object'}}}]
        data = event(chunk(reasoning_content='provider reasoning retained only in this continuation'))
        data += event(chunk(tool_calls=[{'index': 0, 'id': 'call_1', 'type': 'function', 'function': {'name': 'read_project_file', 'arguments': '{"snapshot_id":'}}]))
        data += event(chunk(tool_calls=[{'index': 0, 'function': {'arguments': '"snapshot-1","path":"Localization.tex"}'}}]))
        data += event(chunk(reason='tool_calls')) + b'data: [DONE]\n\n'
        api, raw = self.transport(Response(data)); displayed = []
        result = api.stream([], displayed.append, tools)
        self.assertEqual(displayed, [])
        self.assertEqual(result['tool_calls'][0]['function']['name'], 'read_project_file')
        self.assertEqual(json.loads(result['tool_calls'][0]['function']['arguments'])['snapshot_id'], 'snapshot-1')
        self.assertIn('reasoning_content', result)
        self.assertEqual(json.loads(raw.calls[0][2]['body'])['tools'], tools)

    def test_nonstream_tool_completion_and_final_text_are_supported(self):
        call = {'id': 'call-1', 'type': 'function', 'function': {'name': 'list_project_files', 'arguments': '{"snapshot_id":"snapshot-1"}'}}
        api, _ = self.transport(Response(json.dumps({'choices': [{'message': {'content': None, 'tool_calls': [call]}, 'finish_reason': 'tool_calls'}]}).encode(), content_type='application/json'))
        self.assertEqual(api.stream([], lambda _: None, [])['tool_calls'], [call])
        api, _ = self.transport(Response(event(chunk('Answer')) + event(chunk(reason='stop'))))
        values = []
        self.assertEqual(api.stream([], values.append, []), {'role': 'assistant', 'content': 'Answer'})
        self.assertEqual(values, ['Answer'])

    def test_final_pass_disables_tools_without_dropping_reasoning_continuation(self):
        tools = [{'type':'function','function':{'name':'read_project_file','parameters':{'type':'object'}}}]
        messages = [{'role':'assistant','content':None,'reasoning_content':'continuation reasoning',
                     'tool_calls':[{'id':'read-one','type':'function','function':{'name':'read_project_file','arguments':'{}'}}]},
                    {'role':'tool','tool_call_id':'read-one','content':'source result'}]
        api, raw = self.transport(Response(event(chunk('Limited answer')) + event(chunk(reason='stop'))))
        values=[]; result=api.stream(messages,values.append,tools,tool_choice='none')
        payload=json.loads(raw.calls[0][2]['body'])
        self.assertEqual(payload['tool_choice'],'none')
        self.assertEqual(payload['tools'],tools)
        self.assertEqual(payload['messages'],messages)
        self.assertEqual(result['content'],'Limited answer')
        self.assertEqual(values,['Limited answer'])

    def test_tool_protocol_failure_is_explicit_and_never_retried_without_tools(self):
        api, raw = self.transport(Response(b'upstream may include secrets', status=400))
        with self.assertRaisesRegex(APIError, 'function calling'):
            api.stream([], lambda _: None, [{'type': 'function'}])
        self.assertEqual(len(raw.calls), 1)
        api, raw = self.transport(Response(event(chunk(tool_calls=[{'index': 0, 'id': 'one', 'function': {'name': 'read_project_file', 'arguments': '{}'}}])) + b'data: [DONE]\n\n'))
        with self.assertRaisesRegex(APIError, 'did not finish'):
            api.stream([], lambda _: None, [])
        self.assertEqual(len(raw.calls), 1)

    def test_incomplete_stream_is_error_preserving_received_text(self):
        api, raw = self.transport(Response(event(chunk('partial')))); values=[]
        with self.assertRaisesRegex(APIError, 'before completion'): api.stream([], values.append)
        self.assertEqual(values, ['partial'])
        self.assertEqual(len(raw.calls), 1)

    def test_remote_errors_and_redirects_never_leak_or_retry(self):
        for status in [302, 401, 403, 429, 500]:
            with self.subTest(status=status):
                api, raw = self.transport(Response(b'DO_NOT_LEAK private response', status=status))
                with self.assertRaises(APIError) as error: api.stream([], lambda _: None)
                self.assertNotIn('DO_NOT_LEAK', str(error.exception))
                self.assertNotIn('private response', str(error.exception))
                self.assertEqual(len(raw.calls), 1)
                self.assertTrue(raw.closed)

    def test_models_uses_get_without_prompt_and_filters_model_ids(self):
        body = json.dumps({'data': [{'id': 'good/model'}, {'id': 'bad\nmodel'}, {'id': 'good/model'}]}).encode()
        api, raw = self.transport(Response(body, content_type='application/json'))
        self.assertEqual(api.models(), [{'id': 'good/model', 'displayName': 'good/model', 'efforts': []}])
        self.assertEqual(raw.calls[0][0:2], ('GET', '/v1/models'))
        self.assertIsNone(raw.calls[0][2]['body'])

    def test_tools_truncation_and_oversize_are_errors(self):
        for value, pattern in [(chunk(tool_calls=[{'id': 'x'}]), 'tool call'), (chunk(reason='length'), 'truncated')]:
            api, raw = self.transport(Response(event(value)))
            with self.assertRaisesRegex(APIError, pattern): api.stream([], lambda _: None)
        api, raw = self.transport(Response(event(chunk('a' * 450001))))
        with self.assertRaisesRegex(APIError, 'response limit'): api.stream([], lambda _: None)

    def test_truncated_final_chunk_and_json_keep_last_text(self):
        responses = [Response(event(chunk('last chunk', reason='length'))),
                     Response(json.dumps({'choices': [{'message': {'content': 'last chunk'}, 'finish_reason': 'length'}]}).encode(), content_type='application/json')]
        for response in responses:
            api, raw = self.transport(response); values=[]
            with self.assertRaisesRegex(APIError, 'truncated'): api.stream([], values.append)
            self.assertEqual(values, ['last chunk'])

    def test_cancellation_during_construction_never_connects_or_posts(self):
        cancelled = threading.Event()
        raw = Connection(Response(b''))
        def factory(_):
            cancelled.set()
            return raw
        api = APIConnection(self.profile, cancelled, connection_factory=factory)
        with self.assertRaisesRegex(APIError, 'stopped'): api.stream([], lambda _: None)
        self.assertFalse(raw.connected)
        self.assertEqual(raw.calls, [])
        self.assertTrue(raw.closed)
        self.assertTrue(api.finished.is_set())

    def test_cancellation_during_connect_never_transmits_credentials_or_body(self):
        cancelled = threading.Event()
        raw = Connection(Response(b''))
        def connect():
            raw.connected = True
            cancelled.set()
        raw.connect = connect
        api = APIConnection(self.profile, cancelled, connection_factory=lambda _: raw)
        with self.assertRaisesRegex(APIError, 'stopped'): api.stream([], lambda _: None)
        self.assertTrue(raw.connected)
        self.assertEqual(raw.calls, [])
        self.assertTrue(raw.closed)
        self.assertFalse(api.watcher.is_alive())

    def test_cancel_before_request_does_not_connect(self):
        cancelled = threading.Event(); cancelled.set()
        factory = mock.Mock()
        api = APIConnection(self.profile, cancelled, connection_factory=factory)
        with self.assertRaisesRegex(APIError, 'stopped'): api.stream([], lambda _: None)
        factory.assert_not_called()


class LocalHTTPTests(unittest.TestCase):
    def setUp(self):
        self.release=threading.Event(); self.started=threading.Event(); self.requests=[]
        self.stall_headers=False; self.pause_utf8=False
        outer=self
        class Handler(BaseHTTPRequestHandler):
            protocol_version='HTTP/1.1'
            def log_message(self,*args): pass
            def do_POST(self):
                payload=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                outer.requests.append(payload)
                if outer.stall_headers:
                    outer.started.set(); outer.release.wait(3)
                    return
                self.send_response(200); self.send_header('Content-Type','text/event-stream')
                self.send_header('Connection','close'); self.end_headers()
                content=event(chunk('数学'))
                # Split the UTF-8 bytes across network writes, not characters.
                for index, byte in enumerate(content):
                    self.wfile.write(bytes([byte])); self.wfile.flush()
                    if outer.pause_utf8 and index == content.index('数'.encode('utf-8')):
                        # Pause inside a UTF-8 codepoint and an SSE line. The
                        # raw receive timeout must not discard buffered bytes.
                        time.sleep(.25)
                outer.started.set()
                outer.release.wait(3)
                try:
                    self.wfile.write(event(chunk(reason='stop'))+b'data: [DONE]\n\n'); self.wfile.flush()
                except (OSError, ValueError): pass
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.server.daemon_threads=True
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True); self.thread.start()
        self.profile={'baseUrl':'http://127.0.0.1:'+str(self.server.server_port)+'/v1','model':'local-test','apiKey':''}
    def tearDown(self):
        self.release.set(); self.server.shutdown(); self.server.server_close(); self.thread.join(2)

    def test_real_loopback_fragmented_utf8_stream(self):
        self.release.set(); api=APIConnection(self.profile); values=[]
        api.stream([{'role':'user','content':'Synthetic local only'}],values.append)
        self.assertEqual(values,['数学'])
        self.assertEqual(len(self.requests),1)

    def test_cancel_interrupts_connection_close_socket_promptly(self):
        self._cancel_stalled_request(close=True)

    def test_cancellation_event_interrupts_stalled_response_without_close(self):
        self._cancel_stalled_request(close=False)

    def test_cancel_interrupts_stalled_response_headers_promptly(self):
        self.stall_headers=True
        self._cancel_stalled_request(close=True)

    def test_fragmented_utf8_survives_idle_receive_timeout(self):
        self.pause_utf8=True
        self.test_real_loopback_fragmented_utf8_stream()

    def _cancel_stalled_request(self, close):
        cancelled=threading.Event(); api=APIConnection(self.profile,cancelled); values=[]; errors=[]
        def run():
            try: api.stream([],values.append)
            except APIError as error: errors.append(str(error))
        worker=threading.Thread(target=run);worker.start()
        self.assertTrue(self.started.wait(2)); stopped_at=time.monotonic(); cancelled.set()
        if close:
            api.close()
        worker.join(max(0, 1 - (time.monotonic() - stopped_at)))
        self.assertFalse(worker.is_alive(),'Cancellation must interrupt a stalled HTTPResponse')
        self.assertLess(time.monotonic() - stopped_at, 1, 'Closing the transport is part of the cancellation deadline')
        self.assertEqual(len(self.requests),1)
        self.assertTrue(errors)


class FakeHost:
    def __init__(self, store):
        self.store=store; self.events=[]; self.cancelled=threading.Event(); self.closed=threading.Event()
    def emit(self, identifier, kind, **fields): self.events.append(dict(id=identifier,type=kind,**fields))
    def check_sync(self, request, sync):
        if request.get('expectedSyncRevision',sync['syncRevision']) != sync['syncRevision']:
            raise APIError('New messages arrived')


class ModelConnection:
    instances=[]
    def __init__(self, profile, cancelled):
        self.profile=profile; self.cancelled=cancelled; self.closed=False; self.messages=None
        self.fail=False; self.partial='API reply'; self.entered=None; self.release=None
        self.instances.append(self)
    def models(self):
        return [{'id':'remote-model','displayName':'remote-model','efforts':[]}]
    def stream(self, messages, on_delta):
        self.messages=messages
        if self.entered:
            self.entered.set(); self.release.wait(3)
        on_delta(self.partial)
        if self.fail: raise APIError('Synthetic disconnect; no retry')
    def close(self):
        self.closed=True
        if self.release: self.release.set()


class BackendTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.profiles=ProfileStore(Path(self.temp.name).resolve()/'profiles')
        self.profile=self.profiles.save({'name':'Synthetic API','baseUrl':'http://127.0.0.1:43124/v1','model':'configured-model','apiKey':''})
        self.host=FakeHost(host.SessionStore(Path(self.temp.name).resolve()/'history'))
        self.created=[]
        def factory(*args):
            value=ModelConnection(*args); self.created.append(value); return value
        self.backend=APIBackend(self.host,self.profiles,'Read-only system instructions',factory)
    def tearDown(self): self.backend.close(); self.temp.cleanup()
    def ask(self,**values):
        result=request(providerId=self.profile['id'],**values)
        self.backend.ask(result)
        return result
    def store(self): return self.backend.store_for(request(providerId=self.profile['id']))

    def test_api_context_and_complete_prior_turns_persist_across_restart(self):
        first=self.ask(question='First', answerQuote={'text':'Prior answer \\(q\\)'})
        actual=self.created[0]
        self.assertEqual(actual.profile['model'],'configured-model')
        prompt=actual.messages[-1]['content']
        self.assertIn('Some definitions.',prompt)
        self.assertIn('x+y',prompt)
        self.assertIn('Prior answer',prompt)
        self.assertIsNone(self.host.store.read(first))
        self.backend=APIBackend(self.host,self.profiles,'System',self.backend.connection_factory)
        self.ask(question='Second')
        wire=self.created[-1].messages
        self.assertEqual([x['role'] for x in wire],['system','user','assistant','user'])
        self.assertEqual(wire[1]['content'],prompt)
        self.assertEqual(wire[2]['content'],'API reply')
        self.assertEqual([v['text'] for v in self.store().page(first)['messages']],['First','API reply','Second','API reply'])

    def snapshot_factory(self, responses):
        self.host.project_context = SimpleNamespace(get=mock.Mock(return_value={'files': [{'path': 'large.tex', 'content': 'not sent wholesale' * 100000}]}))
        pending = list(responses)
        def factory(profile, cancelled):
            connection = mock.Mock()
            def stream(messages, on_delta, tools, tool_choice='auto'):
                connection.tool_choice = tool_choice
                connection.messages = json.loads(json.dumps(messages)); connection.tools = tools
                response = pending.pop(0)
                if isinstance(response, Exception): raise response
                if response.get('content'): on_delta(response['content'])
                return response
            connection.stream.side_effect = stream
            self.created.append(connection); return connection
        self.backend.connection_factory = factory

    def test_snapshot_tools_read_on_demand_without_sending_full_project(self):
        call = {'id': 'call-1', 'type': 'function', 'function': {'name': 'read_project_file', 'arguments': json.dumps({'snapshot_id': 'snapshot-1', 'path': 'Localization.tex'})}}
        self.snapshot_factory([{'role': 'assistant', 'content': None, 'tool_calls': [call]}, {'role': 'assistant', 'content': 'Located from source.'}])
        with mock.patch('manuscript_mcp.call_tool', return_value={'content': [{'type': 'text', 'text': '{"path":"Localization.tex","text":"needed passage"}'}]}) as tool:
            req = self.ask(snapshotId='snapshot-1', files=[{'path': 'bad.tex', 'content': 'never send me'}],
                           projectSnapshot={'snapshot_id': 'snapshot-1', 'file_count': 2, 'total_bytes': 16000000})
        self.host.project_context.get.assert_called_with(self.host.store.key(req), 'snapshot-1')
        tool.assert_called_once()
        first = json.dumps(self.created[0].messages)
        self.assertNotIn('not sent wholesale', first); self.assertNotIn('never send me', first)
        self.assertLess(len(first), 20000)
        self.assertIn('read_project_file', json.dumps(self.created[0].tools))
        self.assertEqual(self.created[1].messages[-1]['role'], 'tool')
        self.assertIn('needed passage', self.created[1].messages[-1]['content'])
        self.assertEqual(self.host.events[-1]['text'], 'Located from source.')

    @staticmethod
    def read_call(index, **arguments):
        return {'role': 'assistant', 'content': None, 'tool_calls': [{'id': 'read-%s' % index, 'type': 'function',
                'function': {'name': 'read_project_file', 'arguments': json.dumps(dict(
                    {'snapshot_id': 'snapshot-1', 'path': 'main.tex', 'start_line': index + 1}, **arguments))}}]}

    def test_whole_manuscript_can_read_more_than_sixteen_pages_then_answer(self):
        self.snapshot_factory([self.read_call(i) for i in range(24)] + [{'role': 'assistant', 'content': 'All requested pages reviewed.'}])
        result = {'content': [{'type': 'text', 'text': '{"text":"complete page","next":{"line":2,"character":0}}'}]}
        with mock.patch('manuscript_mcp.call_tool', return_value=result) as tool:
            req = self.ask(snapshotId='snapshot-1')
        self.assertEqual(tool.call_count, 24)
        self.assertEqual(len(self.created), 25)
        self.assertEqual(self.host.events[-1]['text'], 'All requested pages reviewed.')
        self.assertNotIn('unconfirmed', self.host.events[-1]['text'])
        self.assertIn('max_lines=200 and max_characters=8000', self.created[0].messages[0]['content'])
        self.assertEqual(self.store().page(req)['messages'][-1]['text'], 'All requested pages reviewed.')

    def test_last_permitted_read_gets_a_reserved_answer_instead_of_an_error(self):
        self.snapshot_factory([self.read_call(0), self.read_call(1), {'role': 'assistant', 'content': 'A useful limited review.'}])
        result = {'content': [{'type': 'text', 'text': '{"text":"reviewed page"}'}]}
        with mock.patch.object(api_provider, 'MAX_LOOKUP_ROUNDS', 2), mock.patch('manuscript_mcp.call_tool', return_value=result) as tool:
            req = self.ask(snapshotId='snapshot-1', question='请通读文稿')
        self.assertEqual(tool.call_count, 2)
        final = self.created[-1]
        self.assertEqual(final.tool_choice, 'none')
        self.assertIn('partial review', final.messages[-1]['content'])
        self.assertEqual(sum(m['role'] == 'tool' for m in final.messages), 2)
        self.assertIn('尚未确认覆盖整份文稿', self.host.events[-1]['text'])
        self.assertTrue(self.host.events[-1]['text'].endswith('A useful limited review.'))
        self.assertEqual(self.store().page(req)['messages'][-1]['text'], self.host.events[-1]['text'])
        with self.store().database(req) as db:
            self.assertEqual(db.execute('select status from api_turns').fetchone()[0], 'completed')

    def test_project_round_override_replaces_default_and_preserves_final_answer_pass(self):
        self.snapshot_factory([self.read_call(0), self.read_call(1), {'role': 'assistant', 'content': 'Project budget review.'}])
        result = {'content': [{'type': 'text', 'text': '{"text":"reviewed page"}'}]}
        with mock.patch.object(api_provider, 'MAX_LOOKUP_ROUNDS', 1), mock.patch('manuscript_mcp.call_tool', return_value=result) as tool:
            self.ask(snapshotId='snapshot-1', settings={'apiMaxReadRounds': 2})
        self.assertEqual(tool.call_count, 2)
        self.assertEqual(len(self.created), 3)
        self.assertEqual(self.created[-1].tool_choice, 'none')
        self.assertIn('read budget reached', self.created[-1].messages[-1]['content'])

    def test_project_call_override_bounds_batched_reads_independently_of_rounds(self):
        completion = self.read_call(0)
        completion['tool_calls'] += self.read_call(1)['tool_calls']
        self.snapshot_factory([completion, {'role': 'assistant', 'content': 'Bounded review.'}])
        with mock.patch('manuscript_mcp.call_tool', return_value={'content': [{'type': 'text', 'text': '{"text":"first page"}'}]}) as tool:
            self.ask(snapshotId='snapshot-1', settings={'apiMaxReadRounds': 256, 'apiMaxToolCalls': 1})
        self.assertEqual(tool.call_count, 1)
        self.assertEqual(len(self.created), 2)
        self.assertEqual(self.created[-1].tool_choice, 'none')
        results = [m for m in self.created[-1].messages if m['role'] == 'tool']
        self.assertEqual(json.loads(results[-1]['content'])['lookup_stopped'], 'read budget reached')

    def test_project_timeout_caps_entire_request_and_keeps_sixty_second_answer_reserve(self):
        self.host.project_context = SimpleNamespace(get=mock.Mock(return_value={}))
        clock = [0]
        def factory(profile, cancelled):
            connection = APIConnection(profile, cancelled)
            self.created.append(connection)
            def stream(messages, on_delta, tools, tool_choice='auto'):
                if tool_choice == 'auto':
                    self.assertEqual(connection.deadline, 30)
                    clock[0] = 31
                    return self.read_call(0)
                self.assertEqual(connection.deadline, 59)
                on_delta('Time-limited review.')
                return {'role': 'assistant', 'content': 'Time-limited review.'}
            connection.stream = stream
            return connection
        self.backend.connection_factory = factory
        with mock.patch.object(api_provider.time, 'monotonic', side_effect=lambda: clock[0]), mock.patch('manuscript_mcp.call_tool') as tool:
            self.ask(snapshotId='snapshot-1', settings={'apiTimeoutSeconds': 90})
        tool.assert_not_called()
        self.assertEqual(len(self.created), 2)
        self.assertTrue(self.host.events[-1]['text'].endswith('Time-limited review.'))

    def test_selection_only_reply_ignores_stored_project_timeout(self):
        def factory(profile, cancelled):
            connection = APIConnection(profile, cancelled)
            self.created.append(connection)
            def stream(messages, on_delta):
                self.assertEqual(connection.deadline, api_provider.API_TIMEOUT_SECONDS)
                on_delta('Selection-only answer.')
            connection.stream = stream
            return connection
        self.backend.connection_factory = factory
        settings = {'contextMode': 'selection', 'apiTimeoutSeconds': 90, 'apiMaxReadRounds': 1, 'apiMaxToolCalls': 1}
        with mock.patch.object(api_provider.time, 'monotonic', return_value=0):
            self.ask(settings=settings, files=[])
        self.assertEqual(settings['apiTimeoutSeconds'], 90)
        self.assertEqual(len(self.created), 1)
        self.assertEqual(self.host.events[-1]['text'], 'Selection-only answer.')

    def test_backend_rejects_invalid_budget_without_host_validation_or_network(self):
        for key, (minimum, maximum) in api_provider.API_BUDGET_LIMITS.items():
            for invalid in (True, False, None, str(minimum), minimum + 0.5, minimum - 1, maximum + 1):
                with self.subTest(key=key, invalid=invalid), self.assertRaisesRegex(APIError, 'Invalid API reading budget'):
                    self.ask(settings={key: invalid})
        self.assertEqual(self.created, [])
        self.assertEqual(self.host.events, [])
        self.assertIsNone(self.store().read(request()))

    def test_omitted_reading_settings_follow_runtime_defaults(self):
        self.assertEqual(api_provider.api_reading_budget({}, self.profile['id']), (64, 128, 580))
        with mock.patch.object(api_provider, 'MAX_LOOKUP_ROUNDS', 2), mock.patch.object(api_provider, 'MAX_LOOKUP_CALLS', 3):
            self.assertEqual(api_provider.api_reading_budget({}, self.profile['id']), (2, 3, 580))

    def test_repeated_identical_reads_do_not_reread_or_fill_context_and_finish_honestly(self):
        self.snapshot_factory([self.read_call(i, start_line=1) for i in range(4)] + [{'role': 'assistant', 'content': 'Limited findings.'}])
        with mock.patch('manuscript_mcp.call_tool', return_value={'content':[{'type':'text','text':'{"text":"unique source"}'}]}) as tool:
            self.ask(snapshotId='snapshot-1')
        self.assertEqual(tool.call_count, 1)
        self.assertEqual(len(self.created), 5)
        final = self.created[-1]
        self.assertEqual(final.tool_choice, 'none')
        self.assertEqual(json.dumps(final.messages).count('unique source'), 1)
        self.assertEqual(json.loads(final.messages[-2]['content'])['previous_tool_call_id'], 'read-0')
        self.assertIn('repeated reads made no progress', final.messages[-1]['content'])
        self.assertIn('whole-manuscript coverage is unconfirmed', self.host.events[-1]['text'])

    def test_batched_call_budget_answers_each_call_without_exceeding_reads(self):
        completion = self.read_call(0)
        completion['tool_calls'] += self.read_call(1)['tool_calls']
        self.snapshot_factory([completion, {'role':'assistant', 'content':'One page reviewed.'}])
        with mock.patch.object(api_provider, 'MAX_LOOKUP_CALLS', 1), mock.patch('manuscript_mcp.call_tool', return_value={'content':[{'type':'text','text':'{"text":"first page"}'}]}) as tool:
            self.ask(snapshotId='snapshot-1')
        self.assertEqual(tool.call_count, 1)
        messages = self.created[-1].messages
        results = [m for m in messages if m['role'] == 'tool']
        self.assertEqual(len(results), 2)
        self.assertIn('first page', results[0]['content'])
        self.assertEqual(json.loads(results[1]['content'])['lookup_stopped'], 'read budget reached')

    def test_context_budget_retains_prior_pages_and_explicitly_declines_new_result(self):
        self.snapshot_factory([self.read_call(0), self.read_call(1), {'role':'assistant', 'content':'Review of the delivered page.'}])
        result = {'content':[{'type':'text','text':json.dumps({'text':'SOURCE' * 1700})}]}
        with mock.patch.object(self.backend, '_messages', return_value=[{'role':'system','content':'Read source.'},{'role':'user','content':'Review.'}]), mock.patch.object(api_provider, 'MAX_INPUT', 23000), mock.patch.object(api_provider, 'LOOKUP_INPUT_RESERVE', 5000), mock.patch('manuscript_mcp.call_tool', return_value=result):
            self.ask(snapshotId='snapshot-1')
        final = self.created[-1]
        self.assertEqual(final.tool_choice, 'none')
        self.assertIn('context budget reached', final.messages[-1]['content'])
        delivered = [m for m in final.messages if m['role'] == 'tool']
        self.assertIn('SOURCE', delivered[0]['content'])
        self.assertIn('lookup_stopped', delivered[1]['content'])
        self.assertLess(len(json.dumps(final.messages, ensure_ascii=False, separators=(',', ':')).encode()), 23000)

    def test_oversized_tool_message_is_not_replayed_and_reserves_answer(self):
        response = self.read_call(0); response['reasoning_content'] = 'r' * 30000
        self.snapshot_factory([response, {'role':'assistant', 'content':'Insufficient source read.'}])
        with mock.patch.object(self.backend, '_messages', return_value=[{'role':'system','content':'Read source.'},{'role':'user','content':'Review.'}]), mock.patch.object(api_provider, 'MAX_INPUT', 25000), mock.patch('manuscript_mcp.call_tool') as tool:
            self.ask(snapshotId='snapshot-1')
        tool.assert_not_called()
        self.assertEqual(self.created[-1].tool_choice, 'none')
        self.assertNotIn('reasoning_content', json.dumps(self.created[-1].messages))
        self.assertIn('context budget reached', self.created[-1].messages[-1]['content'])

    def test_time_budget_reserves_answer_before_deadline(self):
        self.snapshot_factory([self.read_call(0), {'role':'assistant', 'content':'Time-limited review.'}])
        with mock.patch.object(api_provider.time, 'monotonic', side_effect=[0, 1, 2, 530, 531, 532]), mock.patch('manuscript_mcp.call_tool') as tool:
            self.ask(snapshotId='snapshot-1')
        tool.assert_not_called()
        self.assertEqual(self.created[-1].tool_choice, 'none')
        self.assertIn('time reserved', self.created[-1].messages[-1]['content'])

    def test_helper_lookup_timeout_still_allows_one_reserved_answer_pass(self):
        self.host.project_context=SimpleNamespace(get=mock.Mock(return_value={}))
        def factory(profile,cancelled):
            connection=APIConnection(profile,cancelled);self.created.append(connection)
            def stream(messages,on_delta,tools,tool_choice='auto'):
                connection.messages=messages;connection.tool_choice=tool_choice
                if tool_choice=='auto':
                    # Subtracting monotonic floating-point timestamps can
                    # exceed the exact 520-second bound by a few ulps.
                    self.assertLessEqual(connection.deadline,520 + 1e-6)
                    connection.timed_out=True
                    raise APIError('Controlled lookup deadline')
                on_delta('Useful partial review.')
                return {'role':'assistant','content':'Useful partial review.'}
            connection.stream=stream
            return connection
        self.backend.connection_factory=factory
        self.ask(snapshotId='snapshot-1')
        self.assertEqual(len(self.created),2)
        self.assertEqual(self.created[-1].tool_choice,'none')
        self.assertTrue(self.host.events[-1]['text'].endswith('Useful partial review.'))
        self.assertIn('coverage is unconfirmed',self.host.events[-1]['text'])

    def test_no_final_request_begins_if_notice_delivery_exhausts_deadline(self):
        self.snapshot_factory([self.read_call(0)])
        clock=[0]
        original_emit=self.host.emit
        def emit(identifier,kind,**fields):
            original_emit(identifier,kind,**fields)
            if kind=='delta' and 'coverage is unconfirmed' in fields.get('text',''):
                clock[0]=600
        self.host.emit=emit
        with mock.patch.object(api_provider,'MAX_LOOKUP_ROUNDS',1), mock.patch.object(api_provider.time,'monotonic',side_effect=lambda:clock[0]), mock.patch('manuscript_mcp.call_tool',return_value={'content':[{'type':'text','text':'{"text":"source"}'}]}):
            with self.assertRaisesRegex(APIError,'timed out'):
                self.ask(snapshotId='snapshot-1')
        self.assertEqual(len(self.created),1)

    def test_cancellation_during_lookup_prevents_any_final_network_request(self):
        self.snapshot_factory([self.read_call(0)])
        def stop(*args):
            self.host.cancelled.set()
            return {'content':[{'type':'text','text':'{"text":"last page"}'}]}
        with mock.patch('manuscript_mcp.call_tool',side_effect=stop):
            self.ask(snapshotId='snapshot-1')
        self.assertEqual(len(self.created),1)
        self.assertTrue(self.host.events[-1]['cancelled'])

    def test_terminal_pass_cannot_execute_unexpected_further_tools(self):
        self.snapshot_factory([self.read_call(0), self.read_call(1)])
        with mock.patch.object(api_provider,'MAX_LOOKUP_ROUNDS',1), mock.patch('manuscript_mcp.call_tool', return_value={'content':[{'type':'text','text':'{"text":"source"}'}]}) as tool:
            with self.assertRaisesRegex(APIError,'more source after reading stopped'):
                self.ask(snapshotId='snapshot-1')
        self.assertEqual(tool.call_count,1)
        self.assertIn('whole-manuscript coverage is unconfirmed',self.store().page(request())['messages'][-1]['text'])

    def test_terminal_provider_failure_preserves_notice_and_partial_answer(self):
        self.snapshot_factory([self.read_call(0), APIError('Synthetic final failure')])
        with mock.patch.object(api_provider, 'MAX_LOOKUP_ROUNDS', 1), mock.patch('manuscript_mcp.call_tool', return_value={'content':[{'type':'text','text':'{"text":"source"}'}]}):
            with self.assertRaisesRegex(APIError, 'Synthetic final failure'):
                self.ask(snapshotId='snapshot-1')
        stored = self.store().page(request())['messages'][-1]['text']
        self.assertIn('whole-manuscript coverage is unconfirmed', stored)
        with self.store().database(request()) as db:
            self.assertEqual(db.execute('select status from api_turns').fetchone()[0], 'failed')

    def test_snapshot_scope_denial_prevents_admission_and_network(self):
        self.snapshot_factory([])
        self.host.project_context.get.side_effect = ValueError('wrong scope')
        with self.assertRaisesRegex(APIError, 'another project'):
            self.ask(snapshotId='snapshot-foreign')
        self.assertEqual(self.created, [])
        self.assertFalse(any(event['type'] == 'started' for event in self.host.events))

    def test_real_snapshot_tool_reads_late_source_beyond_inline_transport_limit(self):
        from project_context import ProjectContextStore
        snapshot_store = ProjectContextStore(Path(self.temp.name).resolve() / 'snapshots')
        scope = self.host.store.key(request(providerId=self.profile['id']))
        source = ('Earlier material. ' * 1000) + '\n\\section{Late source}\nPrecise late manuscript statement.\n'
        data = source.encode('utf-8')
        upload = snapshot_store.begin(scope, 'main.tex', [{'path': 'main.tex', 'bytes': len(data),
                                                         'sha256': hashlib.sha256(data).hexdigest()}])
        snapshot_store.chunk(scope, upload, 'main.tex', 0, source)
        snapshot = snapshot_store.commit(scope, upload)
        call = {'id': 'read-late', 'type': 'function', 'function': {'name': 'read_project_file',
                'arguments': json.dumps({'snapshot_id': snapshot, 'path': 'main.tex', 'start_line': 2})}}
        self.snapshot_factory([{'role': 'assistant', 'content': None, 'tool_calls': [call]},
                               {'role': 'assistant', 'content': 'Source read.'}])
        self.host.project_context = snapshot_store
        self.ask(snapshotId=snapshot)
        self.assertNotIn('Precise late manuscript', json.dumps(self.created[0].messages))
        actual = json.loads(self.created[1].messages[-1]['content'])
        self.assertIn('Precise late manuscript statement.', actual['text'])
        self.assertIsNone(actual['next'])

    def test_model_cannot_choose_another_snapshot_or_unapproved_tool(self):
        for name, snapshot in [('read_project_file', 'other-snapshot'), ('exec', 'snapshot-1')]:
            call = {'id': 'one', 'type': 'function', 'function': {'name': name, 'arguments': json.dumps({'snapshot_id': snapshot})}}
            self.snapshot_factory([{'role': 'assistant', 'content': None, 'tool_calls': [call]}])
            with mock.patch('manuscript_mcp.call_tool') as execute:
                with self.assertRaisesRegex(APIError, 'outside this project'):
                    self.ask(snapshotId='snapshot-1')
                execute.assert_not_called()

    def test_tool_failure_and_unsupported_provider_never_fall_back_to_truncated_context(self):
        call = {'id': 'one', 'type': 'function', 'function': {'name': 'read_project_file', 'arguments': '{"snapshot_id":"snapshot-1"}'}}
        self.snapshot_factory([{'role': 'assistant', 'content': None, 'tool_calls': [call]}])
        with mock.patch('manuscript_mcp.call_tool', return_value={'content': [{'type': 'text', 'text': 'missing'}], 'isError': True}):
            with self.assertRaisesRegex(APIError, 'read tool failed'):
                self.ask(snapshotId='snapshot-1')
        self.assertEqual(len(self.created), 1)
        self.created.clear()
        self.snapshot_factory([APIError('Provider does not support function calling')])
        with self.assertRaisesRegex(APIError, 'function calling'):
            self.ask(snapshotId='snapshot-1')
        self.assertEqual(len(self.created), 1)

    def test_provider_project_account_and_codex_histories_are_isolated(self):
        first=self.ask()
        other=self.profiles.save({'name':'Other','baseUrl':'http://localhost:43125','model':'other','apiKey':''})
        other_request=request(providerId=other['id'])
        self.assertEqual(self.backend.store_for(other_request).list(other_request)['conversations'],[])
        self.assertEqual(self.store().list(dict(first,projectId='fedcba987654321001234567'))['conversations'],[])
        self.assertEqual(self.store().list(dict(first,accountId='another-account'))['conversations'],[])
        self.assertEqual(self.host.store.list(first)['conversations'],[])

    def test_new_chat_keeps_prior_conversation_and_quotes(self):
        first=self.ask(answerQuote={'text':'Quoted answer'})
        store=self.store(); previous=store.read(first)
        self.backend.new_chat(dict(first,id='reset',op='new-chat'))
        self.assertIsNone(store.read(first))
        self.assertEqual(store.list(first)['conversations'][0]['id'],previous)
        self.backend.history(dict(first,id='select',op='history-select',conversationId=previous))
        event=self.host.events[-1]
        self.assertEqual(event['conversationId'],previous)
        self.assertEqual(event['messages'][0]['answerQuote']['text'],'Quoted answer')

    def test_stale_thread_or_revision_stops_before_request(self):
        first=self.ask()
        count=len(self.created)
        for fields in [{'expectedConversationId':str(uuid.uuid4())},{'expectedSyncRevision':'0'*64}]:
            with self.assertRaises(APIError): self.ask(**fields)
        self.assertEqual(len(self.created),count)

    def test_failure_keeps_partial_display_and_not_replayed_as_completed_context(self):
        def factory(*args):
            value=ModelConnection(*args); value.fail=True; self.created.append(value); return value
        self.backend.connection_factory=factory
        with self.assertRaisesRegex(APIError,'disconnect'): self.ask(question='Failed question')
        self.assertEqual([m['text'] for m in self.store().page(request())['messages']],['Failed question','API reply'])
        def success(*args):
            value=ModelConnection(*args); self.created.append(value); return value
        self.backend.connection_factory=success
        self.ask(question='New question')
        self.assertEqual([v['role'] for v in self.created[-1].messages],['system','user'])

    def test_cancel_closes_only_api_connection_and_saves_partial(self):
        entered,release=threading.Event(),threading.Event()
        def factory(*args):
            value=ModelConnection(*args); value.entered=entered; value.release=release; self.created.append(value); return value
        self.backend.connection_factory=factory
        thread=threading.Thread(target=self.ask);thread.start()
        self.assertTrue(entered.wait(2))
        self.backend.cancel();thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertTrue(self.created[0].closed)
        self.assertTrue(self.host.events[-1]['cancelled'])
        self.assertEqual(self.host.events[-1]['text'],'API reply')

    def test_status_does_not_infer_or_expose_secret(self):
        value=request(providerId=self.profile['id'],id='status',op='status')
        self.backend.status(value)
        self.assertEqual(len(self.created),1)
        self.assertIsNone(self.created[0].messages)
        self.assertTrue(self.created[0].closed)
        self.assertEqual(self.host.events[-1]['models'][0]['id'],'remote-model')

    def test_model_list_unavailable_keeps_manual_fallback_but_auth_errors_are_not_connected(self):
        value=request(providerId=self.profile['id'],id='status',op='status')
        for error,available in [(APIModelsUnavailable('No model list'),True),(APIAuthenticationError('Check key'),False),(APIError('Network unavailable'),False)]:
            with self.subTest(error=type(error).__name__):
                connection=mock.Mock();connection.models.side_effect=error
                self.backend.connection_factory=lambda *_: connection
                self.backend.status(value)
                event=self.host.events[-1]
                self.assertEqual(event['available'],available)
                self.assertEqual(event['models'][0]['id'] if available else event['models'],'configured-model' if available else [])
                self.assertNotIn('apiKey',json.dumps(event))
                connection.stream.assert_not_called();connection.close.assert_called_once()

    def test_busy_other_client_history_reports_active_and_cannot_start(self):
        first=self.ask(); store=self.store()
        with store.lock(first):
            self.backend.history(dict(first,id='read',op='history-read'))
            self.assertEqual(self.host.events[-1]['remoteState'],'active')
            with self.assertRaisesRegex(Exception,'busy'): self.ask()

    def test_history_budget_keeps_whole_recent_turns_and_explicitly_marks_omission(self):
        store=self.store(); req=request(providerId=self.profile['id'])
        conversation=str(uuid.uuid4());store.write(req,conversation)
        for index in range(4):
            self.backend._record_context(store,req,conversation,str(index),'P'+str(index)+'x'*210000,'A'+str(index),'completed',index)
        messages=self.backend._messages(store,req,conversation,'LATEST')
        self.assertIn('omitted',messages[0]['content'])
        self.assertEqual([m['content'][:2] for m in messages[1:-1]],['P1','A1','P2','A2','P3','A3'])
        self.assertEqual(messages[-1]['content'],'LATEST')


if __name__ == '__main__': unittest.main()
