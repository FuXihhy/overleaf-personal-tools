"""Windows pipe security, duplex framing, cancellation and child cleanup.

All servers/processes below are synthetic. No running Desktop chat is read.
"""
import ctypes
from ctypes import wintypes as w
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock
import uuid

sys.path.insert(0, str(Path(__file__).parents[1]))
import windows_desktop as desktop


@unittest.skipUnless(os.name == 'nt', 'Windows kernel integration')
class WindowsDesktopTests(unittest.TestCase):
    def pipe_server(self, callback):
        k, _ = desktop._win()
        k.CreateNamedPipeW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, w.DWORD, w.DWORD, w.DWORD, w.DWORD, w.LPVOID]
        k.CreateNamedPipeW.restype = w.HANDLE
        k.ConnectNamedPipe.argtypes = [w.HANDLE, w.LPVOID]
        k.ConnectNamedPipe.restype = w.BOOL
        path = r'\\.\pipe\overleaf-test-' + str(uuid.uuid4())
        handle = k.CreateNamedPipeW(path, 0x80003, 8, 1, 65536, 65536, 0, None)
        self.assertNotEqual(handle, desktop.INVALID_HANDLE)
        failures = []
        def run():
            try:
                if not k.ConnectNamedPipe(handle, None) and ctypes.get_last_error() != 535:
                    raise ctypes.WinError(ctypes.get_last_error())
                callback(k, handle)
            except Exception as error:
                failures.append(error)
            finally:
                k.CloseHandle(handle)
        worker = threading.Thread(target=run, daemon=True)
        worker.start()
        return path, worker, failures

    def test_untrusted_same_user_process_rejected_before_protocol_bytes(self):
        received = []
        def serve(k, handle):
            data = ctypes.create_string_buffer(64); count = w.DWORD()
            ok = k.ReadFile(handle, data, 64, ctypes.byref(count), None)
            received.append((bool(ok), count.value))
        path, worker, failures = self.pipe_server(serve)
        with mock.patch.object(desktop, 'PIPE_PATH', path):
            with self.assertRaisesRegex(desktop.WindowsDesktopError, 'package'):
                desktop.NamedPipeSocket(path)
        worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertEqual(failures, [])
        self.assertEqual(received[0][1], 0)

    def test_duplex_byte_transport_handles_fragmented_reads_and_large_writes(self):
        payload = b'abc\x00\xe4\xb8\xad' * 40000
        received = []
        def serve(k, handle):
            collected = bytearray()
            while len(collected) < len(payload):
                data = ctypes.create_string_buffer(8192); count = w.DWORD()
                if not k.ReadFile(handle, data, 8192, ctypes.byref(count), None):
                    raise ctypes.WinError(ctypes.get_last_error())
                collected.extend(data.raw[:count.value])
            received.append(bytes(collected))
            for piece in (b'\x05', b'\x00\x00', b'\x00hello'):
                count = w.DWORD()
                if not k.WriteFile(handle, piece, len(piece), ctypes.byref(count), None):
                    raise ctypes.WinError(ctypes.get_last_error())
            # Keep the server open until the client has consumed its output.
            done.wait(2)
        done = threading.Event()
        path, worker, failures = self.pipe_server(serve)
        with mock.patch.object(desktop, 'PIPE_PATH', path), mock.patch.object(desktop, 'verify_pipe_server', return_value={'created_at': 1}):
            client = desktop.NamedPipeSocket(path)
            try:
                client.sendall(payload)
                result = bytearray()
                while len(result) < 9:
                    result.extend(client.recv(9 - len(result)))
                self.assertEqual(bytes(result), b'\x05\x00\x00\x00hello')
            finally:
                done.set(); client.close()
        worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertEqual(failures, [])
        self.assertEqual(received, [payload])

    def test_close_cancels_blocked_read_without_waiting_for_server(self):
        release = threading.Event()
        path, worker, failures = self.pipe_server(lambda k, h: release.wait(3))
        with mock.patch.object(desktop, 'PIPE_PATH', path), mock.patch.object(desktop, 'verify_pipe_server', return_value={'created_at': 1}):
            client = desktop.NamedPipeSocket(path)
            result = queue.Queue()
            reader = threading.Thread(target=lambda: result.put(client.recv(4)), daemon=True)
            reader.start()
            time.sleep(.05)
            client.close()
            self.assertEqual(result.get(timeout=1), b'')
            reader.join(1)
        release.set(); worker.join(2)
        self.assertEqual(failures, [])
        self.assertFalse(reader.is_alive())

    def test_user_or_session_mismatch_is_rejected_before_package_lookup(self):
        k, _ = desktop._win()
        release = threading.Event()
        path, worker, failures = self.pipe_server(lambda k, h: release.wait(3))
        with mock.patch.object(desktop, 'PIPE_PATH', path), mock.patch.object(desktop, '_token_identity', side_effect=[(b'a', 1), (b'b', 1)]), mock.patch.object(desktop, '_package_string') as package:
            with self.assertRaisesRegex(desktop.WindowsDesktopError, 'another user'):
                desktop.NamedPipeSocket(path)
            package.assert_not_called()
        release.set(); worker.join(2)
        self.assertEqual(failures, [])

    def test_wrong_package_identity_is_rejected(self):
        release = threading.Event()
        path, worker, failures = self.pipe_server(lambda k, h: release.wait(3))
        with mock.patch.object(desktop, 'PIPE_PATH', path), mock.patch.object(desktop, '_package_string', return_value='Other.Publisher_1234'):
            with self.assertRaisesRegex(desktop.WindowsDesktopError, 'not the installed OpenAI'):
                desktop.NamedPipeSocket(path)
        release.set(); worker.join(2)
        self.assertEqual(failures, [])

    def test_package_identity_does_not_allow_an_unrelated_process_image(self):
        release = threading.Event()
        path, worker, failures = self.pipe_server(lambda k, h: release.wait(3))
        with mock.patch.object(desktop, 'PIPE_PATH', path), mock.patch.object(desktop, '_package_string', side_effect=[desktop.PACKAGE_FAMILY, 'package-full-name', str(Path(sys.executable).parent)]):
            with self.assertRaisesRegex(desktop.WindowsDesktopError, 'executable is not'):
                desktop.NamedPipeSocket(path)
        release.set(); worker.join(2)
        self.assertEqual(failures, [])

    def test_job_closes_only_owned_process_and_descendants(self):
        with tempfile.TemporaryDirectory() as folder:
            # Wait for a signal before spawning a descendant so containment is
            # deterministic and does not race assignment of the root process.
            script = 'import subprocess,sys,time; sys.stdin.readline(); p=subprocess.Popen([sys.executable,"-c","import time; time.sleep(30)"]); print(p.pid,flush=True); time.sleep(30)'
            parent = subprocess.Popen([sys.executable, '-c', script], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                      stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW, cwd=folder)
            job = desktop.ProcessJob(parent)
            try:
                parent.stdin.write(b'go\n'); parent.stdin.flush()
                child_pid = int(parent.stdout.readline())
                k, _ = desktop._win()
                child = k.OpenProcess(0x100000, False, child_pid)
                self.assertTrue(child)
                try:
                    job.close()
                    self.assertEqual(k.WaitForSingleObject(child, 2000), 0)
                    parent.wait(timeout=2)
                finally:
                    k.CloseHandle(child)
            finally:
                job.close()
                if parent.poll() is None: parent.kill(); parent.wait(timeout=2)
                parent.stdin.close(); parent.stdout.close()

    def test_suspended_process_runs_only_after_containment(self):
        process = subprocess.Popen([sys.executable, '-c', 'print("contained",flush=True)'],
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   creationflags=subprocess.CREATE_NO_WINDOW | 4)
        job = None
        try:
            self.assertIsNone(process.poll())
            job = desktop.ProcessJob(process, suspended=True)
            self.assertEqual(process.communicate(timeout=3)[0].strip(), b'contained')
            self.assertEqual(process.returncode, 0)
        finally:
            if job: job.close()
            if process.poll() is None: process.kill(); process.wait(timeout=2)
            process.stdout.close()


if __name__ == '__main__':
    unittest.main()
