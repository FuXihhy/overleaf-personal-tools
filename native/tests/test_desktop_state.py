"""Synthetic desktop state only; no app connection, credentials or inference."""
import copy
import importlib.util
from pathlib import Path
import unittest
from unittest import mock


spec = importlib.util.spec_from_file_location('opt_desktop_state', Path(__file__).resolve().parents[1] / 'desktop_state.py')
state_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(state_module)
DesktopThreadState = state_module.DesktopThreadState
THREAD = '11111111-2222-3333-4444-555555555555'
OTHER = '99999999-2222-3333-4444-555555555555'
TURN = 'test-turn'


def turn(identifier=TURN, text='Answer', status='inProgress'):
    return {'turnId': identifier, 'status': status, 'params': {'clientUserMessageId': 'client-123', 'input': [{'text': 'Private question'}]},
            'items': [{'type': 'reasoning', 'text': 'Private reasoning'},
                      {'type': 'agentMessage', 'id': 'commentary', 'phase': 'commentary', 'text': 'Tool planning'},
                      {'type': 'commandExecution', 'output': 'Private command output'},
                      {'type': 'agentMessage', 'id': 'answer', 'phase': 'final_answer', 'text': text}]}


def snapshot(turns=None, revision=1):
    return {'type': 'snapshot', 'revision': revision, 'conversationState': {'id': THREAD, 'turns': [turn()] if turns is None else turns}}


def patches(values, base=1, revision=2, **extra):
    return {'type': 'patches', 'baseRevision': base, 'revision': revision, 'patches': values, **extra}


