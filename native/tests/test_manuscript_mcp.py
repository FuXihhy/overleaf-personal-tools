import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from manuscript_mcp import MAX_RESULT_BYTES, TOOLS, call_tool, handle_request
from project_context import ProjectContextStore
from test_project_context import upload


class ManuscriptMCPTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve() / 'context'
        self.store = ProjectContextStore(self.root)

    def tearDown(self):
        self.temporary.cleanup()

    def call(self, name, snapshot_id, **args):
        result = call_tool(self.store, name, dict({'snapshot_id': snapshot_id}, **args))
        self.assertLessEqual(len(json.dumps(result, ensure_ascii=False, separators=(',', ':')).encode('utf-8')), MAX_RESULT_BYTES)
        self.assertFalse(result.get('isError'), result)
        return json.loads(result['content'][0]['text'])

    def test_lists_every_file_beyond_64_with_byte_bounded_pagination(self):
        files = {'main.tex': 'root'}
        files.update({'chapters/%03d-' % i + 'long-name-' * 65 + '.tex': str(i) for i in range(80)})
        snapshot_id = upload(self.store, files)
        paths, offset = [], 0
        while offset is not None:
            data = self.call('list_project_files', snapshot_id, offset=offset, limit=100)
            self.assertEqual(data['total_files'], 81); self.assertEqual(data['root_path'], 'main.tex')
            paths.extend(item['path'] for item in data['files']); offset = data['next_offset']
        self.assertEqual(paths, list(files))

    def test_reads_middle_marker_after_80000_characters_and_returns_resume_position(self):
        content = 'Introduction\n' + 'x' * 91000 + 'DEEP_MIDDLE_MARKER' + '正文' * 9000 + '\nEnd'
        snapshot_id = upload(self.store, {'main.tex': content})
        data = self.call('read_project_file', snapshot_id, path='main.tex', start_line=2, start_character=90990, max_characters=100)
        self.assertIn('DEEP_MIDDLE_MARKER', data['text'])
        self.assertEqual(data['next'], {'line': 2, 'character': 91090})
        self.assertEqual(data['total_lines'], 3)
        self.assertFalse(data['eof'])

    def test_paginating_long_unicode_latex_lines_reconstructs_exact_text_without_loss(self):
        content = '\\alpha' * 2500 + '中文' * 5000 + '\U0001f600' * 3000 + '\r\nsecond\n'
        snapshot_id = upload(self.store, {'main.tex': content})
        reconstructed, cursor, pages = '', {'line': 1, 'character': 0}, 0
        while cursor is not None:
            data = self.call('read_project_file', snapshot_id, path='main.tex', start_line=cursor['line'], start_character=cursor['character'], max_characters=8000)
            self.assertTrue(data['text']); reconstructed += data['text']; cursor = data['next']; pages += 1
            self.assertLess(pages, 100)
        self.assertEqual(reconstructed, content); self.assertGreater(pages, 5)
        self.assertTrue(data['eof'])

    def test_searches_every_file_and_pages_literal_matches_with_unicode_positions(self):
        files = {'main.tex': 'No marker here'}
        files.update({'defs/%03d.sty' % i: '中文 prefix\\cN definition\n末尾' for i in range(70)})
        snapshot_id = upload(self.store, files)
        matches, offset = [], 0
        while offset is not None:
            data = self.call('search_project', snapshot_id, query='\\cN', limit=9, offset=offset)
            matches.extend(data['matches']); offset = data['next_offset']
        self.assertEqual(len(matches), 70)
        self.assertEqual(matches[-1]['path'], 'defs/069.sty')
        self.assertEqual(matches[0]['line'], 1); self.assertEqual(matches[0]['character'], 9)
        exact = self.call('search_project', snapshot_id, query='\\CN', case_sensitive=True)
        self.assertEqual(exact['matches'], [])
        filtered = self.call('list_project_files', snapshot_id, path_prefix='defs/06')
        self.assertEqual(filtered['matching_files'], 10)

    def test_invalid_tools_paths_parameters_and_capabilities_are_errors_not_writes(self):
        snapshot_id = upload(self.store, {'main.tex': 'content'})
        before = sorted(str(path.relative_to(self.root)) for path in self.root.rglob('*'))
        for name, args in [('write_project_file', {'path': 'main.tex'}),
                           ('read_project_file', {'path': '../outside'}),
                           ('read_project_file', {'path': 'main.tex', 'start_line': 2}),
                           ('read_project_file', {'path': 'main.tex', 'start_character': 100}),
                           ('search_project', {'query': ''}),
                           ('list_project_files', {'limit': True}),
                           ('list_project_files', {'unexpected': 1})]:
            result = call_tool(self.store, name, dict({'snapshot_id': snapshot_id}, **args))
            self.assertTrue(result.get('isError'), (name, args, result))
        result = call_tool(self.store, 'list_project_files', {'snapshot_id': '0' * 64})
        self.assertTrue(result.get('isError'))
        self.assertEqual(before, sorted(str(path.relative_to(self.root)) for path in self.root.rglob('*')))
        self.assertTrue(all(tool['annotations']['readOnlyHint'] and not tool['annotations']['openWorldHint'] for tool in TOOLS))

    def test_newline_stdio_handshake_and_deep_read_are_valid_jsonrpc_only(self):
        snapshot_id = upload(self.store, {'main.tex': 'x' * 90000 + 'STDIO_MIDDLE_MARKER' + 'end'})
        requests = [
            {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'test', 'version': '1'}}},
            {'jsonrpc': '2.0', 'method': 'notifications/initialized'},
            {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'},
            {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {'name': 'read_project_file', 'arguments': {'snapshot_id': snapshot_id, 'path': 'main.tex', 'start_character': 89995}}},
        ]
        script = Path(__file__).resolve().parents[1] / 'manuscript_mcp.py'
        process = subprocess.run([sys.executable, str(script), '--root', str(self.root)], input=''.join(json.dumps(item) + '\n' for item in requests), text=True, capture_output=True, timeout=10)
        self.assertEqual(process.returncode, 0, process.stderr)
        responses = [json.loads(line) for line in process.stdout.splitlines()]
        self.assertEqual([item['id'] for item in responses], [1, 2, 3])
        self.assertEqual(responses[0]['result']['protocolVersion'], '2025-06-18')
        self.assertEqual(len(responses[1]['result']['tools']), 3)
        self.assertIn('STDIO_MIDDLE_MARKER', responses[2]['result']['content'][0]['text'])

    def test_jsonrpc_unknown_methods_and_notifications(self):
        self.assertIsNone(handle_request(self.store, {'jsonrpc': '2.0', 'method': 'notifications/initialized'}))
        self.assertEqual(handle_request(self.store, [])['error']['code'], -32600)
        result = handle_request(self.store, {'jsonrpc': '2.0', 'id': 1, 'method': 'filesystem/write'})
        self.assertEqual(result['error']['code'], -32601)


if __name__ == '__main__':
    unittest.main()
