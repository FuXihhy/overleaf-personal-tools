"""Local fake-socket tests. No Desktop account or model is involved."""
import importlib.util
import json
import os
from pathlib import Path
import queue
import socket
import struct
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock


sys.path.insert(0, str(Path(__file__).parents[1]))
spec = importlib.util.spec_from_file_location('desktop_ipc_tested', Path(__file__).parents[1] / 'desktop_ipc.py')
ipc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ipc)
THREAD = '01a18cbd-8295-7070-8093-1902e8a20546'
OTHER = '01a18cbd-8295-7070-8093-1902e8a20547'
CLIENT = '01a18cbd-8295-7070-8093-1902e8a20548'
OWNER = '01a18cbd-8295-7070-8093-1902e8a20549'
NONCE = '01a18cbd-8295-7070-8093-1902e8a20550'


class FakeRouter:
    def __init__(self, path):
        self.path = path
        self.server = socket.socket(socket.AF_INET if os.name == 'nt' else socket.AF_UNIX)
        self.server.bind(('127.0.0.1', 0) if os.name == 'nt' else str(path))
        if os.name != 'nt': os.chmod(path, 0o600)
        self.server.listen(1)
        self.peer = None; self.received = []; self.handler = None; self.write_lock = threading.Lock()
        self.worker = threading.Thread(target=self.run, daemon=True); self.worker.start()
    def send(self, value):
        raw = json.dumps(value).encode()
        with self.write_lock: self.peer.sendall(struct.pack('<I', len(raw)) + raw)
    def success(self, req, result, **fields):
        self.send(dict(type='response', requestId=req['requestId'], resultType='success',
                       method=req['method'], handledByClientId=OWNER, result=result, **fields))
    def error(self, req, message):
        self.send(dict(type='response', requestId=req['requestId'], resultType='error', error=message))
    def run(self):
        try:
            self.peer, _ = self.server.accept()
            def read(n):
                raw = b''
                while len(raw) < n:
                    value = self.peer.recv(n - len(raw))
                    if not value: raise EOFError()
                    raw += value
                return raw
            while True:
                size = struct.unpack('<I', read(4))[0]; value = json.loads(read(size)); self.received.append(value)
                if self.handler and self.handler(value): continue
                if value.get('type') != 'request': continue
                method = value['method']
                if method == 'initialize': self.success(value, {'clientId': CLIENT})
                elif method == 'thread-owner-discovery': self.success(value, {'supportsUntrustedAppInput': True})
                elif method == 'thread-follower-start-turn': self.success(value, {'result': {'turn': {'id': 'turn-test', 'status': 'inProgress'}}})
                elif method == 'thread-follower-steer-turn': self.success(value, {'result': {'turnId': 'turn-test'}})
                elif method == 'thread-follower-interrupt-turn': self.success(value, {'ok': True, 'interruptedTurnId': value['params']['expectedTurnId']})
                elif method == 'thread-follower-read-model-settings': self.success(value, {'settings': {'model': 'test-model'}})
        except (OSError, EOFError, ValueError): pass
        finally:
            if self.peer: self.peer.close()
    def close(self):
        if self.peer:
            try: self.peer.shutdown(socket.SHUT_RDWR)
            except OSError: pass
            self.peer.close()
        self.server.close(); self.worker.join(1)


