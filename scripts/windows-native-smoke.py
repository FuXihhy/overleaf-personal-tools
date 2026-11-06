"""Exercise the installed Chrome launcher; print only public health metadata."""
import json
import argparse
import os
from pathlib import Path
import queue
import struct
import subprocess
import threading
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--tex', action='store_true', help='Check the installed TeX host instead of Codex.')
options = parser.parse_args()
root = Path.home() / '.overleaf-personal-tools'
host_name = 'com.overleaf.personal_tools' + ('' if options.tex else '.codex')
manifest = json.loads((root / 'NativeMessagingHosts' / (host_name + '.json')).read_text(encoding='utf-8'))
process = subprocess.Popen([os.environ['COMSPEC'], '/d', '/c', manifest['path'], manifest['allowed_origins'][0], '--parent-window=0'],
                           stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           creationflags=subprocess.CREATE_NO_WINDOW)
events = queue.Queue()

def receive():
    try:
        while True:
            header = process.stdout.read(4)
            if not header:
                return
            size = struct.unpack('<I', header)[0]
            if not 0 < size <= 1048576:
                raise ValueError('Invalid native frame length')
            events.put(json.loads(process.stdout.read(size)))
    except Exception as error:
        events.put({'type': 'test-error', 'message': str(error)})

threading.Thread(target=receive, daemon=True).start()
payload = json.dumps({'version': 1, 'id': 'windows-smoke-status', 'op': 'status'}).encode('utf-8')
process.stdin.write(struct.pack('<I', len(payload)) + payload)
process.stdin.flush()
try:
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        event = events.get(timeout=max(0.1, deadline - time.monotonic()))
        if event.get('type') == 'status' or options.tex and 'available' in event:
            print(json.dumps(event, ensure_ascii=False))
            break
        if event.get('type') in ('error', 'test-error'):
            raise RuntimeError(event.get('message'))
    else:
        raise TimeoutError('No native status response')
finally:
    process.stdin.close()
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        process.kill(); process.wait(timeout=3)
    print('Launcher exit:', process.returncode)
