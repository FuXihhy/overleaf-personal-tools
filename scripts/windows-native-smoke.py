"""Probe the installed Chrome launcher without inference; contain all children."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import queue
import struct
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).absolute().parents[1]
ORIGIN = 'chrome-extension://pffppbkokpnfafpechmlambifflkmbbn/'


def launcher_command(path):
    """One quoted cmd expansion; percent values are not recursively expanded."""
    if any(c in str(path) for c in '\r\n"\0'):
        raise ValueError('Invalid installed launcher path.')
    env = os.environ.copy()
    env['OPT_ACCEPTANCE_LAUNCHER'] = str(path)
    cmd = str(Path(os.environ['SystemRoot']) / 'System32' / 'cmd.exe')
    command = subprocess.list2cmdline([cmd]) + ' /d /v:off /s /c ""%OPT_ACCEPTANCE_LAUNCHER%" "' + ORIGIN + '" --parent-window=0"'
    return command, env


def process_job(process):
    spec = importlib.util.spec_from_file_location('opt_smoke_job', ROOT / 'native' / 'windows_desktop.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.ProcessJob(process, suspended=True)


def read_exact(stream, count):
    data = bytearray()
    while len(data) < count:
        piece = stream.read(count - len(data))
        if not piece:
            raise EOFError('Incomplete native frame.')
        data.extend(piece)
    return bytes(data)


def probe(tex=False):
    root = Path.home() / '.overleaf-personal-tools'
    name = 'com.overleaf.personal_tools' + ('' if tex else '.codex')
    directory = root / ('native-host' if tex else 'codex-native-host')
    spec = importlib.util.spec_from_file_location('opt_smoke_audit', ROOT / 'scripts' / 'windows-installation-audit.py')
    audit = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(audit)
    manifest = json.loads(audit.read_bytes(root / 'NativeMessagingHosts' / (name + '.json'), 16 * 1024))
    if manifest.get('name') != name or manifest.get('allowed_origins') != [ORIGIN] or not audit.same_path(manifest.get('path'), directory / 'launch.cmd'):
        raise ValueError('Installed native manifest does not match this extension.')
    audit.check_components(directory / 'launch.cmd')
    command, env = launcher_command(directory / 'launch.cmd')
    process = subprocess.Popen(command, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW | 0x4)
    job = None
    events = queue.Queue(maxsize=16)

    def receive():
        try:
            while True:
                size = struct.unpack('<I', read_exact(process.stdout, 4))[0]
                if not 0 < size <= 1048576:
                    raise ValueError('Invalid native frame size.')
                events.put_nowait(json.loads(read_exact(process.stdout, size)))
        except Exception:
            try:
                events.put_nowait(None)
            except queue.Full:
                pass

    reader = None
    try:
        job = process_job(process)
        reader = threading.Thread(target=receive, daemon=True)
        reader.start()
        payload = json.dumps({'version': 1, 'id': 'windows-smoke-status', 'op': 'status'}).encode('utf-8')
        process.stdin.write(struct.pack('<I', len(payload)) + payload)
        process.stdin.flush()
        deadline = time.monotonic() + 60
        while True:
            event = events.get(timeout=max(0.01, deadline - time.monotonic()))
            if not isinstance(event, dict) or event.get('id') != 'windows-smoke-status':
                raise ValueError('Invalid native status response.')
            if event.get('type') == 'status' or tex and 'available' in event:
                print(json.dumps(event, ensure_ascii=False))
                break
            if event.get('type') == 'error' or time.monotonic() >= deadline:
                raise ValueError('Native status failed.')
    finally:
        try:
            process.stdin.close()
        except OSError:
            pass
        if job:
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                pass
            job.close()
        elif process.poll() is None:
            process.kill()
        process.wait(timeout=3)
        if reader:
            reader.join(timeout=2)
        process.stdout.close()
        print('Launcher exit:', process.returncode)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tex', action='store_true', help='Check the installed TeX host instead of Codex.')
    options = parser.parse_args(argv)
    if os.name != 'nt':
        parser.error('This probe requires Windows.')
    try:
        probe(options.tex)
        return 0
    except Exception:
        # Exception messages can include native payloads or private paths.
        print('Native status probe failed; no model request was sent.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
