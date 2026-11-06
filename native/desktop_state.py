"""Bounded, in-memory follower state for the desktop's version 11 IPC stream.

Snapshots and Immer patches are display state, never executable instructions.
The mirror is needed to preserve array-index semantics; only final-answer text
and a small set of turn identifiers/statuses are exposed, and nothing is saved.
"""
import copy
import json
import re


MAX_STATE_BYTES = 8 * 1024 * 1024
MAX_STATE_NODES = 100000
MAX_STATE_DEPTH = 64
MAX_PATCHES = 10000
MAX_ANSWER_BYTES = 450000
_THREAD = re.compile(r'^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$')
_UNSAFE_KEYS = {'__proto__', 'prototype', 'constructor'}


class DesktopStateError(ValueError):
    """The stream cannot safely be used without a fresh snapshot."""


class DesktopAnswerTooLarge(DesktopStateError):
    """The confirmed turn exceeded the browser's answer boundary."""


def _bounded_json(value):
    """Validate before copying: reject cycles, non-JSON values and huge trees."""
    nodes = 0
    stack = [(value, 0)]
    containers = set()
    while stack:
        item, depth = stack.pop()
        nodes += 1
        if nodes > MAX_STATE_NODES or depth > MAX_STATE_DEPTH:
            raise DesktopStateError('Desktop state exceeds structural limits.')
        if isinstance(item, (dict, list)):
            # Shared references are not JSON, either. Received decoded objects
            # cannot contain them; rejecting them also bounds hostile test input.
            if id(item) in containers:
                raise DesktopStateError('Desktop state is not a JSON tree.')
            containers.add(id(item))
            if isinstance(item, dict):
                if any(not isinstance(key, str) or key in _UNSAFE_KEYS for key in item):
                    raise DesktopStateError('Desktop state has invalid object keys.')
                stack.extend((child, depth + 1) for child in item.values())
            else:
                stack.extend((child, depth + 1) for child in item)
        elif item is not None and not isinstance(item, (str, int, float, bool)):
            raise DesktopStateError('Desktop state is not JSON.')
    try:
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')
    except (ValueError, UnicodeError, TypeError, RecursionError) as error:
        raise DesktopStateError('Desktop state is not valid JSON.') from error
    if len(encoded) > MAX_STATE_BYTES:
        raise DesktopStateError('Desktop state exceeds the size limit.')


def _revision(value):
    return type(value) is int and 0 <= value <= 9007199254740991


def _index(value, length, insertion=False):
    # Immer's array paths use integer indices, not JSON Pointer strings.
    if type(value) is not int or value < 0 or value >= length + int(insertion):
        raise DesktopStateError('Desktop patch has an invalid array index.')
    return value


def _apply_patch(state, patch):
    if not isinstance(patch, dict) or patch.get('op') not in ('add', 'replace', 'remove'):
        raise DesktopStateError('Desktop patch operation is unsupported.')
    path, op = patch.get('path'), patch['op']
    if not isinstance(path, list) or len(path) > MAX_STATE_DEPTH:
        raise DesktopStateError('Desktop patch path is invalid.')
    if any((type(key) is not int and not isinstance(key, str)) or key in _UNSAFE_KEYS for key in path):
        raise DesktopStateError('Desktop patch path contains an invalid key.')
    if op != 'remove' and 'value' not in patch:
        raise DesktopStateError('Desktop patch has no replacement value.')
    if not path:
        if op == 'remove' or not isinstance(patch.get('value'), dict):
            raise DesktopStateError('Desktop patch cannot remove the conversation.')
        return copy.deepcopy(patch['value'])
    target = state
    for key in path[:-1]:
        if isinstance(target, list):
            target = target[_index(key, len(target))]
        elif isinstance(target, dict) and isinstance(key, str) and key in target:
            target = target[key]
        else:
            raise DesktopStateError('Desktop patch path does not exist.')
    key = path[-1]
    if isinstance(target, list):
        index = len(target) if key == '-' and op == 'add' else _index(key, len(target), insertion=op == 'add')
        if op == 'add':
            target.insert(index, copy.deepcopy(patch['value']))
        elif op == 'replace':
            target[index] = copy.deepcopy(patch['value'])
        else:
            target.pop(index)
    elif isinstance(target, dict) and isinstance(key, str):
        # Immer uses assignment/deletion, unlike RFC 6902's stricter replace.
        # A previous undefined-valued object property may be absent from the
        # JSON snapshot even though Immer later emits a replace for that key.
        if op == 'remove':
            target.pop(key, None)
        else:
            target[key] = copy.deepcopy(patch['value'])
    else:
        raise DesktopStateError('Desktop patch parent is invalid.')
    return state