class DesktopIPCTests(unittest.TestCase):
    def setUp(self):
        self.budget_patch = mock.patch.object(ipc, 'ROUTER_DISCOVERY_TIMEOUT', 0.05); self.budget_patch.start()
        self.temp = tempfile.TemporaryDirectory(); self.path = Path(self.temp.name).resolve() / 'ipc.sock'
        os.chmod(self.temp.name, 0o700); self.router = FakeRouter(self.path); self.client = None
        self.pipe_patch = None
        if os.name == 'nt':
            def connect_pipe(path, timeout=5):
                sock = socket.create_connection(self.router.server.getsockname(), timeout)
                try:
                    ipc._check_peer(sock)
                except Exception:
                    sock.close(); raise
                sock.settimeout(None)
                class Transport:
                    peer = {'created_at': 1.0}
                    def __getattr__(self, name): return getattr(sock, name)
                return Transport()
            self.pipe_patch = mock.patch.object(ipc, 'NamedPipeSocket', side_effect=connect_pipe)
            self.pipe_patch.start()
    def tearDown(self):
        if self.client: self.client.close()
        self.router.close(); self.temp.cleanup(); self.budget_patch.stop()
        if self.pipe_patch: self.pipe_patch.stop()
    def connect(self):
        self.client = ipc.DesktopIPC(self.path, timeout=1)
        self.client.discover_owner(THREAD)
        return self.client
    def wait_received(self, method):
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            values = [v for v in self.router.received if v.get('method') == method]
            if values: return values
            time.sleep(0.005)
        self.fail('Expected fake router operation: ' + method)
    def request(self):
        return {'threadId': THREAD, 'clientUserMessageId': NONCE,
                'input': [{'type': 'text', 'text': 'Synthetic question', 'text_elements': []}],
                'approvalPolicy': 'never', 'sandboxPolicy': {'type': 'readOnly', 'networkAccess': False}}
    def event(self, **fields):
        value = {'type': 'broadcast', 'method': 'thread-stream-state-changed', 'version': 11,
                 'sourceClientId': OWNER, 'targetClientIds': [CLIENT],
                 'params': {'hostId': 'local', 'conversationId': THREAD,
                            'change': {'type': 'snapshot', 'revision': 1, 'conversationState': {'id': THREAD}}}}
        value.update(fields); return value

    def test_identity_capability_versions_and_matching_thread_are_required(self):
        client = self.connect()
        self.assertEqual(client.owner_id, OWNER)
        initialize, discovery = self.router.received[:2]
        self.assertEqual(initialize['params'], {'clientType': 'overleaf-personal-tools'})
        self.assertEqual(initialize['version'], 0); self.assertEqual(discovery['version'], 1)
        self.assertEqual(discovery['params'], {'hostId': 'local', 'conversationId': THREAD})
        with self.assertRaises(ipc.DesktopIPCError): client.discover_owner(OTHER)
        with self.assertRaises(ipc.DesktopIPCError): client.start_turn(dict(self.request(), threadId=OTHER))
        with self.assertRaises(ipc.DesktopIPCError): client.start_turn(dict(self.request(), clientUserMessageId='bad'))
        self.assertFalse(any(x.get('method') == 'thread-follower-start-turn' for x in self.router.received))

    def test_private_socket_and_directory_permissions_are_not_relaxed(self):
        if os.name == 'nt':
            # Windows has no Unix socket permission bits. The production pipe
            # adapter rejects custom/remote endpoints before opening a handle;
            # actual token/package validation is covered by test_windows_desktop.
            from windows_desktop import NamedPipeSocket, WindowsDesktopError
            for endpoint in (str(self.path), r'\\other-host\pipe\codex-ipc', r'\\.\pipe\other'):
                with self.assertRaises(WindowsDesktopError): NamedPipeSocket(endpoint)
            return
        os.chmod(self.path, 0o666)
        with self.assertRaises(ipc.DesktopIPCError): ipc.DesktopIPC(self.path)
        self.assertEqual(os.stat(self.path).st_mode & 0o777, 0o666)
        os.chmod(self.path, 0o600); os.chmod(self.temp.name, 0o755)
        with self.assertRaises(ipc.DesktopIPCError): ipc.DesktopIPC(self.path)
        os.chmod(self.temp.name, 0o700)
        alias = Path(self.temp.name).resolve() / 'alias.sock'; alias.symlink_to(self.path)
        with self.assertRaises(ipc.DesktopIPCError): ipc.DesktopIPC(alias)

    def test_capability_absence_fails_without_follow_or_send(self):
        def handle(value):
            if value.get('method') == 'thread-owner-discovery':
                self.router.success(value, {}); return True
        self.router.handler = handle; self.client = ipc.DesktopIPC(self.path)
        with self.assertRaisesRegex(ipc.DesktopIPCError, 'external document context'): self.client.discover_owner(THREAD)
        with self.assertRaises(ipc.DesktopIPCError): self.client.follow()
        with self.assertRaises(ipc.DesktopIPCError): self.client.start_turn(self.request())

    def test_no_owner_is_distinct_from_unsupported_version(self):
        def handle(value):
            if value.get('method') == 'thread-owner-discovery':
                self.router.error(value, 'no-client-found'); return True
        self.router.handler = handle; self.client = ipc.DesktopIPC(self.path)
        self.assertIsNone(self.client.discover_owner(THREAD)); self.assertIsNone(self.client.owner_id)

    def test_start_preserves_nonce_readonly_policy_context_and_unwraps_confirmation(self):
        client = self.connect(); context = {'inheritThreadSettings': False, 'responseItems': [{'type': 'function_call_output', 'call_id': 'synthetic', 'output': 'Quoted source'}]}
        result = client.start_turn(self.request(), context)
        self.assertEqual(result['turn']['id'], 'turn-test')
        value = self.wait_received('thread-follower-start-turn')[0]
        self.assertEqual(value['version'], 2); self.assertNotIn('hostId', value)
        self.assertEqual(value['targetClientId'], OWNER)
        self.assertEqual(value['params'], {'conversationId': THREAD, 'turnStart': {'request': self.request(), 'context': context}})
        self.assertEqual(client.read_model_settings(), {'model': 'test-model'})

    def test_follow_filters_other_conversations_owners_targets_and_replies_to_discovery(self):
        client = self.connect(); client.follow()
        self.assertTrue(self.wait_received('thread-stream-following-changed')[0]['params']['following'])
        self.router.send(self.event(sourceClientId=OTHER))
        self.router.send(self.event(targetClientIds=[OTHER]))
        self.router.send(self.event(params={'hostId': 'local', 'conversationId': OTHER, 'change': {'type': 'snapshot'}}))
        self.router.send({'type': 'client-discovery-request', 'requestId': 'synthetic-discovery', 'request': {}})
        self.router.send(self.event())
        event = client.events.get(timeout=1)
        self.assertEqual(event['revision'], 1); self.assertTrue(client.events.empty())
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline and not any(v.get('type') == 'client-discovery-response' for v in self.router.received): time.sleep(0.005)
        self.assertTrue(any(v.get('response') == {'canHandle': False} for v in self.router.received))
        client.close()
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline and len([v for v in self.router.received if v.get('method') == 'thread-stream-following-changed']) < 2: time.sleep(0.005)
        self.assertFalse([v for v in self.router.received if v.get('method') == 'thread-stream-following-changed'][-1]['params']['following'])

    def test_stream_version_change_fails_closed(self):
        client = self.connect(); client.follow(); self.router.send(self.event(version=12))
        self.assertEqual(client.events.get(timeout=1)['type'], 'connection-error')
        with self.assertRaises(ipc.DesktopIPCError): client.start_turn(self.request())

    def test_wrong_snapshot_identity_fails_closed(self):
        client = self.connect(); client.follow()
        value = self.event(); value['params']['change']['conversationState']['id'] = OTHER
        self.router.send(value)
        self.assertEqual(client.events.get(timeout=1)['type'], 'connection-error')

    def test_owner_disconnect_retires_follower_even_when_router_stays_alive(self):
        client = self.connect(); client.follow()
        self.router.send({'type': 'broadcast', 'method': 'client-status-changed', 'sourceClientId': OWNER,
                          'version': 0, 'params': {'clientId': OWNER, 'status': 'disconnected'}})
        self.assertIn('owner disconnected', client.events.get(timeout=1)['message'])
        with self.assertRaises(ipc.DesktopIPCError): client.read_model_settings()

    def test_peer_uid_mismatch_rejects_before_initialization(self):
        with mock.patch.object(ipc, '_check_peer', side_effect=ipc.DesktopIPCError('another user')):
            with self.assertRaisesRegex(ipc.DesktopIPCError, 'another user'): ipc.DesktopIPC(self.path)
        self.assertEqual(self.router.received, [])

    def test_cancel_remains_responsive_while_start_confirmation_is_pending(self):
        self.router.handler = lambda value: value.get('method') == 'thread-follower-start-turn'
        client = self.connect(); results = []
        def start():
            try: client.start_turn(self.request(), timeout=0.05)
            except ipc.DesktopIPCError as error: results.append(error.outcome_unknown)
        worker = threading.Thread(target=start); worker.start(); self.wait_received('thread-follower-start-turn')
        self.assertTrue(client.interrupt('turn-test')['ok'])
        worker.join(2); self.assertEqual(results, [True])

    def test_steer_uses_current_reply_api_without_new_turn_or_tool_output(self):
        client = self.connect()
        result = client.steer_turn({'threadId': THREAD, 'clientUserMessageId': NONCE,
                                    'input': [{'type':'text','text':'More context'}],
                                    'additionalContext':{'overleaf':{'kind':'untrusted','value':'context data'}}}, {'id':NONCE,'context':{}})
        self.assertEqual(result['turnId'], 'turn-test')
        value = self.wait_received('thread-follower-steer-turn')[0]
        self.assertEqual(value['version'], 1)
        self.assertEqual(value['targetClientId'], OWNER)
        self.assertNotIn('toolOutput', value['params'])
        self.assertNotIn('turnStart', value['params'])
        self.assertEqual(value['params']['conversationId'], THREAD)
        self.assertEqual(value['params']['additionalContext']['overleaf']['kind'], 'untrusted')
        self.assertFalse(any(v.get('method') in ('thread-follower-start-turn','thread-follower-interrupt-turn') for v in self.router.received))

    def test_cancel_requires_exact_confirmed_turn_and_targets_owner(self):
        client = self.connect()
        with self.assertRaises(ipc.DesktopIPCError): client.interrupt('')
        result = client.interrupt('turn-test'); self.assertEqual(result['interruptedTurnId'], 'turn-test')
        value = self.wait_received('thread-follower-interrupt-turn')[0]
        self.assertEqual(value['version'], 4); self.assertNotIn('hostId', value)
        self.assertEqual(value['params'], {'conversationId': THREAD, 'mode': 'user-stop', 'expectedTurnId': 'turn-test'})

    def test_timed_out_start_is_unknown_and_never_retried(self):
        self.router.handler = lambda value: value.get('method') == 'thread-follower-start-turn'
        client = self.connect()
        with self.assertRaises(ipc.DesktopIPCError) as caught: client.start_turn(self.request(), timeout=0.02)
        self.assertTrue(caught.exception.outcome_unknown)
        self.assertEqual(len(self.wait_received('thread-follower-start-turn')), 1)

    def test_router_discovery_time_is_added_before_response_timeout(self):
        client = self.connect()
        def delayed(value):
            if value.get('method') == 'thread-follower-read-model-settings':
                threading.Timer(0.65, lambda: self.router.success(value, {'settings': {'model': 'test'}})).start()
                return True
        self.router.handler = delayed
        with mock.patch.object(ipc, 'ROUTER_DISCOVERY_TIMEOUT', 0.3):
            result = client._request('thread-follower-read-model-settings', {'conversationId': THREAD}, target=OWNER, timeout=0.05)
        self.assertEqual(result['settings']['model'], 'test')
        self.assertEqual(self.wait_received('thread-follower-read-model-settings')[0]['timeoutMs'], 50)

    def test_session_reset_invalidates_owner_and_unblocks_waiters(self):
        client = self.connect()
        self.router.send({'type': 'broadcast', 'method': 'ipc-connection-reset', 'version': 1,
                          'sourceClientId': OWNER, 'params': {}})
        self.assertIn('changed sessions', client.events.get(timeout=1)['message'])
        with self.assertRaises(ipc.DesktopIPCError):client.read_model_settings()

    def test_disconnect_after_delivery_is_unknown(self):
        def handle(value):
            if value.get('method') == 'thread-follower-start-turn':
                self.router.peer.shutdown(socket.SHUT_RDWR); return True
        self.router.handler = handle; client = self.connect()
        with self.assertRaises(ipc.DesktopIPCError) as caught: client.start_turn(self.request())
        self.assertTrue(caught.exception.outcome_unknown)
        self.assertEqual(len(self.wait_received('thread-follower-start-turn')), 1)

    def test_pre_dispatch_rejection_is_not_reported_as_accepted(self):
        def handle(value):
            if value.get('method') == 'thread-follower-start-turn':
                self.router.error(value, 'request-version-mismatch'); return True
        self.router.handler = handle; client = self.connect()
        with self.assertRaises(ipc.DesktopIPCError) as caught: client.start_turn(self.request())
        self.assertFalse(caught.exception.outcome_unknown)

    def test_wrong_owner_confirmation_is_unknown_not_safe_to_retry(self):
        def handle(value):
            if value.get('method') == 'thread-follower-start-turn':
                self.router.send(dict(type='response', requestId=value['requestId'], resultType='success', method=value['method'], handledByClientId=OTHER, result={'result': {'turn': {'id': 'turn-test'}}})); return True
        self.router.handler = handle; client = self.connect()
        with self.assertRaises(ipc.DesktopIPCError) as caught: client.start_turn(self.request())
        self.assertTrue(caught.exception.outcome_unknown)

