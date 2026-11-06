"""Real Windows containment checks use only temporary synthetic source/sentinels."""
import base64
import importlib.util
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

NATIVE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(NATIVE))
import host


def request(source, compiler='pdflatex'):
    return {'id': 'windows-synthetic', 'op': 'render', 'version': 1,
            'compiler': compiler, 'document': {'entryPath': 'main.tex',
            'files': [{'path': 'main.tex', 'content': source}]}}


PLAIN = r'\documentclass{article}\usepackage{physics,xparse}\begin{document}\(\ket{x}+\pdv{f}{x}\)\end{document}'


@unittest.skipUnless(os.name == 'nt', 'Windows path alias rules')
class WindowsPathValidationTests(unittest.TestCase):
    def test_windows_device_aliases_and_trailing_characters(self):
        for name in ('CON.tex', 'nul.txt', 'a/COM1.tex', 'a/LPT9.sty', 'dir./main.tex', 'dir /main.tex', 'a.tex '):
            with self.subTest(name=name), self.assertRaises(host.HostError):
                host.safe_path(name)


@unittest.skipUnless(os.name == 'nt', 'Windows AppContainer integration')
class WindowsEngineTests(unittest.TestCase):
    def test_real_sandbox_status(self):
        state = host.status()
        self.assertTrue(state['available'], state['message'])
        self.assertTrue(state['sandbox'])

    def test_every_installed_compiler(self):
        self.assertTrue(host.compiler_paths(), 'Windows TeX Live is needed for engine acceptance')
        for compiler in host.compiler_paths():
            with self.subTest(compiler=compiler):
                # A hostile first-line format selector must not override the
                # fixed LaTeX format, including LuaHBTeX's distinct CLI.
                result = host.render(request('%&plain\n' + PLAIN, compiler))
                self.assertTrue(base64.b64decode(result['pdfBase64']).startswith(b'%PDF-'))

    def test_no_shell_escape(self):
        source = r'\documentclass{article}\begin{document}\ifnum\pdfshellescape=0\relax\else\errmessage{shell escape enabled}\fi Safe\end{document}'
        self.assertIn('pdfBase64', host.render(request(source)))

    def test_undefined_reference_is_reported(self):
        result = host.render(request(r'\documentclass{article}\begin{document}\(x_{\ref{missing}}\)\end{document}'))
        self.assertTrue(any('undefined' in warning for warning in result['diagnostics']))

    def test_lua_io_cannot_bypass_os_read_write_boundary(self):
        with tempfile.TemporaryDirectory(prefix='opt-lua-sentinel-') as directory:
            sentinel = Path(directory) / 'sentinel.txt'
            sentinel.write_text('SYNTHETIC PRIVATE SENTINEL')
            path = sentinel.as_posix()
            source = r'\documentclass{article}\begin{document}\directlua{local f=io.open("' + path + r'","r"); if f then tex.error("External read allowed") end; local w=io.open("' + path + r'","w"); if w then tex.error("External write allowed") end}Safe\end{document}'
            self.assertIn('pdfBase64', host.render(request(source, 'lualatex')))
            self.assertEqual(sentinel.read_text(), 'SYNTHETIC PRIVATE SENTINEL')

    def test_missing_configuration_fails_closed(self):
        import windows_tex
        with patch.object(windows_tex, 'configured', return_value=False):
            self.assertFalse(host.status()['available'])
            with self.assertRaisesRegex(host.HostError, '无沙盒'):
                host.render(request(PLAIN))

    def test_timeout_and_cancel(self):
        source = r'\documentclass{article}\begin{document}\loop\iftrue\repeat\end{document}'
        with patch.object(host, 'TIMEOUT', .25), self.assertRaisesRegex(host.HostError, '终止'):
            host.render(request(source))
        event = threading.Event()
        timer = threading.Timer(.25, event.set)
        timer.start()
        try:
            with self.assertRaisesRegex(host.HostError, '取消'):
                host.render(request(source), event)
        finally:
            timer.cancel()

    def test_native_port_disconnect(self):
        process = subprocess.Popen([sys.executable, '-X', 'utf8', str(NATIVE / 'host.py')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            host.write_message(process.stdin, {'id': 'status', 'op': 'status', 'version': 1})
            state = host.read_message(process.stdout)
            self.assertTrue(state['available'], state)
            host.write_message(process.stdin, request(r'\documentclass{article}\begin{document}\loop\iftrue\repeat'))
            time.sleep(.3)
            process.stdin.close()
            process.wait(timeout=5)
            self.assertIn('取消', host.read_message(process.stdout)['diagnostics'][0])
        finally:
            if process.poll() is None:
                process.kill(); process.wait()
            if not process.stdin.closed:
                process.stdin.close()
            process.stdout.close(); process.stderr.close()

    def test_new_request_cancels_previous(self):
        process = subprocess.Popen([sys.executable, '-X', 'utf8', str(NATIVE / 'host.py')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            old = request(r'\documentclass{article}\begin{document}\loop\iftrue\repeat')
            old['id'] = 'previous'
            host.write_message(process.stdin, old)
            time.sleep(.3)
            new = request(PLAIN); new['id'] = 'latest'
            host.write_message(process.stdin, new)
            previous = host.read_message(process.stdout)
            self.assertEqual(previous['id'], 'previous')
            self.assertIn('取消', previous['diagnostics'][0])
            current = host.read_message(process.stdout)
            self.assertEqual(current['id'], 'latest')
            self.assertIn('pdfBase64', current)
        finally:
            process.stdin.close()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill(); process.wait()
            process.stdout.close(); process.stderr.close()


@unittest.skipUnless(os.name == 'nt' and shutil.which('gcc'), 'Windows and C compiler required for OS boundary probe')
class WindowsBoundaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.staging = tempfile.TemporaryDirectory(prefix='opt-boundary-build-')
        cls.executable = Path(cls.staging.name) / 'sandbox-probe.exe'
        subprocess.run([shutil.which('gcc'), str(Path(__file__).with_name('windows_tex_probe.c')),
                        '-o', str(cls.executable), '-Wl,--dynamicbase,--nxcompat,--export-all-symbols', '-lws2_32'], check=True, capture_output=True, timeout=30)

    @classmethod
    def tearDownClass(cls):
        cls.staging.cleanup()

    def run_probe(self, args, callback=None):
        import windows_tex
        with tempfile.TemporaryDirectory(prefix='opt-boundary-job-') as directory:
            job = Path(directory)
            executable = job / 'probe.exe'
            shutil.copyfile(self.executable, executable)
            with (job / 'output.txt').open('wb') as log:
                env = {'SystemRoot': os.environ['SystemRoot'], 'TEMP': str(job), 'TMP': str(job),
                       'USERPROFILE': str(job), 'LOCALAPPDATA': str(job), 'APPDATA': str(job)}
                process = windows_tex.SandboxedProcess([str(executable)] + args, job, env, log)
                try:
                    if callback:
                        return callback(process, job)
                    return process.wait(timeout=4)
                finally:
                    process.close()

    def test_os_denies_outside_read_and_write(self):
        with tempfile.TemporaryDirectory(prefix='opt-private-sentinel-') as directory:
            sentinel = Path(directory) / 'sentinel.txt'
            sentinel.write_text('SYNTHETIC DO NOT READ OR CHANGE', encoding='utf-8')
            self.assertEqual(self.run_probe(['read', str(sentinel)]), 0)
            self.assertEqual(self.run_probe(['write', str(sentinel)]), 0)
            self.assertEqual(sentinel.read_text(), 'SYNTHETIC DO NOT READ OR CHANGE')

    def test_os_denies_network(self):
        with socket.socket() as server:
            server.bind(('127.0.0.1', 0)); server.listen(1)
            # Positive control proves the same probe reaches this live listener
            # outside containment; the sandbox must not establish a connection.
            control = subprocess.run([str(self.executable), 'network', str(server.getsockname()[1])], timeout=3)
            self.assertEqual(control.returncode, 42)
            server.settimeout(2)
            connection, _ = server.accept(); connection.close()
            self.assertEqual(self.run_probe(['network', str(server.getsockname()[1])]), 0)
            server.settimeout(.1)
            with self.assertRaises(socket.timeout):
                server.accept()

    def test_job_close_kills_converter_child(self):
        import win32api
        import win32event
        def check(process, job):
            end = time.monotonic() + 3
            while time.monotonic() < end:
                value = (job / 'output.txt').read_text().strip()
                if value:
                    break
                time.sleep(.03)
            self.assertTrue(value, 'probe child was not started')
            child = win32api.OpenProcess(0x100000, False, int(value))
            try:
                process.close()
                self.assertEqual(win32event.WaitForSingleObject(child, 2000), 0)
            finally:
                child.Close()
        self.run_probe(['child'], check)

    def test_abrupt_host_exit_kills_entire_job(self):
        import ctypes
        import win32api
        import win32event
        code = r'''
import json,os,sys,time
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from windows_tex import SandboxedProcess
job=Path(sys.argv[2])
with (job/'output.txt').open('wb') as log:
    env={k:str(job) for k in ('TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA')}
    env['SystemRoot']=os.environ['SystemRoot']
    child=SandboxedProcess([str(job/'probe.exe'),'child'],job,env,log)
    print(json.dumps({'pid':child.pid,'profile':child._profile}),flush=True)
    time.sleep(60)
'''
        with tempfile.TemporaryDirectory(prefix='opt-parent-death-') as directory:
            job = Path(directory)
            shutil.copyfile(self.executable, job / 'probe.exe')
            helper = subprocess.Popen([sys.executable, '-c', code, str(NATIVE), str(job)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            profile, handles = None, []
            try:
                import json
                state = json.loads(helper.stdout.readline())
                profile = state['profile']
                handles.append(win32api.OpenProcess(0x100000, False, state['pid']))
                end = time.monotonic() + 3
                while time.monotonic() < end:
                    value = (job / 'output.txt').read_text().strip()
                    if value:
                        break
                    time.sleep(.03)
                self.assertTrue(value)
                handles.append(win32api.OpenProcess(0x100000, False, int(value)))
                helper.kill(); helper.wait(timeout=3)
                for handle in handles:
                    self.assertEqual(win32event.WaitForSingleObject(handle, 2000), 0)
            finally:
                if helper.poll() is None:
                    helper.kill(); helper.wait()
                helper.stdout.close(); helper.stderr.close()
                for handle in handles:
                    handle.Close()
                if profile:
                    dll = ctypes.WinDLL('userenv')
                    dll.DeleteAppContainerProfile.argtypes = [ctypes.c_wchar_p]
                    dll.DeleteAppContainerProfile(profile)


if __name__ == '__main__':
    unittest.main()
