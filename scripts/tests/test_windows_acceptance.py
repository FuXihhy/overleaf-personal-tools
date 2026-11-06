"""Tests do not register helpers, change TeX ACLs or call a live provider."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import subprocess
import ctypes
from ctypes import wintypes
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile


SCRIPT = Path(__file__).absolute().parents[1] / 'windows-acceptance.py'
SPEC = importlib.util.spec_from_file_location('windows_acceptance', SCRIPT)
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)
SMOKE_SPEC = importlib.util.spec_from_file_location('native_smoke', SCRIPT.with_name('windows-native-smoke.py'))
smoke = importlib.util.module_from_spec(SMOKE_SPEC)
SMOKE_SPEC.loader.exec_module(smoke)


def completed(output='', code=0, timed_out=False):
    return {'output': output, 'returncode': code, 'timedOut': timed_out,
            'launchFailed': False, 'truncated': False}


def status_output(**extra):
    value = {'id': 'windows-smoke-status', 'type': 'status', 'available': True,
             'authenticated': True, 'projectReaderReady': True, 'connectionKind': 'standalone'}
    value.update(extra)
    return json.dumps(value) + '\nLauncher exit: 0\n'


def options(**extra):
    result = dict(setup=False, workspace=None, api_only=False, local_tex=False,
                  tex_root=None, full=False)
    result.update(extra)
    return SimpleNamespace(**result)


def audit_value(configured=True, result='passed'):
    return {'result': result, 'workspaceConfiguration': {'status': 'configured' if configured else 'unconfigured'},
            'pythonCopiesMatched': 14, 'pythonCopiesChecked': 14,
            'errors': ['opaque value SECRET_NOT_FOR_REPORT']}


class HealthTests(unittest.TestCase):
    def test_health_allowlist_excludes_account_models_and_error(self):
        health = runner.native_health(status_output(account={'email': 'private@example.invalid'},
                                                     models=['secret-value'], readerError='sk-secret'))
        self.assertTrue(health['ready'])
        self.assertEqual(set(health), {'available', 'authenticated', 'projectReaderReady', 'standalone', 'ready'})
        self.assertNotIn('secret', json.dumps(health))

    def test_model_listing_alone_is_not_health(self):
        self.assertFalse(runner.native_health(status_output(projectReaderReady=False))['ready'])
        self.assertFalse(runner.native_health(status_output(authenticated=False))['ready'])
        self.assertFalse(runner.native_health(status_output(available='true'))['ready'])

    def test_reject_wrong_identity_duplicate_frames_or_bad_exit(self):
        for output in (status_output(id='another'), status_output() + status_output(),
                       status_output().replace('Launcher exit: 0', 'Launcher exit: 1')):
            self.assertIsNone(runner.native_health(output))

    def test_tex_requires_both_availability_and_sandbox(self):
        self.assertFalse(runner.native_health(status_output(sandbox=False), True)['ready'])
        self.assertTrue(runner.native_health(status_output(sandbox=True), True)['ready'])


class OrchestrationTests(unittest.TestCase):
    def run_with(self, args, audit=None, execute=None):
        calls = []
        def fake_execute(command, timeout):
            calls.append((command, timeout))
            return execute(command) if execute else completed(status_output())
        output = io.StringIO()
        with patch.object(runner, 'load_audit', return_value=SimpleNamespace(audit=lambda workspace: audit or audit_value())), \
             patch.object(runner, 'fixture_zip', return_value='artifacts/acceptance-project.zip'), \
             patch.object(runner, 'pnpm_command', return_value=['pnpm.exe']), \
             patch.object(runner.shutil, 'which', return_value='node.exe'), contextlib.redirect_stdout(output):
            report = runner.Runner(args, execute=fake_execute).run()
        return report, calls, output.getvalue()

    def test_default_only_probes_status_without_setup_or_inference(self):
        report, calls, _ = self.run_with(options())
        self.assertEqual(len(calls), 1)
        self.assertTrue(calls[0][0][-1].endswith('windows-native-smoke.py'))
        self.assertEqual(report['automatedResult'], 'PASS')
        self.assertEqual(report['overallResult'], 'MANUAL')
        self.assertTrue(all(step['status'] == 'MANUAL' for step in report['manualChecks']))
        self.assertEqual(report['modelRequests'], 0)

    def test_api_only_never_probes_codex_or_provider(self):
        report, calls, _ = self.run_with(options(api_only=True), audit_value(configured=False))
        self.assertEqual(calls, [])
        self.assertEqual(report['automatedResult'], 'PASS')
        self.assertEqual(next(c for c in report['checks'] if c['id'] == 'codex-health')['status'], 'SKIP')

    def test_unconfigured_workspace_fails_and_does_not_execute_installed_host(self):
        report, calls, _ = self.run_with(options(), audit_value(configured=False))
        self.assertEqual(report['automatedResult'], 'FAIL')
        self.assertEqual(calls, [])

    def test_build_failure_prevents_registration(self):
        def execute(command):
            return completed('v24.0.0') if command[-1] == '--version' else completed('raw SECRET_NOT_FOR_REPORT', code=1)
        report, calls, output = self.run_with(options(setup=True, workspace=Path('C:/project')), execute=execute)
        self.assertEqual(report['automatedResult'], 'FAIL')
        self.assertFalse(any('install_codex.py' in str(command) or runner.REGISTER_TEX in command for command, _ in calls))
        self.assertNotIn('SECRET_NOT_FOR_REPORT', output + json.dumps(report))

    def test_setup_uses_current_python_registers_tex_without_acl_config(self):
        def execute(command):
            return completed('v24.0.0') if command[-1] == '--version' else completed(status_output())
        workspace = Path('C:/project with spaces & symbols')
        report, calls, _ = self.run_with(options(setup=True, workspace=workspace), execute=execute)
        commands = [command for command, _ in calls]
        installer = next(command for command in commands if any(str(v).endswith('install_codex.py') for v in command))
        self.assertEqual(installer[0], runner.sys.executable)
        self.assertEqual(installer[-2:], ['--workspace', str(workspace)])
        self.assertTrue(any(runner.REGISTER_TEX in command for command in commands))
        self.assertFalse(any('--configure' in command for command in commands))
        self.assertEqual(report['automatedResult'], 'PASS')

    def test_timeout_is_failed_and_raw_diagnostics_not_retained(self):
        report, _, output = self.run_with(options(), execute=lambda _: completed('sk-secret\nprivate@example.invalid', code=-1, timed_out=True))
        self.assertEqual(report['automatedResult'], 'FAIL')
        self.assertNotIn('sk-secret', output + json.dumps(report))
        self.assertNotIn('private@example.invalid', output + json.dumps(report))

    def test_full_includes_runner_tests_and_records_native_skips(self):
        def execute(command):
            if command[-1] == '--version':
                return completed('v24.0.0')
            if 'native/tests' in command:
                return completed('Ran 421 tests in 1s\nOK (skipped=15)')
            if 'scripts/tests' in command:
                return completed('Ran 22 tests in 1s\nOK')
            return completed(status_output())
        report, calls, _ = self.run_with(options(full=True), execute=execute)
        self.assertTrue(any('scripts/tests' in command for command, _ in calls))
        result = next(check for check in report['checks'] if check['id'] == 'native-regression')
        self.assertEqual((result['total'], result['skipped']), (421, 15))

    def test_api_only_setup_registers_without_codex_binary_or_reader_changes(self):
        def execute(command):
            return completed('v24.0.0') if command[-1] == '--version' else completed()
        report, calls, _ = self.run_with(options(setup=True, api_only=True), audit_value(configured=False), execute)
        commands = [command for command, _ in calls]
        self.assertTrue(any(runner.REGISTER_API in command for command in commands))
        self.assertFalse(any(command[-1].endswith('windows-native-smoke.py') or '--workspace' in command or '--install' in command for command in commands))
        self.assertNotIn('configure_reader_mcp', runner.REGISTER_API)
        self.assertEqual(report['automatedResult'], 'PASS')

    def test_api_only_setup_does_not_install_optional_tex_dependency(self):
        def execute(command):
            if 'import win32api, win32security' in command:
                return completed(code=1)
            return completed('v24.0.0') if command[-1] == '--version' else completed()
        report, calls, _ = self.run_with(options(setup=True, api_only=True), audit_value(configured=False), execute)
        self.assertEqual(report['automatedResult'], 'PASS')
        self.assertFalse(any('pip' in command or 'import win32api, win32security' in command for command, _ in calls))

    def test_zero_runner_tests_are_not_a_successful_full_regression(self):
        def execute(command):
            if command[-1] == '--version':
                return completed('v24.0.0')
            if 'scripts/tests' in command:
                return completed('Ran 0 tests in 0s\nOK')
            if 'native/tests' in command:
                return completed('Ran 421 tests in 1s\nOK (skipped=15)')
            return completed(status_output())
        report, _, _ = self.run_with(options(full=True), execute=execute)
        self.assertEqual(report['automatedResult'], 'FAIL')
        self.assertEqual(next(c for c in report['checks'] if c['id'] == 'runner-regression')['status'], 'FAIL')

    def test_zero_or_missing_native_test_counts_fail(self):
        for footer in ('Ran 0 tests in 0s\nOK', 'OK', 'Ran 10 tests in 1s'):
            def execute(command):
                if command[-1] == '--version':
                    return completed('v24.0.0')
                return completed(footer if 'native/tests' in command else status_output())
            report, _, _ = self.run_with(options(full=True), execute=execute)
            self.assertEqual(report['automatedResult'], 'FAIL')
            self.assertEqual(next(c for c in report['checks'] if c['id'] == 'native-regression')['status'], 'FAIL')

    def test_truncated_successful_process_is_not_passed(self):
        def execute(command):
            if command[-1] == '--version':
                return completed('v24.0.0')
            result = completed('large output')
            result['truncated'] = True
            return result
        report, _, _ = self.run_with(options(full=True), execute=execute)
        self.assertEqual(report['automatedResult'], 'FAIL')
        self.assertEqual(next(c for c in report['checks'] if c['id'] == 'frontend-regression')['status'], 'FAIL')


class InputAndArtifactTests(unittest.TestCase):
    def test_setup_requires_explicit_workspace_or_api_only(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            runner.parse_args(['--setup'])

    def test_tex_permission_changes_require_explicit_setup(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            runner.parse_args(['--tex-root', str(SCRIPT.parent)])

    def test_report_cannot_overwrite_source_or_user_configuration(self):
        for path in (runner.ROOT / 'package.json', Path.home() / '.codex' / 'config.json'):
            with self.assertRaises(ValueError):
                runner.checked_output(path)

    def test_zip_contains_only_committed_fixture_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture = root / 'acceptance' / 'project'
            fixture.mkdir(parents=True)
            (fixture / 'main.tex').write_text('synthetic main')
            (fixture / 'chapter.tex').write_text('synthetic chapter')
            (fixture / 'auth.json').write_text('PRIVATE_IGNORED')
            with patch.object(runner, 'ROOT', root), patch.object(runner, 'ARTIFACTS', root / 'artifacts'), \
                 patch.object(runner, 'load_audit', return_value=SimpleNamespace(check_components=lambda path: None, read_bytes=lambda path, limit: path.read_bytes())):
                runner.fixture_zip()
            with zipfile.ZipFile(root / 'artifacts' / 'acceptance-project.zip') as archive:
                self.assertEqual(archive.namelist(), ['main.tex', 'chapter.tex'])
                self.assertEqual(archive.read('main.tex'), b'synthetic main')

    def test_fragmented_native_frame_is_read_exactly(self):
        class Fragmented:
            def __init__(self):
                self.stream = io.BytesIO(b'12345')
            def read(self, count):
                return self.stream.read(min(count, 1))
        self.assertEqual(smoke.read_exact(Fragmented(), 5), b'12345')
        with self.assertRaises(EOFError):
            smoke.read_exact(Fragmented(), 6)


@unittest.skipUnless(os.name == 'nt', 'Windows process jobs and cmd semantics')
class WindowsProcessTests(unittest.TestCase):
    def assert_dead(self, pid):
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.WaitForSingleObject.restype = wintypes.DWORD
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x100000, False, pid)
        if handle:
            try:
                self.assertEqual(kernel.WaitForSingleObject(handle, 5000), 0)
            finally:
                kernel.CloseHandle(handle)

    def test_parent_exit_cleans_child_holding_stdout(self):
        code = "import subprocess,sys; p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); print(p.pid,flush=True)"
        result = runner.run_command([runner.sys.executable, '-c', code], 10)
        self.assertEqual(result['returncode'], 0)
        self.assertFalse(result['truncated'])
        self.assert_dead(int(result['output'].strip()))

    def test_timeout_kills_only_new_parent_and_child_tree(self):
        code = "import subprocess,sys,time; p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); print(p.pid,flush=True); time.sleep(60)"
        result = runner.run_command([runner.sys.executable, '-c', code], 1)
        self.assertTrue(result['timedOut'])
        self.assert_dead(int(result['output'].strip()))

    def test_launcher_metacharacters_are_literal_and_not_reexpanded(self):
        for leaf in ('no-space&folder', 'spaces & %OPT_TEST_VALUE% ! folder'):
            with self.subTest(leaf=leaf), tempfile.TemporaryDirectory() as directory:
                folder = Path(directory) / leaf
                folder.mkdir()
                script = folder / 'launch.cmd'
                script.write_text('@echo off\necho OPT_LITERAL_PATH_OK\n', encoding='utf-8')
                with patch.dict(os.environ, {'OPT_TEST_VALUE': 'WRONG_PATH'}):
                    command, env = smoke.launcher_command(script)
                process = subprocess.Popen(command, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                           stderr=subprocess.PIPE, creationflags=subprocess.CREATE_NO_WINDOW | 0x4)
                job = None
                try:
                    job = smoke.process_job(process)
                    stdout, stderr = process.communicate(timeout=5)
                    self.assertEqual(process.returncode, 0, stderr.decode(errors='replace'))
                    self.assertEqual(stdout.strip(), b'OPT_LITERAL_PATH_OK')
                finally:
                    if job:
                        job.close()
                    elif process.poll() is None:
                        process.kill()


if __name__ == '__main__':
    unittest.main()
