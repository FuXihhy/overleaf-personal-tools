"""Whole-project upload admission and model-facing context regression tests."""
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import codex_host as host

PROJECT = '0123456789abcdef01234567'
ACCOUNT = '111111111111111111111111'


def envelope(op, **fields):
    return dict(version=1, id='source-test', op=op, projectId=PROJECT,
                accountId=ACCOUNT, **fields)


class SourceHostTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.output = io.BytesIO()
        self.host = host.NativeHost(self.output, store=host.SessionStore(Path(self.directory.name)))

    def tearDown(self):
        self.host.close()
        self.directory.cleanup()

    def call(self, operation, **fields):
        start = len(self.output.getvalue())
        self.host.handle(envelope(operation, **fields))
        stream = io.BytesIO(self.output.getvalue()[start:])
        return host.read_message(stream)

    def upload(self, content):
        raw = content.encode('utf-8')
        begin = self.call('source-begin', sourceManifest=[{
            'path': 'chapter.tex', 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(),
        }], rootPath='chapter.tex')
        self.assertEqual(begin['type'], 'source')
        self.assertIn('missingPaths', begin)
        upload = begin['uploadId']
        offset = 0
        for start in range(0, len(content), 20000):
            chunk = content[start:start + 20000]
            event = self.call('source-chunk', uploadId=upload, path='chapter.tex', offset=offset, content=chunk)
            self.assertEqual(event['type'], 'source')
            offset += len(chunk.encode('utf-8'))
        result = self.call('source-commit', uploadId=upload)
        self.assertEqual(result['type'], 'source')
        return result['snapshotId']

    def test_upload_while_reply_active_retains_complete_middle_and_tail(self):
        self.host.busy = True
        text = '前文\\cN\n' * 15000 + 'SCALAR_MIDDLE_SENTINEL\n' + '后文\n' * 15000 + 'SELF_DUAL_TAIL_SENTINEL'
        snapshot_id = self.upload(text)
        request = host.validate_request(envelope('ask', question='Find both sectors', snapshotId=snapshot_id))
        self.host.prepare_project_context(request)
        snapshot = self.host.project_context.get(self.host.store.key(request), snapshot_id)
        self.assertEqual(snapshot['files'][0]['content'], text)
        context = host.manuscript_context(request)
        self.assertEqual(context['project_snapshot']['file_count'], 1)
        self.assertEqual(context['project_files'], [])
        for entry in host.additional_context(request).values():
            self.assertLessEqual(len(entry['value'].encode('utf-8')), 3600)
        self.assertTrue(self.host.busy)

    def test_snapshot_cannot_be_used_for_another_account_or_project(self):
        snapshot_id = self.upload('private manuscript')
        request = host.validate_request(envelope('ask', question='read', snapshotId=snapshot_id))
        request['accountId'] = '222222222222222222222222'
        with self.assertRaises(ValueError):
            self.host.prepare_project_context(request)

    def test_rejects_mixed_protocol_fields_and_missing_root(self):
        for request in [envelope('status', snapshotId='a' * 64),
                        envelope('source-commit', uploadId='11111111-1111-1111-1111-111111111111', question='oops'),
                        envelope('source-begin', rootPath='missing.tex', sourceManifest=[]),
                        envelope('ask', question='read', path='main.tex')]:
            with self.subTest(request=request), self.assertRaises(host.HostError):
                host.validate_request(request)

    def test_missing_reader_fails_before_question_submission(self):
        server = mock.Mock()
        server.request.return_value = {'data': [{'name': 'overleaf_project', 'tools': {}}]}
        with self.assertRaisesRegex(host.HostError, 'No question was sent'):
            self.host.verify_project_reader(server)
        server.request.assert_called_once_with('mcpServerStatus/list', {'serverName': 'overleaf_project', 'detail': 'toolsAndAuthOnly'})

    def test_incremental_begin_and_source_check_work_during_an_active_reply(self):
        snapshot_id = self.upload('exact original text')
        raw = b'exact original text'
        self.host.busy = True
        begin = self.call('source-begin', sourceManifest=[{
            'path': 'chapter.tex', 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(),
        }], rootPath='chapter.tex')
        self.assertEqual(begin['missingPaths'], [])
        committed = self.call('source-commit', uploadId=begin['uploadId'])
        self.assertEqual(committed['snapshotId'], snapshot_id)
        self.assertEqual(self.call('source-check', snapshotId=snapshot_id)['snapshotId'], snapshot_id)
        self.assertTrue(self.host.busy)
        blob = self.host.project_context._content_blob(self.host.store.key(envelope('source-check')), hashlib.sha256(raw).hexdigest())
        blob.unlink()
        failure = self.call('source-check', snapshotId=snapshot_id)
        self.assertEqual((failure['type'], failure['errorCode']), ('error', 'source_unavailable'))
        self.assertEqual(self.upload(raw.decode()), snapshot_id)
        self.assertEqual(self.call('source-check', snapshotId=snapshot_id)['type'], 'source')

    def test_source_check_requires_valid_capability_and_current_scope(self):
        snapshot_id = self.upload('private text')
        for fields in ({}, {'snapshotId': '../bad'}, {'snapshotId': snapshot_id, 'question': 'unrelated'}):
            self.assertEqual(self.call('source-check', **fields)['type'], 'error')
        start = len(self.output.getvalue())
        self.host.handle(dict(envelope('source-check', snapshotId=snapshot_id), accountId='2' * 24))
        rejected = host.read_message(io.BytesIO(self.output.getvalue()[start:]))
        self.assertEqual(rejected['type'], 'error')
        self.assertEqual(rejected['errorCode'], 'source_unavailable')

    def test_missing_snapshot_before_ask_dispatch_is_explicitly_not_accepted(self):
        self.host.ask = mock.Mock()
        self.host.handle(envelope('ask', question='Keep my draft', snapshotId='a' * 64))
        deadline = time.monotonic() + 2
        while not self.output.getvalue() and time.monotonic() < deadline:
            time.sleep(0.005)
        result = host.read_message(io.BytesIO(self.output.getvalue()))
        self.assertEqual(result['type'], 'error')
        self.assertEqual(result['errorCode'], 'source_unavailable')
        self.assertTrue(result['notAccepted'])
        self.host.ask.assert_not_called()
        self.assertIsNone(self.host.server)

    def test_long_manifest_path_response_falls_back_without_truncation(self):
        digest = hashlib.sha256(b'x').hexdigest()
        manifest = [{'path': '章' * 160 + '%04d.tex' % i, 'bytes': 1, 'sha256': digest} for i in range(2000)]
        result = self.call('source-begin', rootPath=manifest[0]['path'], sourceManifest=manifest)
        self.assertEqual(result['type'], 'source')
        self.assertIn('uploadId', result)
        self.assertNotIn('missingPaths', result)

    def test_reader_catalog_requires_all_three_tools(self):
        server = mock.Mock()
        names = ['list_project_files', 'search_project', 'read_project_file']
        server.request.return_value = {'data': [{'name': 'overleaf_project', 'tools': {name: {'name': name} for name in names}}]}
        self.host.verify_project_reader(server, 'thread')

    def test_existing_desktop_cannot_silently_accept_a_snapshot_before_reader_load(self):
        server = mock.Mock(desktop_reader_configured=True)
        ipc = mock.Mock()
        ipc.peer_started_at = 10
        ipc.path.lstat.return_value = SimpleNamespace(st_birthtime=10)
        with mock.patch.object(Path, 'read_text', return_value=json.dumps({'version': 1, 'script': str(Path(host.__file__).resolve().parent / 'manuscript_mcp.py'), 'registeredAt': 20})), mock.patch.object(Path, 'is_symlink', return_value=False):
            with self.assertRaisesRegex(host.HostError, 'Restart Codex Desktop once'):
                self.host.verify_desktop_reader_startup(server, ipc)
        server.request.assert_not_called()

    def test_fresh_desktop_startup_still_requires_configured_reader_catalog(self):
        server = mock.Mock(desktop_reader_configured=True)
        names = ['list_project_files', 'search_project', 'read_project_file']
        server.request.return_value = {'data': [{'name': 'overleaf_project', 'tools': {name: {'name': name} for name in names}}]}
        ipc = mock.Mock()
        ipc.peer_started_at = time.time()
        ipc.path.lstat.return_value = SimpleNamespace(st_birthtime=time.time())
        with mock.patch.object(Path, 'read_text', return_value=json.dumps({'version': 1, 'script': str(Path(host.__file__).resolve().parent / 'manuscript_mcp.py'), 'registeredAt': 20})), mock.patch.object(Path, 'is_symlink', return_value=False):
            self.host.verify_desktop_reader_startup(server, ipc)
        self.assertEqual(server.request.call_args.args[0], 'mcpServerStatus/list')


if __name__ == '__main__':
    unittest.main()