class DesktopStateTests(unittest.TestCase):
    def test_snapshot_exposes_only_target_final_answer_and_turn_metadata(self):
        state = DesktopThreadState(THREAD)
        self.assertTrue(state.apply(snapshot([turn('other', 'Other answer'), turn()])))
        self.assertEqual(state.turn(TURN), {'id': TURN, 'status': 'inProgress', 'clientUserMessageId': 'client-123',
                                          'text': 'Answer', 'items': [{'id': 'answer', 'type': 'agentMessage', 'text': 'Answer'}]})
        self.assertIsNone(state.turn('missing'))
        metadata = state.recent_turns()
        self.assertEqual(metadata[-1], {'id': TURN, 'status': 'inProgress', 'clientUserMessageId': 'client-123'})
        self.assertNotIn('Private', repr(metadata))
        self.assertNotIn('Answer', repr(metadata))
        self.assertFalse(state.needs_snapshot)

    def test_standard_immer_add_replace_remove_preserve_array_indices(self):
        state = DesktopThreadState(THREAD); self.assertTrue(state.apply(snapshot()))
        change = patches([
            {'op': 'replace', 'path': ['turns', 0, 'items', 3, 'text'], 'value': 'Longer answer'},
            {'op': 'add', 'path': ['turns', 0, 'items', 4], 'value': {'type': 'agentMessage', 'id': 'next', 'text': 'Second paragraph'}},
            {'op': 'remove', 'path': ['turns', 0, 'items', 0]},
            {'op': 'replace', 'path': ['turns', 0, 'status'], 'value': 'completed'},
        ], acceptedTextChanges=[{'key': {'entityKey': 'turn:test-turn'}, 'irrelevantCacheHint': 'Ignored'}])
        self.assertTrue(state.apply(change))
        self.assertEqual(state.turn(TURN)['text'], 'Longer answer\n\nSecond paragraph')
        self.assertEqual(state.turn(TURN)['status'], 'completed')
        self.assertEqual(state.revision, 2)
        self.assertEqual(change['patches'][0]['value'], 'Longer answer')

    def test_canonical_history_entity_patches_and_legacy_shadow_are_supported(self):
        state = DesktopThreadState(THREAD)
        value = snapshot([turn(TURN, 'Legacy shadow')])
        value['conversationState']['turnHistory'] = {'kind': 'canonical', 'history': {
            'entitiesByKey': {'turn:test-turn': turn()}, 'islands': [{'entries': [{'key': 'turn:test-turn', 'value': 'turn:test-turn'}]}]}}
        self.assertTrue(state.apply(value)); self.assertEqual(state.turn(TURN)['text'], 'Answer')
        self.assertTrue(state.apply(patches([{'op': 'replace', 'path': ['turnHistory', 'history', 'entitiesByKey', 'turn:test-turn', 'items', 3, 'text'], 'value': 'Canonical final'}])))
        self.assertEqual(state.turn(TURN)['text'], 'Canonical final')
        self.assertEqual(len(state.recent_turns()), 1)

    def test_mismatched_revision_rejects_until_full_snapshot(self):
        state = DesktopThreadState(THREAD); state.apply(snapshot())
        self.assertFalse(state.apply(patches([], base=4, revision=5)))
        self.assertTrue(state.needs_snapshot); self.assertIsNone(state.turn(TURN)); self.assertIsNone(state.revision)
        self.assertFalse(state.apply(patches([], base=1, revision=2)))
        self.assertTrue(state.apply(snapshot(revision=7)))
        self.assertEqual(state.turn(TURN)['text'], 'Answer')
        for revision in (True, -1, 1.5, '2', 9007199254740992):
            with self.subTest(revision=revision):
                self.assertFalse(state.apply(snapshot(revision=revision)))

    def test_patch_batch_is_atomic_and_invalid_paths_require_snapshot(self):
        malformed = [
            {'op': 'replace', 'path': ['turns', 0, 'missing', 'child'], 'value': 1},
            {'op': 'remove', 'path': ['turns', 99]},
            {'op': 'add', 'path': ['turns', -1], 'value': turn()},
            {'op': 'add', 'path': ['turns', '0'], 'value': turn()},
            {'op': 'copy', 'path': ['turns', 0], 'value': turn()},
            {'op': 'replace', 'path': ['__proto__'], 'value': {}},
            {'op': 'replace', 'path': '/turns/0', 'value': turn()},
            {'op': 'replace', 'path': ['turns', True], 'value': turn()},
            {'op': 'replace', 'path': ['turns', 0, 'items', 3, 'text']},
        ]
        for patch in malformed:
            with self.subTest(patch=patch):
                state = DesktopThreadState(THREAD); state.apply(snapshot())
                self.assertFalse(state.apply(patches([{'op': 'replace', 'path': ['turns', 0, 'status'], 'value': 'completed'}, patch])))
                self.assertIsNone(state.turn(TURN)); self.assertTrue(state.needs_snapshot)

    def test_immer_object_assignment_and_delete_allow_previously_omitted_keys(self):
        state = DesktopThreadState(THREAD); state.apply(snapshot())
        self.assertTrue(state.apply(patches([
            {'op': 'replace', 'path': ['previouslyUndefined'], 'value': True},
            {'op': 'remove', 'path': ['neverSerialized']},
            {'op': 'add', 'path': ['turns', 0, 'items', '-'], 'value': {'type': 'agentMessage', 'text': 'Appended'}},
        ])))
        self.assertEqual(state.turn(TURN)['text'], 'Answer\n\nAppended')

    def test_foreign_conversation_and_root_replacement_cannot_cross_identity(self):
        state = DesktopThreadState(THREAD); state.apply(snapshot())
        foreign = snapshot(); foreign['conversationState']['id'] = OTHER
        self.assertFalse(state.apply(foreign)); self.assertEqual(state.recent_turns(), [])
        state.apply(snapshot())
        self.assertFalse(state.apply(patches([{'op': 'replace', 'path': [], 'value': {'id': OTHER, 'turns': [turn()]}}])))
        state.apply(snapshot())
        replacement = {'id': THREAD, 'turns': [turn(text='Replaced', status='completed')]}
        self.assertTrue(state.apply(patches([{'op': 'replace', 'path': [], 'value': replacement}])))
        self.assertEqual(state.turn(TURN)['text'], 'Replaced')

    def test_external_inputs_and_returned_values_do_not_mutate_mirror(self):
        state = DesktopThreadState(THREAD); data = snapshot(); state.apply(data)
        data['conversationState']['turns'][0]['items'][3]['text'] = 'Changed outside'
        answer = state.turn(TURN); answer['items'][0]['text'] = 'Changed return'
        self.assertEqual(state.turn(TURN)['text'], 'Answer')

    def test_structural_and_size_limits_fail_closed_without_large_allocations(self):
        state = DesktopThreadState(THREAD)
        with mock.patch.object(state_module, 'MAX_STATE_BYTES', 100):
            self.assertFalse(state.apply(snapshot()))
        with mock.patch.object(state_module, 'MAX_STATE_NODES', 5):
            self.assertFalse(state.apply(snapshot()))
        with mock.patch.object(state_module, 'MAX_STATE_DEPTH', 3):
            self.assertFalse(state.apply(snapshot()))
        cycle = snapshot(); cycle['cycle'] = cycle
        self.assertFalse(state.apply(cycle))
        bad = snapshot(); bad['nan'] = float('nan'); self.assertFalse(state.apply(bad))
        bad = snapshot(); bad['text'] = '\ud800'; self.assertFalse(state.apply(bad))
        state.apply(snapshot())
        with mock.patch.object(state_module, 'MAX_PATCHES', 0):
            self.assertFalse(state.apply(patches([{'op': 'add', 'path': ['ignored'], 'value': 1}])))

    def test_unknown_status_duplicate_turns_and_asynchronous_items_do_not_report_done(self):
        state = DesktopThreadState(THREAD); item = turn(status='invented')
        item['items'].append({'type': 'agentMessage', 'delivery': 'async', 'text': 'Unrelated asynchronous notice'})
        state.apply(snapshot([item])); self.assertEqual(state.turn(TURN)['status'], 'unknown')
        self.assertEqual(state.turn(TURN)['text'], 'Answer')
        state.apply(snapshot([turn(), turn()])); self.assertIsNone(state.turn(TURN))

    def test_answer_size_and_metadata_limits(self):
        state = DesktopThreadState(THREAD); state.apply(snapshot([turn(text='😀' * 20)]))
        with mock.patch.object(state_module, 'MAX_ANSWER_BYTES', 50), self.assertRaises(state_module.DesktopStateError):
            state.turn(TURN)
        self.assertEqual(state.recent_turns(0), [])
        with self.assertRaises(state_module.DesktopStateError): state.recent_turns(101)

    def test_only_explicit_owner_idle_without_pending_work_confirms_idle(self):
        state = DesktopThreadState(THREAD)
        self.assertEqual(state.runtime_status(), 'unknown')
        data = snapshot([turn(status='interrupted')]); state.apply(data)
        self.assertEqual(state.runtime_status(), 'unknown')
        data['conversationState']['threadRuntimeStatus'] = {'type': 'idle'}
        state.apply(data); self.assertEqual(state.runtime_status(), 'idle')
        data['conversationState']['unconfirmedTurnSubmissions'] = [{'terminal': False}]
        state.apply(data); self.assertEqual(state.runtime_status(), 'active')
        data['conversationState']['unconfirmedTurnSubmissions'] = [{'terminal': True}]
        state.apply(data); self.assertEqual(state.runtime_status(), 'idle')
        data['conversationState']['turns'].append(turn('other-active'))
        state.apply(data); self.assertEqual(state.runtime_status(), 'active')
        data['conversationState']['turns'].pop()
        data['conversationState']['threadRuntimeStatus'] = {'type': 'notLoaded'}
        state.apply(data); self.assertEqual(state.runtime_status(), 'unknown')


if __name__ == '__main__': unittest.main()
