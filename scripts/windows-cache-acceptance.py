"""Exercise installed cache lifecycle with isolated synthetic source, no model calls.

Run explicitly with --run. Creates one fresh synthetic scope, checks two-page
leases, durable queue protection, helper restart, delayed collection, a Unicode
readonly mirror and explicit cleanup. Only this invocation's data is cleared.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import time
import uuid


ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true')
    args = parser.parse_args()
    if not args.run:
        print('No changes made. Pass --run for isolated synthetic cache acceptance; no model requests.')
        return
    if os.name != 'nt':
        raise SystemExit('This acceptance checks the installed Windows launcher.')
    spec = importlib.util.spec_from_file_location('windows_live_protocol', Path(__file__).with_name('windows-live-acceptance.py'))
    protocol = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(protocol)
    manifest = json.loads((Path.home() / '.overleaf-personal-tools' / 'NativeMessagingHosts' /
                           'com.overleaf.personal_tools.codex.json').read_text(encoding='utf-8'))
    client = protocol.InstalledHost(manifest)
    account, project = uuid.uuid4().hex[:24], uuid.uuid4().hex[:24]
    browser = str(uuid.uuid4())
    leases = [str(uuid.uuid4()), str(uuid.uuid4())]
    documents = ['synthetic-document-1', 'synthetic-document-2']
    checks = []
    report = {'model_requests': 0, 'scope': {'accountId': account, 'projectId': project}, 'checks': checks}

    def call(op, expected='source', **fields):
        event, _ = client.call(dict(version=1, id=str(uuid.uuid4()), op=op,
                                    accountId=account, projectId=project, **fields))
        protocol.require_success(event, expected)
        return event

    def check(name, condition):
        if not condition:
            raise AssertionError(name)
        checks.append(name)

    def upload(mode):
        files = {'main.tex': '\\input{章节/部分😀}\n% ' + mode + '\n',
                 '章节/部分😀.tex': 'Synthetic UTF-8 source only: 中文 😀 \\cN\n'}
        entries = [{'path': path, 'bytes': len(content.encode('utf-8')),
                    'sha256': hashlib.sha256(content.encode('utf-8')).hexdigest()}
                   for path, content in files.items()]
        begin = call('source-begin', rootPath='main.tex', sourceManifest=entries,
                     cacheMode=mode, leaseToken=leases[0])
        for path in begin.get('missingPaths', files):
            call('source-chunk', uploadId=begin['uploadId'], path=path, offset=0, content=files[path])
        return call('source-commit', uploadId=begin['uploadId'])['snapshotId'], files

    try:
        for document, lease in zip(documents, leases):
            call('source-page-acquire', browserId=browser, documentId=document, leaseToken=lease)
        temporary, _ = upload('on-demand')
        persistent, files = upload('persistent')
        info = call('source-cache-info')['cacheInfo']
        check('two_pages_two_versions_and_modes', info['pageCount'] == 2 and info['temporaryCount'] == 1 and info['persistentCount'] == 1)
        mirror = Path(info['folder']) / persistent
        check('unicode_original_path_mirror', all((mirror / path).read_bytes() == text.encode('utf-8') for path, text in files.items()))
        try:
            with (mirror / 'main.tex').open('ab') as stream:
                stream.write(b'UNEXPECTED WRITE')
        except PermissionError:
            checks.append('mirror_rejects_writes')
        else:
            raise AssertionError('Mirror unexpectedly writable')
        queue_id = str(uuid.uuid4())
        call('source-queue-pin', queueId=queue_id, snapshotId=temporary)
        for document, lease in zip(documents, leases):
            call('source-page-release', browserId=browser, documentId=document, leaseToken=lease)
        check('first_helper_clean_exit', client.close() == 0)
        client = protocol.InstalledHost(manifest)
        info = call('source-cache-info')['cacheInfo']
        check('leases_and_pin_survive_helper_restart', info['pageCount'] == 0 and info['pinCount'] == 1 and info['snapshotCount'] == 2)
        call('source-cache-clear', expected='error', cacheRevision=info['cacheRevision'])
        checks.append('explicit_clear_refuses_queue_pin')
        time.sleep(31)
        info = call('source-cache-sweep')['cacheInfo']
        check('after_grace_queue_and_persistent_retained', info['snapshotCount'] == 2)
        call('source-queue-release', queueId=queue_id)
        info = call('source-cache-sweep')['cacheInfo']
        check('only_unpinned_temporary_reclaimed', info['snapshotCount'] == 1 and info['persistentCount'] == 1 and info['temporaryCount'] == 0)
        call('source-check', expected='error', snapshotId=temporary)
        call('source-check', snapshotId=persistent)
        check('shared_content_preserved', all((mirror / path).read_bytes() == text.encode('utf-8') for path, text in files.items()))
        info = call('source-cache-clear', cacheRevision=info['cacheRevision'])['cacheInfo']
        check('explicit_clear_removes_synthetic_source', info['snapshotCount'] == 0 and info['totalBytes'] == 0 and not mirror.exists())
        report['result'] = 'passed'
    except Exception as error:
        report['result'] = 'failed'
        report['error'] = str(error)
        raise
    finally:
        report['launcher_exit'] = client.close()
        output = ROOT / 'artifacts' / 'windows-cache-acceptance.json'
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
