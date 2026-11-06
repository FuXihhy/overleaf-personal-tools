import hashlib
import json
import unittest

from context_transport import MAX_VALUE_BYTES, PREFIX, build_additional_context

PROJECT = 'a' * 24


class ContextTransportTests(unittest.TestCase):
    def test_small_context_preserves_existing_untrusted_contract(self):
        source = {'project_id': PROJECT, 'editor_selection': None, 'project_files': []}
        entry = next(iter(build_additional_context(source).values()))
        self.assertEqual(entry['kind'], 'untrusted')
        self.assertEqual(entry['name'], 'overleaf_project_context')
        self.assertEqual(json.loads(entry['value'][len(PREFIX):]), source)

    def test_all_large_context_fields_survive_multibyte_and_escape_boundaries(self):
        source = {'project_id': PROJECT, 'editor_selection': {'text': '公式😀\\\\"\n' * 4000},
                  'assistant_answer_quote': {'text': '引用' * 5000},
                  'project_files': [{'path': 'Localization.tex', 'content': 'begin\n' + 'middle \\cN ' * 10000 + '\nend'}],
                  'project_snapshot': {'snapshot_id': 'snapshot-1'}}
        fragments = build_additional_context(source)
        manifest = json.loads(fragments.pop('overleaf_manuscript_' + PROJECT)['value'])
        values = []
        for key, entry in fragments.items():
            self.assertEqual(entry['kind'], 'untrusted')
            self.assertRegex(key, r'^overleaf_manuscript_[a-f0-9]{24}_\d{5}$')
            self.assertRegex(entry['name'], r'^[a-z][a-z0-9_]{0,63}$')
            self.assertLessEqual(len(entry['value'].encode('utf-8')), MAX_VALUE_BYTES)
            values.append(json.loads(entry['value']))
        self.assertGreater(len(values), 10)
        self.assertEqual([v['part'] for v in values], list(range(1, len(values) + 1)))
        self.assertTrue(all(v['parts'] == len(values) for v in values))
        context_id = hashlib.sha256(json.dumps(source, ensure_ascii=False, separators=(',', ':')).encode('utf-8')).hexdigest()
        self.assertEqual(manifest, {'format': 'overleaf-manuscript-manifest-v1', 'project_id': PROJECT,
                                    'context_id': context_id, 'parts': len(values)})
        self.assertTrue(all(v['context_id'] == context_id for v in values))
        self.assertEqual(json.loads(''.join(v['text'] for v in values)), source)

    def test_reused_slots_carry_distinct_context_ids_after_context_shrinks(self):
        first = build_additional_context({'project_id': PROJECT, 'editor_selection': {'text': 'first' * 4000}})
        second = build_additional_context({'project_id': PROJECT, 'editor_selection': {'text': 'second' * 1000}})
        self.assertTrue(set(second).issubset(first))
        self.assertLess(len(second), len(first))
        self.assertNotEqual(json.loads(next(iter(first.values()))['value'])['context_id'],
                            json.loads(next(iter(second.values()))['value'])['context_id'])

    def test_byte_limit_is_not_character_limit(self):
        source = {'project_id': PROJECT, 'project_files': [{'path': 'a.tex', 'content': '数' * 1400}]}
        self.assertGreater(len(build_additional_context(source)), 1)

    def test_current_base_slot_supersedes_retained_old_large_context(self):
        old = build_additional_context({'project_id': PROJECT, 'editor_selection': {'text': 'old' * 2000}})
        source = {'project_id': PROJECT, 'editor_selection': None, 'project_files': []}
        current = build_additional_context(source)
        merged = dict(old, **current)
        self.assertGreater(len(merged), len(current))
        base = merged['overleaf_manuscript_' + PROJECT]['value']
        self.assertEqual(json.loads(base[len(PREFIX):]), source)

    def test_invalid_identity_fails_before_creating_context_names(self):
        for value in [{}, {'project_id': '../other'}, None]:
            with self.assertRaises(ValueError): build_additional_context(value)


if __name__ == '__main__': unittest.main()
