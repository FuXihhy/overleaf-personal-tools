"""Versioned, same-user Desktop follower transport.

This is a deliberately small adapter for the installed Desktop's private IPC
protocol, not a general IPC bridge. It never starts Desktop, takes ownership,
changes configuration, grants permissions, or retries a submitted turn.
"""
import ctypes
import json
import os
from pathlib import Path
import queue
import re
import socket
import stat
import struct
import sys
import threading
import uuid


UUID_RE = re.compile(r'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$')
MAX_FRAME = 16 * 1024 * 1024
# Desktop's router has a separate fixed 10-second discovery phase before
# it forwards each request. A shorter local budget hides no-owner results.
ROUTER_DISCOVERY_TIMEOUT = 10
VERSIONS = {'initialize': 0, 'thread-owner-discovery': 1,
            'thread-follower-start-turn': 2,
            'thread-follower-steer-turn': 1,
            'thread-follower-read-model-settings': 1,
            'thread-follower-interrupt-turn': 4}


class DesktopIPCError(Exception):
    def __init__(self, message, *, outcome_unknown=False):
        super().__init__(message)
        self.outcome_unknown = outcome_unknown


def _uuid(value):
    return isinstance(value, str) and UUID_RE.fullmatch(value) is not None


def _check_socket(path):
    """Require a private, same-user endpoint; never chmod or create it."""
    if not hasattr(os, 'getuid') or not path.is_absolute():
        raise DesktopIPCError('Desktop coordination is unavailable on this platform.')
    try:
        parent = path.parent.lstat()
        endpoint = path.lstat()
    except OSError as error:
        raise DesktopIPCError('Desktop coordination is not available.') from error
    owner = os.getuid()
    if (not stat.S_ISDIR(parent.st_mode) or parent.st_uid != owner
            or stat.S_IMODE(parent.st_mode) != 0o700
            or not stat.S_ISSOCK(endpoint.st_mode) or endpoint.st_uid != owner
            or stat.S_IMODE(endpoint.st_mode) != 0o600):
        raise DesktopIPCError('Desktop coordination endpoint is not private to this user.')