class DesktopThreadState:
    def __init__(self, thread_id):
        if not isinstance(thread_id, str) or not _THREAD.fullmatch(thread_id):
            raise DesktopStateError('Invalid desktop conversation identity.')
        self.thread_id = thread_id
        self.revision = None
        self.needs_snapshot = True
        self._state = None

    def apply(self, change):
        """Atomically accept one snapshot/patch batch; false means re-follow.

        The IPC caller must already have matched hostId, conversationId and the
        expected owner sourceClientId on the broadcast envelope.
        """
        try:
            _bounded_json(change)
            if not isinstance(change, dict) or not _revision(change.get('revision')):
                raise DesktopStateError('Desktop stream revision is invalid.')
            kind = change.get('type')
            if kind == 'snapshot':
                candidate = copy.deepcopy(change.get('conversationState'))
            elif kind == 'patches':
                if self.needs_snapshot or self._state is None or change.get('baseRevision') != self.revision or not _revision(change.get('baseRevision')) or change['revision'] <= self.revision:
                    raise DesktopStateError('Desktop stream requires a fresh snapshot.')
                patches = change.get('patches')
                if not isinstance(patches, list) or len(patches) > MAX_PATCHES:
                    raise DesktopStateError('Desktop patch batch is invalid.')
                candidate = copy.deepcopy(self._state)
                for patch in patches:
                    candidate = _apply_patch(candidate, patch)
            else:
                raise DesktopStateError('Desktop stream change type is unsupported.')
            _bounded_json(candidate)
            if not isinstance(candidate, dict) or candidate.get('id') != self.thread_id:
                raise DesktopStateError('Desktop snapshot has a different conversation identity.')
            self._state = candidate
            self.revision = change['revision']
            self.needs_snapshot = False
            return True
        except (DesktopStateError, TypeError, ValueError, OverflowError, RecursionError):
            self._state = None
            self.revision = None
            self.needs_snapshot = True
            return False

    def _turns(self):
        if self.needs_snapshot or not isinstance(self._state, dict):
            return []
        history = self._state.get('turnHistory')
        if isinstance(history, dict) and history.get('kind') == 'canonical':
            canonical = history.get('history')
            if not isinstance(canonical, dict):
                return []
            entities = canonical.get('entitiesByKey')
            if not isinstance(entities, dict):
                return []
            return [value for value in entities.values() if isinstance(value, dict)]
        values = self._state.get('turns', [])
        return [value for value in values if isinstance(value, dict)] if isinstance(values, list) else []

    @staticmethod
    def _metadata(value):
        identifier = value.get('turnId')
        if not isinstance(identifier, str) or not identifier or len(identifier) > 300:
            return None
        status = value.get('status')
        result = {'id': identifier, 'status': status if status in ('inProgress', 'completed', 'failed', 'interrupted') else 'unknown'}
        params = value.get('params')
        client_id = params.get('clientUserMessageId') if isinstance(params, dict) else None
        if isinstance(client_id, str) and 0 < len(client_id) <= 300:
            result['clientUserMessageId'] = client_id
        return result

    def recent_turns(self, limit=30):
        """Return identifiers/statuses only, never question or assistant text."""
        if type(limit) is not int or not 0 <= limit <= 100:
            raise DesktopStateError('Invalid recent-turn limit.')
        values = [metadata for value in self._turns() if (metadata := self._metadata(value)) is not None]
        return values[-limit:] if limit else []

    def runtime_status(self):
        """Return owner evidence only; absent/partial runtime data is not idle."""
        if self.needs_snapshot or not isinstance(self._state, dict):
            return 'unknown'
        pending = self._state.get('unconfirmedTurnSubmissions', [])
        if not isinstance(pending, list) or any(not isinstance(item, dict) for item in pending):
            return 'unknown'
        if any(item.get('terminal') is not True for item in pending):
            return 'active'
        if any(value.get('status') == 'inProgress' for value in self._turns()):
            return 'active'
        runtime = self._state.get('threadRuntimeStatus')
        kind = runtime.get('type') if isinstance(runtime, dict) else None
        return kind if kind in ('active', 'idle') else 'unknown'

    def turn(self, turn_id):
        if not isinstance(turn_id, str):
            return None
        values = [value for value in self._turns() if value.get('turnId') == turn_id]
        if len(values) != 1:
            return None
        value = values[0]
        result = self._metadata(value)
        if result is None:
            return None
        messages = []
        for item in value.get('items', []) if isinstance(value.get('items'), list) else []:
            if not isinstance(item, dict) or item.get('type') != 'agentMessage' or item.get('phase') not in (None, 'final_answer') or item.get('delivery') == 'async' or not isinstance(item.get('text'), str):
                continue
            text = item['text']
            messages.append({'id': str(item.get('id', 'answer'))[:300], 'type': 'agentMessage', 'text': text})
        answer = '\n\n'.join(item['text'] for item in messages)
        if len(answer.encode('utf-8')) > MAX_ANSWER_BYTES:
            raise DesktopAnswerTooLarge('Desktop answer exceeds the response limit.')
        result['text'] = answer
        result['items'] = messages
        error = value.get('error')
        if isinstance(error, dict) and isinstance(error.get('message'), str):
            result['error'] = {'message': error['message'][:1800]}
        return result
