import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from prompt_display import (parse_generated_question, ANNOTATION_GUIDANCE,
                            LEGACY_ANNOTATION_GUIDANCE, MAX_WRAPPER_CHARACTERS)


def envelope(items=None, question='能不能用 chirality 解释？', guidance=ANNOTATION_GUIDANCE):
    if items is None:
        items = [{'text': r'若 \(C_2\Psi=\chi_2\Psi\)，则成立。',
                  'source': {'messageId': 'message-123', 'startOffset': 12, 'endOffset': 35}}]
    return ('\n# Response annotations:\n' + guidance + '\n<response-annotations>\n'
            + json.dumps(items, ensure_ascii=False) + '\n</response-annotations>\n\n## My request:\n'
            + question + '\n')


class PromptDisplayTests(unittest.TestCase):
    def test_extracts_actual_question_and_exact_formula_quote_without_modifying_original(self):
        original = envelope()
        before = original
        result = parse_generated_question(original)
        self.assertEqual(result, {'text': '能不能用 chirality 解释？', 'answerQuote': {
            'text': r'若 \(C_2\Psi=\chi_2\Psi\)，则成立。', 'messageId': 'message-123'}})
        self.assertEqual(original, before)
        self.assertNotIn('startOffset', json.dumps(result))
        self.assertNotIn('one-based array', json.dumps(result))

    def test_retains_each_selection_and_user_comment_without_mislabeling_different_sources(self):
        result = parse_generated_question(envelope([
            {'text': r'\(x=1\)', 'annotation': '为何？', 'source': {'messageId': 'm1'}},
            {'text': 'second selection', 'annotation': 'more detail', 'source': {'messageId': 'm2'}}]))
        self.assertEqual(result['answerQuote']['text'],
                         'Selection 1:\n\\(x=1\\)\n\nUser comment:\n为何？\n\nSelection 2:\nsecond selection\n\nUser comment:\nmore detail')
        self.assertNotIn('messageId', result['answerQuote'])

    def test_shared_source_identity_is_preserved(self):
        result = parse_generated_question(envelope([
            {'text': 'first', 'source': {'messageId': 'm1'}},
            {'text': 'second', 'source': {'messageId': 'm1'}}]))
        self.assertEqual(result['answerQuote']['messageId'], 'm1')

    def test_preserves_later_user_headings_and_embedded_marker_text(self):
        question = '    indented code\n\nExplain this example:\n## My request:\nkeep both paragraphs\n</response-annotations>\n'
        quoted = 'literal </response-annotations> and ## My request: text'
        result = parse_generated_question(envelope([{'text': quoted}], question))
        self.assertEqual(result['text'], question)
        self.assertEqual(result['answerQuote']['text'], quoted)

    def test_recognizes_exact_legacy_directive_and_request_heading(self):
        value = envelope(guidance=LEGACY_ANNOTATION_GUIDANCE).replace('## My request:\n', '## My request for Codex:\n')
        self.assertIsNotNone(parse_generated_question(value))
        self.assertIsNotNone(parse_generated_question(envelope().lstrip('\n')))
        self.assertIsNotNone(parse_generated_question(envelope().replace('\n', '\r\n')))

    def test_does_not_strip_ordinary_user_headings_or_a_quoted_wrapper_example(self):
        for value in ('Explain ## My request:\nthis heading', 'Before\n## My request:\nAfter',
                      '<response-annotations>[{"text":"x"}]</response-annotations>\n\n## My request:\ny',
                      'Please explain the following format:\n' + envelope(), '```text\n' + envelope() + '```'):
            with self.subTest(value=value[:40]):
                self.assertIsNone(parse_generated_question(value))

    def test_unknown_guidance_or_unhandled_context_does_not_hide_content(self):
        self.assertIsNone(parse_generated_question(envelope(guidance='Unrecognized annotation guidance.')))
        changed = envelope().replace('\n\n## My request:', '\n# Additional project context:\nkeep this\n\n## My request:')
        self.assertIsNone(parse_generated_question(changed))
        self.assertIsNone(parse_generated_question(envelope() + '\0'))

    def test_missing_or_empty_request_and_incomplete_wrappers_remain_unchanged(self):
        for value in (envelope(question=''), envelope().replace('\n</response-annotations>\n', '\n'),
                      envelope().replace('\n<response-annotations>\n', '\n'),
                      envelope().split('## My request:')[0], envelope([])):
            self.assertIsNone(parse_generated_question(value))

    def test_malformed_json_duplicate_fields_nonfinite_and_deep_inputs_do_not_throw(self):
        original = envelope([{'text': 'x'}])
        for raw in ('[{"text":}]', '[{"text":"x","text":"y"}]', '[{"text":"x","source":NaN}]',
                    '[' * 2000 + '0' + ']' * 2000):
            value = original.replace('[{"text": "x"}]', raw)
            self.assertIsNone(parse_generated_question(value))

    def test_invalid_or_unknown_annotation_fields_do_not_get_discarded(self):
        cases = [None, 'x', {'text': ''}, {'text': 1}, {'text': 'x', 'annotation': {'comment': 'y'}},
                 {'text': 'x', 'private': 'do not silently discard'}, {'text': '\0'},
                 {'text': '\ud800'}, {'text': 'x', 'annotation': '\udfff'}]
        for item in cases:
            with self.subTest(item=repr(item)):
                self.assertIsNone(parse_generated_question(envelope([item])))

    def test_invalid_source_provenance_is_not_silently_hidden(self):
        for source in ('bad', {'messageId': 'spaces not valid'}, {'startOffset': True},
                       {'startOffset': -1}, {'startOffset': 10, 'endOffset': 9},
                       {'endOffset': 2**53}, {'unknown': 'keep visible'}):
            self.assertIsNone(parse_generated_question(envelope([{'text': 'x', 'source': source}])))

    def test_large_quote_budget_counts_utf16_and_never_silently_truncates(self):
        self.assertIsNotNone(parse_generated_question(envelope([{'text': '😀' * 32000}])))
        self.assertIsNone(parse_generated_question(envelope([{'text': '😀' * 32001}])))
        self.assertIsNone(parse_generated_question(envelope([{'text': 'x' * 64000, 'annotation': 'too much'}])))
        self.assertIsNone(parse_generated_question(envelope([{'text': 'x'}] * 65)))

    def test_bounds_whole_input_before_json_parsing(self):
        self.assertIsNone(parse_generated_question('x' * (MAX_WRAPPER_CHARACTERS + 1)))
        self.assertIsNone(parse_generated_question(envelope(question='x' * MAX_WRAPPER_CHARACTERS)))
        self.assertIsNone(parse_generated_question(None))


if __name__ == '__main__':
    unittest.main()
