"""Two-turn live Windows acceptance through the installed Native Messaging host.

Explicitly run with --allow-live-turns. Uses the existing local Codex login, fixed
gpt-6-luna/low, a fresh synthetic account/project scope, and at most two turns.
It never retries a question or reads a thread not created by this invocation.
Only synthetic sentinels and sanitized protocol metadata enter the report;
credentials, account identities, reasoning and arbitrary model output do not.
This exercises the native launcher, NOT Chrome or an Overleaf page.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import queue
import struct
import subprocess
import sys
import threading
import time
import uuid


ROOT = Path(__file__).resolve().parents[1]
MODEL = 'gpt-6-luna'
EFFORT = 'low'
OUTPUT = ROOT / 'artifacts' / 'windows-live-acceptance.json'
TERMINAL = {'source', 'status', 'history', 'done', 'error'}


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def save(report):
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    temporary = OUTPUT.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    os.replace(temporary, OUTPUT)


class InstalledHost:
    def __init__(self, manifest):
        self.events = queue.Queue()
        self.closed = False
        self.process = subprocess.Popen(
            [os.environ['COMSPEC'], '/d', '/c', manifest['path'],
             manifest['allowed_origins'][0], '--parent-window=0'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW)
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _exact(self, count):
        data = bytearray()
        while len(data) < count:
            piece = self.process.stdout.read(count - len(data))
            if not piece:
                raise EOFError('Installed helper closed its Native Messaging stream.')
            data.extend(piece)
        return bytes(data)

    def _read(self):
        try:
            while not self.closed:
                size = struct.unpack('<I', self._exact(4))[0]
                if not 0 < size <= 1048576:
                    raise ValueError('Installed helper sent an invalid native frame length.')
                self.events.put(json.loads(self._exact(size)))
        except Exception as error:
            if not self.closed:
                self.events.put(error)

    def call(self, request, timeout=70):
        raw = json.dumps(request, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        self.process.stdin.write(struct.pack('<I', len(raw)) + raw)
        self.process.stdin.flush()
        started = time.monotonic()
        records = []
        while True:
            remaining = timeout - (time.monotonic() - started)
            if remaining <= 0:
                raise TimeoutError('No terminal native response; the request will not be resent.')
            value = self.events.get(timeout=remaining)
            if isinstance(value, Exception):
                raise value
            if value.get('id') != request['id']:
                raise RuntimeError('Unexpected response identity in isolated acceptance helper.')
            records.append((round(time.monotonic() - started, 3), value))
            if value.get('type') in TERMINAL:
                return value, records

    def close(self):
        if self.closed:
            return self.process.returncode
        self.closed = True
        self.process.stdin.close()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=3)
        self.reader.join(timeout=2)
        self.process.stdout.close()
        return self.process.returncode


def require_success(event, kind):
    if event.get('type') != kind:
        # NativeHost sanitizes these diagnostics; do not dump raw messages,
        # response payloads, model output or account data on a failure.
        if event.get('type') == 'error':
            raise RuntimeError('Native request rejected: ' + str(event.get('message', 'unknown failure'))[:1600])
        raise RuntimeError('Expected %s, received %s.' % (kind, event.get('type')))


def turn_summary(event, records, sentinels):
    answer = event.get('text', '')
    return {
        'terminal_type': event.get('type'),
        'thread_id': event.get('threadId'),
        'cancelled': event.get('cancelled', False),
        'answer_sha256': digest(answer),
        'answer_characters': len(answer),
        'observed_sentinels': [value for value in sentinels if value in answer],
        'event_counts': dict(Counter(value.get('type') for _, value in records)),
        'timeline': [{'seconds': seconds, 'type': value.get('type'),
                      **({'characters': len(value.get('text', ''))} if value.get('type') == 'delta' else {})}
                     for seconds, value in records],
    }


def canonical_audit(helper_dir, thread, expected_snapshot, known_paths):
    sys.path.insert(0, str(helper_dir))
    import codex_host
    server = codex_host.AppServer(helper_dir, deadline=time.monotonic() + 45)
    try:
        page = server.request('thread/turns/list', {'threadId': thread, 'itemsView': 'full', 'sortDirection': 'asc', 'limit': 3}, timeout=30)
        audit = []
        for turn in page.get('data', []):
            tools = []
            for item in turn.get('items', []):
                if item.get('type') != 'mcpToolCall':
                    continue
                params = item.get('arguments', {})
                if isinstance(params, str):
                    try: params = json.loads(params)
                    except ValueError: params = {}
                result = {'server': item.get('server'), 'tool': item.get('tool'), 'status': item.get('status')}
                if isinstance(params, dict):
                    if params.get('path') in known_paths:
                        result['path'] = params['path']
                    supplied = params.get('snapshot_id', '')
                    if isinstance(supplied, str):
                        result['snapshot_id_length'] = len(supplied)
                        result['snapshot_id_matches_expected'] = supplied == expected_snapshot
                tools.append(result)
            audit.append({'turn_id': turn.get('id'), 'status': turn.get('status'),
                          'item_types': dict(Counter(i.get('type') for i in turn.get('items', []))), 'mcp_tools': tools})
        return audit
    finally:
        server.close()


def continue_confirmed_failure(manifest, report):
    """One explicitly authorized correction after a completed model typo.

    This is not a retry of an uncertain request. Verify canonical completion
    and the rejected 63-character arguments before spending the final turn.
    """
    first = report.get('first_turn', {})
    if report.get('model_turns_attempted') != 1 or first.get('terminal_type') != 'done' or first.get('cancelled'):
        raise RuntimeError('Only one confirmed completed first turn may enter this correction path.')
    thread = first['thread_id']
    helper_dir = Path(manifest['path']).parent
    paths = {entry['path'] for entry in report['source_files']}
    audit = canonical_audit(helper_dir, thread, report['snapshot_id'], paths)
    if (len(audit) != 1 or audit[0]['status'] != 'completed'
            or len(audit[0]['mcp_tools']) != 2
            or any(t['status'] != 'failed' or t.get('snapshot_id_length') != 63 or t.get('snapshot_id_matches_expected') for t in audit[0]['mcp_tools'])):
        raise RuntimeError('Canonical evidence does not confirm the reviewed snapshot-ID typo; no correction was sent.')
    report['initial_failure'] = report.pop('failure', None)
    report['first_turn_canonical_audit'] = audit
    report['first_turn_failure_kind'] = 'completed_model_turn_omitted_last_snapshot_id_character'
    report['created_thread_id'] = thread
    report['checks']['native_streaming'] = first['event_counts'].get('delta', 0) > 0
    report['outcome'] = 'running_explicit_correction'
    report['correction_started_at_utc'] = timestamp()
    save(report)
    host = InstalledHost(manifest)
    scope = report['scope']
    sequence = 0
    def envelope(op, **fields):
        nonlocal sequence
        sequence += 1
        report['last_operation'] = op
        return dict(version=1, id='correction-%s' % sequence, op=op,
                    projectId=scope['project_id'], accountId=scope['account_id'], **fields)
    try:
        history, _ = host.call(envelope('history-read', conversationId=thread), timeout=90)
        require_success(history, 'history')
        recovered = any(digest(m.get('text', '')) == first['answer_sha256'] for m in history.get('messages', []) if m.get('role') == 'assistant')
        if history.get('activeConversationId') != thread or not recovered:
            raise RuntimeError('The restarted helper did not exactly recover the first completed answer.')
        report['history_after_restart'] = {'active_conversation_id': history.get('activeConversationId'),
                                          'message_count': len(history.get('messages', [])),
                                          'roles': [m.get('role') for m in history.get('messages', [])],
                                          'remote_state': history.get('remoteState'), 'first_answer_sha256_matches': recovered}
        report['checks']['history_persisted_after_helper_restart'] = True
        question = ('Continuation of this synthetic acceptance conversation: your preceding reader calls omitted '
                    'the final character of the snapshot ID and were rejected. This is a new corrective request. '
                    'Use this exact 64-character snapshot_id: ' + report['snapshot_id'] + '. Its final eight characters '
                    'are ' + report['snapshot_id'][-8:] + '. Copy it exactly into each read_project_file call. '
                    'Read BOTH main.tex and 章节/部分😀.tex with the read-only overleaf_project reader. '
                    'Return only two lines, each containing the file path and its exact acceptance sentinel. '
                    'The sentinel values are only in the files; do not guess or use other tools.')
        settings = {'enabled': True, 'model': MODEL, 'effort': EFFORT, 'contextMode': 'project', 'instructions': 'Keep answers under 100 words.'}
        fields = dict(question=question, snapshotId=report['snapshot_id'], settings=settings, expectedConversationId=thread)
        if history.get('syncRevision'):
            fields['expectedSyncRevision'] = history['syncRevision']
        report['model_turns_attempted'] = 2
        save(report)
        print('Submitting final authorized corrective continuation turn 2/2.', flush=True)
        second, records = host.call(envelope('ask', **fields), timeout=240)
        report['second_turn'] = turn_summary(second, records, report['expected_sentinels'])
        require_success(second, 'done')
        report['second_helper_exit_code'] = host.close()
        if second.get('threadId') != thread or second.get('cancelled'):
            raise RuntimeError('The corrective continuation did not complete in the same thread.')
        report['checks']['same_thread_continuation'] = True
        matched = all(s in second.get('text', '') for s in report['expected_sentinels'])
        report['checks']['cross_file_answer_after_explicit_correction'] = matched
        audit = canonical_audit(helper_dir, thread, report['snapshot_id'], paths)
        report['canonical_turn_audit'] = audit
        read_paths = {tool.get('path') for turn in audit for tool in turn['mcp_tools']
                      if tool.get('server') == 'overleaf_project' and tool.get('tool') == 'read_project_file'
                      and tool.get('status') == 'completed' and tool.get('snapshot_id_matches_expected')}
        report['checks']['canonical_mcp_reads_both_files'] = paths.issubset(read_paths)
        if not matched or not report['checks']['canonical_mcp_reads_both_files'] or len(audit) != 2:
            raise RuntimeError('The final turn did not prove both cross-file reads; the two-turn budget is exhausted.')
        report['outcome'] = 'passed_after_explicit_model_argument_correction'
    except Exception as error:
        report['outcome'] = 'failed'
        report['failure'] = {'type': type(error).__name__, 'message': str(error)[:1800], 'automatic_question_retry': False}
    finally:
        report['last_helper_exit_code'] = host.close()
        report['finished_at_utc'] = timestamp()
        save(report)
    print(json.dumps({'outcome': report['outcome'], 'model_turns_attempted': report['model_turns_attempted'],
                      'checks': report['checks'], **({'failure': report['failure']} if 'failure' in report else {})}), flush=True)
    return 0 if report['outcome'].startswith('passed') else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--allow-live-turns', action='store_true', help='Explicitly authorize up to two short real model turns.')
    parser.add_argument('--resume-preflight', action='store_true',
                        help='Retry only a recorded zero-turn installation preflight; retain its failure evidence.')
    parser.add_argument('--continue-confirmed-read-failure', action='store_true',
                        help='Use only the second turn to correct a canonically confirmed first-turn snapshot-ID typo.')
    args = parser.parse_args()
    if not args.allow_live_turns:
        summary = json.loads(OUTPUT.read_text(encoding='utf-8')) if OUTPUT.exists() else {'outcome': 'not_run'}
        print(json.dumps({'read_only': True, 'outcome': summary.get('outcome'),
                          'model_turns_attempted': summary.get('model_turns_attempted', 0),
                          'checks': summary.get('checks', {}), 'live_requests_require': '--allow-live-turns'}, ensure_ascii=False))
        return 0
    if os.name != 'nt':
        parser.error('This acceptance script requires Windows.')
    prior = None
    if OUTPUT.exists():
        prior = json.loads(OUTPUT.read_text(encoding='utf-8'))
        if not args.continue_confirmed_read_failure and (not args.resume_preflight or prior.get('model_turns_attempted') != 0 or prior.get('outcome') != 'failed'):
            parser.error('The acceptance report already exists. Refusing an accidental inference repeat or overwrite.')
    sys.path.insert(0, str(ROOT / 'native'))
    from platform_utils import support_directory
    manifest_path = support_directory() / 'NativeMessagingHosts' / 'com.overleaf.personal_tools.codex.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    if args.continue_confirmed_read_failure:
        if prior is None:
            parser.error('A recorded first turn is required before an explicit correction.')
        return continue_confirmed_failure(manifest, prior)
    helper_dir = Path(manifest['path']).parent
    project = uuid.uuid4().hex[:24]
    account = 'windows-acceptance-' + uuid.uuid4().hex
    sentinels = ['WINDOWS_MAIN_' + uuid.uuid4().hex, 'WINDOWS_PART_' + uuid.uuid4().hex]
    files = {'main.tex': '\\documentclass{article}\n\\begin{document}\n% acceptance sentinel: ' + sentinels[0] + '\n\\input{章节/部分😀}\n\\end{document}\n',
             '章节/部分😀.tex': '% acceptance sentinel: ' + sentinels[1] + '\n合成中文内容 😀：$x^2+y^2=1$.\n'}
    report = {'started_at_utc': timestamp(), 'model': MODEL, 'effort': EFFORT,
              'scope': {'project_id': project, 'account_id': account, 'synthetic_only': True},
              'transport': 'Installed launch.cmd with Chrome Native Messaging framing',
              'extension_origin': manifest['allowed_origins'][0],
              'chrome_overleaf_ui_exercised': False, 'desktop_owner_handoff_exercised': False,
              'model_turn_budget': 2, 'model_turns_attempted': 0,
              'source_files': [{'path': path, 'bytes': len(content.encode('utf-8')), 'sha256': digest(content)} for path, content in files.items()],
              'expected_sentinels': sentinels, 'checks': {}, 'helper_source_sha256': {name: hashlib.sha256((helper_dir / name).read_bytes()).hexdigest() for name in ('codex_host.py', 'project_context.py', 'manuscript_mcp.py', 'windows_desktop.py')},
              'outcome': 'running'}
    if prior:
        report['preflight_attempts'] = prior.get('preflight_attempts', []) + [
            {key: prior[key] for key in ('started_at_utc', 'finished_at_utc', 'model_turns_attempted', 'failure', 'helper_source_sha256') if key in prior}]
    save(report)
    host = None
    sequence = 0
    def envelope(op, **fields):
        nonlocal sequence
        sequence += 1
        report['last_operation'] = op
        return dict(version=1, id='acceptance-%s' % sequence, op=op, projectId=project, accountId=account, **fields)
    try:
        host = InstalledHost(manifest)
        status, _ = host.call(envelope('status'))
        require_success(status, 'status')
        report['health'] = {'authenticated': status.get('authenticated'), 'available': status.get('available'),
                            'helper_version': status.get('version'), 'model_count': len(status.get('models', []))}
        model = next((m for m in status.get('models', []) if m.get('id') == MODEL), None)
        if not status.get('authenticated') or not model or EFFORT not in model.get('efforts', []):
            raise RuntimeError('The required authenticated gpt-6-luna low configuration is unavailable; no alternative was attempted.')
        empty, _ = host.call(envelope('history-list'))
        require_success(empty, 'history')
        if empty.get('conversations'):
            raise RuntimeError('Synthetic scope collision; no existing conversation will be read.')
        begin, _ = host.call(envelope('source-begin', rootPath='main.tex', sourceManifest=report['source_files']))
        require_success(begin, 'source')
        for path in begin.get('missingPaths', files.keys()):
            uploaded, _ = host.call(envelope('source-chunk', uploadId=begin['uploadId'], path=path, offset=0, content=files[path]))
            require_success(uploaded, 'source')
        committed, _ = host.call(envelope('source-commit', uploadId=begin['uploadId']))
        require_success(committed, 'source')
        snapshot = committed['snapshotId']
        report['snapshot_id'] = snapshot
        report['checks']['two_file_snapshot_upload'] = True
        settings = {'enabled': True, 'model': MODEL, 'effort': EFFORT,
                    'contextMode': 'project', 'instructions': 'Keep acceptance answers under 100 words.'}
        question = ('Synthetic Windows acceptance check. Use the read-only overleaf_project MCP to read BOTH main.tex '
                    'and 章节/部分😀.tex from the supplied complete-project snapshot. Return only two lines, '
                    'each containing the file path and its exact acceptance sentinel. The values are only in the files; '
                    'do not guess. Do not use shell, web, or any other tools.')
        assert not any(s in question for s in sentinels)
        report['model_turns_attempted'] = 1
        save(report)
        print('Submitting synthetic cross-file acceptance turn 1/2.', flush=True)
        first, records = host.call(envelope('ask', question=question, snapshotId=snapshot, settings=settings,
                                           expectedConversationId=None), timeout=240)
        report['first_turn'] = turn_summary(first, records, sentinels)
        require_success(first, 'done')
        if first.get('cancelled') or not all(s in first.get('text', '') for s in sentinels):
            raise RuntimeError('The first turn did not return both exact cross-file sentinels.')
        if report['first_turn']['event_counts'].get('delta', 0) < 1:
            raise RuntimeError('No native streaming delta was observed.')
        thread = first['threadId']
        report['created_thread_id'] = thread
        report['checks'].update(cross_file_answer=True, native_streaming=True)
        report['first_helper_exit_code'] = host.close(); host = None
        save(report)
        print('Restarting installed helper and reading this acceptance thread only.', flush=True)
        host = InstalledHost(manifest)
        history, _ = host.call(envelope('history-read', conversationId=thread), timeout=90)
        require_success(history, 'history')
        history_text = '\n'.join(m.get('text', '') for m in history.get('messages', []))
        if history.get('activeConversationId') != thread or not all(s in history_text for s in sentinels):
            raise RuntimeError('Restarted helper did not recover the exact synthetic history.')
        report['history_after_restart'] = {'conversation_id': history.get('conversationId'),
                                          'active_conversation_id': history.get('activeConversationId'),
                                          'message_count': len(history.get('messages', [])),
                                          'roles': [m.get('role') for m in history.get('messages', [])],
                                          'remote_state': history.get('remoteState'),
                                          'both_sentinels_recovered': True}
        report['checks']['history_persisted_after_helper_restart'] = True
        second_question = ('Same synthetic acceptance conversation, continuation check. Repeat exactly the two acceptance '
                           'sentinel values from your preceding answer, one per line. Use the conversation history; '
                           'do not call tools. No explanation.')
        follow_settings = dict(settings, contextMode='selection')
        fields = {'question': second_question, 'settings': follow_settings, 'expectedConversationId': thread}
        if history.get('syncRevision'):
            fields['expectedSyncRevision'] = history['syncRevision']
        report['model_turns_attempted'] = 2
        save(report)
        print('Submitting same-thread continuation turn 2/2.', flush=True)
        second, records = host.call(envelope('ask', **fields), timeout=180)
        report['second_turn'] = turn_summary(second, records, sentinels)
        require_success(second, 'done')
        if second.get('threadId') != thread or second.get('cancelled') or not all(s in second.get('text', '') for s in sentinels):
            raise RuntimeError('Continuation did not preserve the exact thread and preceding answer.')
        report['checks']['same_thread_continuation'] = True
        report['second_helper_exit_code'] = host.close(); host = None
        # Read metadata only for the exact thread this invocation just created.
        # It supplies audit evidence of MCP use without saving raw reasoning,
        # context payloads, account details, or unrelated conversation data.
        sys.path.insert(0, str(helper_dir))
        import codex_host
        server = codex_host.AppServer(helper_dir, deadline=time.monotonic() + 45)
        try:
            page = server.request('thread/turns/list', {'threadId': thread, 'itemsView': 'full', 'sortDirection': 'asc', 'limit': 3}, timeout=30)
            turns = page.get('data', [])
            audit = []
            for turn in turns:
                tools = []
                for item in turn.get('items', []):
                    if item.get('type') == 'mcpToolCall':
                        params = item.get('arguments', {})
                        if isinstance(params, str):
                            try: params = json.loads(params)
                            except ValueError: params = {}
                        tools.append({'server': item.get('server'), 'tool': item.get('tool'), 'status': item.get('status'),
                                      **({'path': params.get('path')} if isinstance(params, dict) and params.get('path') in files else {})})
                audit.append({'turn_id': turn.get('id'), 'status': turn.get('status'),
                              'item_types': dict(Counter(i.get('type') for i in turn.get('items', []))), 'mcp_tools': tools})
            report['canonical_turn_audit'] = audit
            if len(audit) != 2:
                raise RuntimeError('Canonical acceptance thread did not contain exactly two turns.')
            paths = {tool.get('path') for turn in audit for tool in turn['mcp_tools']
                     if tool.get('server') == 'overleaf_project' and tool.get('tool') == 'read_project_file' and tool.get('status') == 'completed'}
            report['checks']['canonical_mcp_reads_both_files'] = set(files).issubset(paths)
            if not report['checks']['canonical_mcp_reads_both_files']:
                raise RuntimeError('Both file reads were not proven in canonical MCP item metadata.')
        finally:
            server.close()
        report['outcome'] = 'passed'
    except Exception as error:
        report['outcome'] = 'failed'
        report['failure'] = {'type': type(error).__name__, 'message': str(error)[:1800],
                             'automatic_question_retry': False}
    finally:
        if host is not None:
            report['last_helper_exit_code'] = host.close()
        report['finished_at_utc'] = timestamp()
        save(report)
    print(json.dumps({'outcome': report['outcome'], 'model_turns_attempted': report['model_turns_attempted'],
                      'checks': report['checks'], 'report': str(OUTPUT),
                      **({'failure': report['failure']} if 'failure' in report else {})}, ensure_ascii=False), flush=True)
    return 0 if report['outcome'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