def _check_peer(sock):
    if hasattr(sock, 'getpeereid'):
        uid, _ = sock.getpeereid()
    elif sys.platform == 'darwin':
        libc = ctypes.CDLL(None, use_errno=True)
        getpeereid = libc.getpeereid
        getpeereid.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint)]
        getpeereid.restype = ctypes.c_int
        uid_out, gid_out = ctypes.c_uint(), ctypes.c_uint()
        if getpeereid(sock.fileno(), ctypes.byref(uid_out), ctypes.byref(gid_out)) != 0:
            raise DesktopIPCError('Could not verify Desktop coordination peer.')
        uid = uid_out.value
    elif hasattr(socket, 'SO_PEERCRED'):
        _, uid, _ = struct.unpack('3i', sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    else:
        return
    if uid != os.getuid():
        raise DesktopIPCError('Desktop coordination peer belongs to another user.')


class DesktopIPC:
    def __init__(self, socket_path=None, timeout=5):
        home = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex')))
        self.path = Path(socket_path) if socket_path else home / 'ipc' / 'ipc.sock'
        self.timeout = timeout
        self.events = queue.Queue(maxsize=256)
        self.client_id = None
        self.conversation_id = None
        self.owner_id = None
        self.supports_untrusted_app_input = False
        self._following = False
        self._closed = threading.Event()
        self._write_lock = threading.Lock()
        self._pending_lock = threading.Lock()
        self._pending = {}
        self._socket = None
        _check_socket(self.path)
        try:
            self._socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self._socket.settimeout(timeout)
            self._socket.connect(str(self.path))
            _check_peer(self._socket)
            self._socket.settimeout(None)
            self._reader = threading.Thread(target=self._read_loop, name='overleaf-desktop-ipc', daemon=True)
            self._reader.start()
            result = self._request('initialize', {'clientType': 'overleaf-personal-tools'})
            if not _uuid(result.get('clientId')):
                raise DesktopIPCError('Desktop coordination returned an invalid client identity.')
            self.client_id = result['clientId']
        except Exception as error:
            self.close()
            if isinstance(error, DesktopIPCError):
                raise
            raise DesktopIPCError('Could not connect to Desktop coordination.') from error

    def discover_owner(self, conversation_id):
        if not _uuid(conversation_id):
            raise DesktopIPCError('Invalid registered conversation identity.')
        if self.conversation_id and conversation_id != self.conversation_id:
            raise DesktopIPCError('A Desktop connection cannot switch conversations.')
        self.conversation_id = conversation_id
        try:
            response = self._request('thread-owner-discovery',
                                     {'hostId': 'local', 'conversationId': conversation_id}, full=True)
        except DesktopIPCError as error:
            if str(error) in ('no-client-found', 'client-disconnected'):
                return None
            raise
        owner = response.get('handledByClientId')
        result = response.get('result', {})
        if not _uuid(owner) or owner == self.client_id:
            raise DesktopIPCError('Desktop coordination returned an invalid owner identity.')
        if result.get('supportsUntrustedAppInput') is not True:
            raise DesktopIPCError('This Desktop version does not support external document context.')
        self.owner_id = owner
        self.supports_untrusted_app_input = True
        return {'clientId': owner, 'supportsUntrustedAppInput': True}

    def follow(self):
        self._require_owner()
        self._following = True
        self._broadcast_following(True)

    def read_model_settings(self):
        self._require_owner()
        result = self._request('thread-follower-read-model-settings',
                               {'conversationId': self.conversation_id}, target=self.owner_id)
        return result.get('settings')

    def start_turn(self, request, context=None, timeout=40):
        self._require_owner()
        if (not isinstance(request, dict) or request.get('threadId') != self.conversation_id
                or not _uuid(request.get('clientUserMessageId'))
                or not isinstance(request.get('input'), list)):
            raise DesktopIPCError('Desktop turn identity or input is invalid.')
        if context is not None and not isinstance(context, dict):
            raise DesktopIPCError('Desktop turn context is invalid.')
        # The caller builds the bounded, read-only Q&A request. Do not replace
        # its nonce, permission policy, or untrusted input with Desktop defaults.
        params = {'conversationId': self.conversation_id,
                  'turnStart': {'request': request, 'context': context or {}}}
        result = self._request('thread-follower-start-turn', params, target=self.owner_id,
                               timeout=timeout, mutation=True)
        started = result.get('result')
        turn_id = started.get('turn', {}).get('id') if isinstance(started, dict) and isinstance(started.get('turn'), dict) else None
        if not isinstance(turn_id, str) or not turn_id or len(turn_id) > 200:
            raise DesktopIPCError('Desktop did not confirm the submitted turn.', outcome_unknown=True)
        return started

    def steer_turn(self, request, restore_message):
        """Use Desktop's current-reply semantics in this exact conversation.

        The owner chooses the current active turn and may retry a changed active
        turn once, just like Desktop itself. It fails if no turn is active; this
        method never supplies toolOutput, starts a turn, or interrupts one.
        """
        self._require_owner()
        if (not isinstance(request, dict) or request.get('threadId') != self.conversation_id
                or not _uuid(request.get('clientUserMessageId'))
                or not isinstance(request.get('input'), list)
                or set(request) - {'threadId', 'clientUserMessageId', 'input', 'additionalContext'}
                or request.get('additionalContext') is not None and not isinstance(request['additionalContext'], dict)
                or not isinstance(restore_message, dict)):
            raise DesktopIPCError('Desktop steering input or identity is invalid.')
        result = self._request('thread-follower-steer-turn',
                               {'conversationId': self.conversation_id,
                                'input': request['input'], 'restoreMessage': restore_message,
                                'clientUserMessageId': request['clientUserMessageId'], 'attachments': [],
                                **({'additionalContext': request['additionalContext']} if request.get('additionalContext') else {})},
                               target=self.owner_id, timeout=35, mutation=True)
        accepted = result.get('result')
        turn_id = accepted.get('turnId') if isinstance(accepted, dict) else None
        if not isinstance(turn_id, str) or not turn_id or len(turn_id) > 200:
            raise DesktopIPCError('Desktop did not confirm the steering message.', outcome_unknown=True)
        return accepted

    def interrupt(self, turn_id):
        self._require_owner()
        if not isinstance(turn_id, str) or not turn_id or len(turn_id) > 200:
            raise DesktopIPCError('A confirmed turn identity is required to stop this reply.')
        return self._request('thread-follower-interrupt-turn',
                             {'conversationId': self.conversation_id, 'mode': 'user-stop',
                              'expectedTurnId': turn_id}, target=self.owner_id, mutation=True)

    def _require_owner(self):
        if not self.owner_id or not self.conversation_id or not self.supports_untrusted_app_input:
            raise DesktopIPCError('Desktop conversation ownership has not been verified.')
        if self._closed.is_set():
            raise DesktopIPCError('Desktop coordination connection has closed.')

    def _broadcast_following(self, following):
        self._write({'type': 'broadcast', 'method': 'thread-stream-following-changed',
                     'version': 1, 'sourceClientId': self.client_id,
                     'targetClientIds': [self.owner_id],
                     'params': {'hostId': 'local', 'conversationId': self.conversation_id,
                                'following': following}})

    def _request(self, method, params, *, target=None, timeout=None, mutation=False, full=False):
        if method not in VERSIONS:
            raise DesktopIPCError('Unsupported Desktop coordination operation.')
        timeout = self.timeout if timeout is None else timeout
        identifier = str(uuid.uuid4())
        message = {'type': 'request', 'requestId': identifier, 'version': VERSIONS[method],
                   'method': method, 'params': params, 'timeoutMs': int(timeout * 1000)}
        if self.client_id:
            message['sourceClientId'] = self.client_id
        if target:
            message['targetClientId'] = target
        response = queue.Queue(maxsize=1)
        with self._pending_lock:
            self._pending[identifier] = response
        attempted = False
        try:
            if self._closed.is_set():
                raise DesktopIPCError('Desktop coordination connection has closed.')
            attempted = True
            self._write(message)
            try:
                value = response.get(timeout=timeout + 0.5 + (0 if method == 'initialize' else ROUTER_DISCOVERY_TIMEOUT))
            except queue.Empty as error:
                raise DesktopIPCError('Desktop coordination timed out.', outcome_unknown=mutation) from error
            if isinstance(value, Exception):
                raise DesktopIPCError(str(value), outcome_unknown=mutation)
            if value.get('resultType') == 'error':
                message = str(value.get('error', 'Desktop coordination failed.'))[:500]
                # A router timeout/owner disconnect can occur after delivery.
                # Even other start errors may follow document-context admission.
                unknown = mutation and message not in ('no-client-found', 'request-version-mismatch', 'no-handler-for-request')
                raise DesktopIPCError(message, outcome_unknown=unknown)
            if (value.get('resultType') != 'success' or value.get('method') != method
                    or target and value.get('handledByClientId') != target
                    or not isinstance(value.get('result'), dict)):
                raise DesktopIPCError('Desktop coordination response did not match the request.', outcome_unknown=mutation)
            return value if full else value['result']
        except OSError as error:
            raise DesktopIPCError('Desktop coordination connection was interrupted.',
                                  outcome_unknown=mutation and attempted) from error
        finally:
            with self._pending_lock:
                self._pending.pop(identifier, None)

    def _write(self, message):
        data = json.dumps(message, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        if not 0 < len(data) <= MAX_FRAME:
            raise DesktopIPCError('Desktop coordination message is too large.')
        with self._write_lock:
            if self._closed.is_set() or not self._socket:
                raise DesktopIPCError('Desktop coordination connection has closed.')
            self._socket.sendall(struct.pack('<I', len(data)) + data)

    def _read_exact(self, size):
        data = bytearray()
        while len(data) < size:
            chunk = self._socket.recv(size - len(data))
            if not chunk:
                raise EOFError()
            data.extend(chunk)
        return bytes(data)

    def _read_loop(self):
        try:
            while not self._closed.is_set():
                size = struct.unpack('<I', self._read_exact(4))[0]
                if not 0 < size <= MAX_FRAME:
                    raise ValueError('Invalid frame size')
                value = json.loads(self._read_exact(size))
                if not isinstance(value, dict):
                    raise ValueError('Invalid envelope')
                self._handle(value)
        except Exception:
            if not self._closed.is_set():
                self._fail('Desktop coordination connection was interrupted.')

    def _handle(self, value):
        kind = value.get('type')
        if kind == 'response':
            with self._pending_lock:
                pending = self._pending.get(value.get('requestId'))
            if pending:
                try:
                    pending.put_nowait(value)
                except queue.Full:
                    pass
            return
        if kind == 'client-discovery-request':
            self._write({'type': 'client-discovery-response', 'requestId': value.get('requestId'),
                         'response': {'canHandle': False}})
            return
        if kind == 'broadcast' and value.get('method') == 'ipc-connection-reset':
            # Account/desktop lifecycle transitions invalidate owner identities.
            self._fail('Codex Desktop changed sessions. Reconnect before sending a new question.')
            return
        if kind != 'broadcast' or not self.owner_id or value.get('sourceClientId') != self.owner_id:
            return
        targets = value.get('targetClientIds')
        if targets is not None and (not isinstance(targets, list) or self.client_id not in targets):
            return
        params = value.get('params')
        if (value.get('method') == 'client-status-changed' and isinstance(params, dict)
                and params.get('clientId') == self.owner_id and params.get('status') == 'disconnected'):
            self._fail('Desktop conversation owner disconnected.')
            return
        if not isinstance(params, dict) or params.get('hostId') != 'local' or params.get('conversationId') != self.conversation_id:
            return
        if value.get('method') == 'thread-stream-following-status-requested' and value.get('version') == 1:
            if self._following:
                self._broadcast_following(True)
            return
        if value.get('method') != 'thread-stream-state-changed' or not self._following:
            return
        if value.get('version') != 11:
            self._fail('Desktop conversation stream protocol changed.')
            return
        change = params.get('change')
        if not isinstance(change, dict) or change.get('type') not in ('snapshot', 'patches'):
            self._fail('Desktop returned an unsupported conversation update.')
            return
        if type(change.get('revision')) is not int or change['revision'] < 0:
            self._fail('Desktop returned an invalid conversation revision.')
            return
        if change['type'] == 'snapshot':
            state = change.get('conversationState')
            if not isinstance(state, dict) or state.get('id') != self.conversation_id:
                self._fail('Desktop returned a different conversation snapshot.')
                return
        elif (type(change.get('baseRevision')) is not int or change['baseRevision'] < 0
              or not isinstance(change.get('patches'), list)):
            self._fail('Desktop returned invalid conversation patches.')
            return
        try:
            self.events.put_nowait(change)
        except queue.Full:
            self._fail('Desktop conversation updates exceeded the bounded buffer.')

    def _fail(self, message):
        self._closed.set()
        with self._pending_lock:
            for pending in self._pending.values():
                try:
                    pending.put_nowait(DesktopIPCError(message))
                except queue.Full:
                    pass
        try:
            self.events.put_nowait({'type': 'connection-error', 'message': message})
        except queue.Full:
            # Never lose the terminal error behind an overflowing stream.
            while True:
                try:
                    self.events.get_nowait()
                except queue.Empty:
                    break
            self.events.put_nowait({'type': 'connection-error', 'message': message})
        if self._socket:
            try:
                self._socket.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self._socket.close()

    def close(self):
        if self._following and not self._closed.is_set():
            try:
                self._broadcast_following(False)
            except (OSError, DesktopIPCError):
                pass
        self._following = False
        self._fail('Desktop coordination connection has closed.')

