"""Install explicitly, then verify Windows helpers without sending model requests.

Default: inspect this checkout and installation, probe public native health,
and write a sanitized report plus a synthetic Overleaf ZIP under artifacts/.
--setup installs dependencies/builds/registers helpers. --tex-root explicitly
configures TeX read capability; no command elevates privileges automatically.
PASS means an automated check passed, never that the manual UI checklist ran.
"""
import argparse
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import threading
import time
import zipfile


ROOT = Path(__file__).absolute().parents[1]
ARTIFACTS = ROOT / 'artifacts'
MAX_CAPTURE = 2 * 1024 * 1024
REGISTER_TEX = """import json, pathlib, runpy, sys
root = pathlib.Path(sys.argv[1])
setup = runpy.run_path(str(root / 'native' / 'install.py'))
manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
setup['install'](setup['extension_id'](manifest), root / 'native' / 'host.py', pathlib.Path.home())
"""


def load_audit():
    spec = importlib.util.spec_from_file_location('opt_installation_audit', ROOT / 'scripts' / 'windows-installation-audit.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


REGISTER_API = REGISTER_TEX.replace("'install.py'", "'install_codex.py'").replace("'host.py'", "'codex_host.py'")


def checked_output(path):
    path = Path(os.path.abspath(path))
    load_audit().check_components(path)
    # Reports are disposable, but never overwrite source, settings or secrets.
    if path.suffix.lower() != '.json' or ARTIFACTS not in path.parents:
        raise ValueError('Choose a .json report under this checkout\'s artifacts directory.')
    return path


def run_command(command, timeout):
    """Drain output with a memory bound; never print/store raw subprocess output."""
    flags = (subprocess.CREATE_NO_WINDOW | 0x4) if os.name == 'nt' else 0
    job = None
    try:
        process = subprocess.Popen(command, cwd=str(ROOT), stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                   creationflags=flags)
    except OSError:
        return {'returncode': None, 'timedOut': False, 'launchFailed': True, 'output': '', 'truncated': False}
    if os.name == 'nt':
        try:
            spec = importlib.util.spec_from_file_location('opt_runner_process_job', ROOT / 'native' / 'windows_desktop.py')
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            job = module.ProcessJob(process, suspended=True)
        except Exception:
            process.kill()
            process.wait(timeout=5)
            process.stdout.close()
            return {'returncode': None, 'timedOut': False, 'launchFailed': True, 'output': '', 'truncated': False}
    chunks, size, truncated = [], 0, False

    def drain():
        nonlocal size, truncated
        while True:
            block = process.stdout.read(8192)
            if not block:
                break
            if size < MAX_CAPTURE:
                chunks.append(block[:MAX_CAPTURE - size])
            size += len(block)
            truncated = size > MAX_CAPTURE

    reader = threading.Thread(target=drain, daemon=True)
    reader.start()
    timed_out = False
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        if job:
            job.close()
        if process.poll() is None:
            process.kill()
        process.wait(timeout=10)
    finally:
        if job:
            job.close()
    reader.join(timeout=3)
    # A descendant holding stdout cannot keep this runner waiting forever.
    if reader.is_alive():
        truncated = True
    else:
        process.stdout.close()
    return {'returncode': process.returncode, 'timedOut': timed_out,
            'launchFailed': False, 'truncated': truncated,
            'output': b''.join(chunks).decode('utf-8', errors='replace')}


def pnpm_command():
    """Avoid sending arbitrary installation paths through cmd.exe parsing."""
    executable = shutil.which('pnpm')
    if not executable:
        return None
    path = Path(executable)
    if path.suffix.lower() == '.exe':
        return [str(path)]
    standalone = path.parent / 'node_modules' / 'pnpm' / 'pnpm.exe'
    if standalone.is_file():
        return [str(standalone)]
    node = shutil.which('node')
    if node:
        for script in (path.parent / 'node_modules' / 'pnpm' / 'bin' / 'pnpm.cjs',
                       path.parent / 'node_modules' / 'corepack' / 'dist' / 'pnpm.js'):
            if script.is_file():
                return [node, str(script)]
    return None


def native_health(output, tex=False):
    """Use a strict allowlist: account data, models and diagnostics are omitted."""
    candidates = []
    for line in output.splitlines():
        try:
            value = json.loads(line)
        except (ValueError, TypeError):
            continue
        if isinstance(value, dict) and value.get('id') == 'windows-smoke-status':
            if (tex and 'available' in value) or (not tex and value.get('type') == 'status'):
                candidates.append(value)
    if len(candidates) != 1 or not re.search(r'^Launcher exit: 0\s*$', output, re.M):
        return None
    value = candidates[0]
    result = {'available': value.get('available') is True}
    if tex:
        result['sandbox'] = value.get('sandbox') is True
        result['ready'] = result['available'] and result['sandbox']
    else:
        result.update(authenticated=value.get('authenticated') is True,
                      projectReaderReady=value.get('projectReaderReady') is True,
                      standalone=value.get('connectionKind') == 'standalone')
        result['ready'] = all(result.values())
    version = value.get('version')
    if isinstance(version, str) and re.fullmatch(r'\d+(?:\.\d+){1,3}', version):
        result['version'] = version
    return result


def fixture_zip():
    destination = ARTIFACTS / 'acceptance-project.zip'
    audit = load_audit()
    audit.check_components(destination)
    files = [(ROOT / 'acceptance' / 'project' / name, name) for name in ('main.tex', 'chapter.tex')]
    data = [(name, audit.read_bytes(path, 64 * 1024)) for path, name in files]
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in data:
            archive.writestr(name, content)
    return 'artifacts/acceptance-project.zip'


def manual_checks(api_only=False, local_tex=False):
    checks = [
        ('chrome', 'Load dist in chrome://extensions once (or Reload the existing extension), then refresh Overleaf.'),
        ('synthetic-project', 'Upload artifacts/acceptance-project.zip as a NEW Overleaf project; do not test on a manuscript.'),
        ('inference', 'Follow acceptance/README.md: verify a real synthetic reply and cancellation using Normal context; cross-file tools are optional provider capabilities.' if api_only else 'Follow acceptance/README.md: read both test files and verify the two sentinels.'),
        ('interaction', 'Verify Stop retains partial text after refresh, queue/steer, formula copy, preview and cache lifecycle using the guide.'),
    ]
    if not api_only:
        checks.append(('desktop', 'Open the same test conversation in Codex; verify both directions and separately check sidebar project membership. Move it if needed.'))
    if local_tex:
        checks.append(('local-preview', 'In LaTeX Preview choose TeX / Local and verify an actual formula image in the test project.'))
    if api_only:
        checks.append(('api-credentials', 'Enter your provider key yourself in Manage API connections. The runner never reads or tests that key.'))
    return [{'id': key, 'status': 'MANUAL', 'detail': detail} for key, detail in checks]


class Runner:
    def __init__(self, options, execute=run_command):
        self.options, self.execute, self.checks = options, execute, []

    def add(self, key, status, detail, **metadata):
        check = {'id': key, 'status': status, 'detail': detail, **metadata}
        self.checks.append(check)
        print('[%s] %s: %s' % (status, key, detail), flush=True)
        return status == 'PASS'

    def command(self, key, command, timeout, failure):
        print('[RUN] ' + key, flush=True)
        started = time.monotonic()
        result = self.execute(command, timeout)
        ok = result['returncode'] == 0 and not result['timedOut'] and not result['launchFailed'] and not result['truncated']
        self.add(key, 'PASS' if ok else 'FAIL', 'Completed.' if ok else failure,
                 seconds=round(time.monotonic() - started, 2), timedOut=result['timedOut'],
                 exitCode=result['returncode'], outputTruncated=result['truncated'])
        return ok, result

    def unittest_command(self, key, command, timeout, failure):
        ok, result = self.command(key, command, timeout, failure)
        if not ok:
            return
        count = re.search(r'Ran (\d+) tests?', result['output'])
        terminal = re.search(r'^OK(?: \(skipped=(\d+)\))?\s*$', result['output'], re.M)
        if not count or int(count[1]) <= 0 or not terminal:
            self.checks[-1].update(status='FAIL', detail='Suite did not report a positive test count and final OK; no pass is claimed.')
            print('[FAIL] ' + key + ': Missing positive test count or final OK.', flush=True)
        else:
            self.checks[-1].update(total=int(count[1]), skipped=int(terminal[1] or 0))

    def run(self):
        args, python = self.options, [sys.executable, '-X', 'utf8']
        self.add('platform', 'PASS', 'Windows; same account as Chrome is required.')
        node = shutil.which('node')
        pnpm = pnpm_command()
        build_ready = True
        if args.setup or args.full:
            node_check = self.execute([node, '--version'], 10) if node else None
            match = re.fullmatch(r'v(\d+)\.\d+\.\d+\s*', node_check['output']) if node_check and node_check['returncode'] == 0 else None
            build_ready = self.add('build-tools', 'PASS' if match and int(match[1]) >= 22 and pnpm else 'FAIL',
                                   'Node 22+ and pnpm found.' if match and int(match[1]) >= 22 and pnpm else 'Install Node 22+ and pnpm, reopen PowerShell, then rerun. Standard npm/corepack or standalone pnpm is supported.')
        if args.setup and build_ready and (args.local_tex or args.tex_root):
            dependency_check = self.execute(python + ['-c', 'import win32api, win32security'], 10)
            if dependency_check['returncode'] != 0:
                build_ready, _ = self.command('python-dependencies', python + ['-m', 'pip', 'install', 'pywin32'], 300,
                                             'Install pywin32 for this Python, then rerun. No elevation is attempted.')
        if args.setup and build_ready:
            build_ready, _ = self.command('dependencies', pnpm + ['install', '--frozen-lockfile'], 600, 'Dependency installation failed. Check network access and rerun; raw package output was not recorded.')
            if build_ready:
                build_ready, _ = self.command('build', pnpm + ['build'], 180, 'Build failed. Run pnpm build locally for diagnostics.')
        elif args.setup:
            self.add('setup', 'SKIP', 'Build prerequisites failed; helpers were not changed.')
        if args.setup and build_ready:
            command = python + (['-c', REGISTER_API, str(ROOT)] if args.api_only else [str(ROOT / 'native' / 'install_codex.py'), '--install'])
            if args.workspace and not args.api_only:
                command += ['--workspace', str(args.workspace)]
            self.command('register-codex-api', command, 120, 'Registration failed. Check this Python and existing host ownership. For Codex mode, sign in and create/open the specified workspace in Codex first.')
            self.command('register-tex', python + ['-c', REGISTER_TEX, str(ROOT)], 60,
                         'TeX host registration failed. Existing unrelated installations are not overwritten; inspect native/install.py locally.')
        if args.tex_root and build_ready:
            ok, _ = self.command('configure-tex', python + [str(ROOT / 'native' / 'windows_tex.py'), '--configure', str(args.tex_root)], 180,
                                 'TeX capability setup failed. Check TeX Live and pywin32. If access is denied, run only the one-time TeX configuration command as administrator; then rerun verification.')
            if not ok:
                quoted = lambda value: "'" + str(value).replace("'", "''") + "'"
                print('One-time PowerShell command (no automatic elevation):\n& %s -X utf8 %s --configure %s' %
                      (quoted(sys.executable), quoted(ROOT / 'native' / 'windows_tex.py'), quoted(args.tex_root)), flush=True)
        if args.full and build_ready:
            self.command('frontend-regression', pnpm + ['check'], 600, 'Frontend regression failed. Run pnpm check locally for diagnostics.')
            self.unittest_command('native-regression', python + ['-m', 'unittest', 'discover', '-s', 'native/tests'], 600,
                                      'Native regression failed. Run python -X utf8 -m unittest discover -s native/tests locally for diagnostics.')
            self.unittest_command('runner-regression', python + ['-m', 'unittest', 'discover', '-s', 'scripts/tests'], 120,
                         'Acceptance runner regression failed. Run python -X utf8 -m unittest discover -s scripts/tests locally for diagnostics.')
        elif not args.full:
            self.add('regression-suite', 'SKIP', 'Optional developer checks; use --full. Skipped checks are not passes.')
        else:
            self.add('regression-suite', 'SKIP', 'Build prerequisites failed; the requested regression suites did not run.')

        audit = load_audit().audit(args.workspace)
        self.extension_version = audit.get('version') if isinstance(audit.get('version'), str) and re.fullmatch(r'\d+(?:\.\d+){1,3}', audit['version']) else None
        configured = audit['workspaceConfiguration']['status'] == 'configured'
        audit_ok = audit['result'] == 'passed' and (configured or args.api_only)
        self.add('installation', 'PASS' if audit_ok else 'FAIL',
                 'Installed files, versions, registration and requested workspace match.' if audit_ok else
                 'Installation or workspace mismatch. Rerun --setup with the same Python and your Codex workspace (or --api-only). Detailed read-only diagnostics: scripts/windows-installation-audit.py.',
                 pythonCopiesMatched=audit['pythonCopiesMatched'], pythonCopiesChecked=audit['pythonCopiesChecked'],
                 workspaceConfigured=configured, backendProjectVerified=False)
        if audit_ok and not args.api_only:
            self.probe(python, False)
        else:
            self.add('codex-health', 'SKIP', 'API-only selected; provider validation remains manual.' if args.api_only else 'Installation failed; no installed program was launched.')
        if args.local_tex or args.tex_root:
            if audit_ok:
                self.probe(python, True)
            else:
                self.add('tex-health', 'SKIP', 'Installation failed; no installed program was launched.')
        else:
            self.add('tex-health', 'SKIP', 'Optional local TeX not requested. MathJax/cloud preview do not require it.')
        try:
            location = fixture_zip()
            self.add('synthetic-zip', 'PASS', 'Prepared ' + location + ' from the two committed synthetic files.')
        except (OSError, ValueError):
            self.add('synthetic-zip', 'FAIL', 'Could not package acceptance/project. Check the checkout and artifacts directory.')
        return self.report()

    def probe(self, python, tex):
        key = 'tex-health' if tex else 'codex-health'
        print('[RUN] ' + key, flush=True)
        result = self.execute(python + [str(ROOT / 'scripts' / 'windows-native-smoke.py')] + (['--tex'] if tex else []), 85)
        health = native_health(result['output'], tex) if result['returncode'] == 0 and not result['timedOut'] and not result['truncated'] else None
        good = health and health['ready']
        detail = ('Sandbox compiled a disposable formula.' if tex else 'Local Codex authentication and project reader checked; no inference or Desktop connection was tested.') if good else (
            'Local TeX is unavailable. Check TeX Live, pywin32 and the one-time capability configuration; cloud/MathJax remain alternatives.' if tex else
            'Codex health failed or timed out. Sign in locally, rerun --setup if needed, then retry. No question was sent.')
        self.add(key, 'PASS' if good else 'FAIL', detail, health=health, timedOut=result['timedOut'])

    def report(self):
        failed = any(check['status'] == 'FAIL' for check in self.checks)
        return {'schemaVersion': 1, 'checkedAt': datetime.now(timezone.utc).isoformat(),
                'extensionVersion': getattr(self, 'extension_version', None),
                'automatedResult': 'FAIL' if failed else 'PASS', 'overallResult': 'FAIL' if failed else 'MANUAL',
                'modelRequests': 0, 'browserAutomated': False, 'desktopSidebarVerified': False,
                'setupRequested': self.options.setup, 'checks': self.checks,
                'manualChecks': manual_checks(self.options.api_only, self.options.local_tex or bool(self.options.tex_root)),
                'guide': 'acceptance/README.md'}


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--setup', action='store_true', help='Explicitly install dependencies, build and register/update helpers for this Windows user.')
    parser.add_argument('--workspace', type=Path, help='Existing local Codex workspace; must already be a project in Codex.')
    parser.add_argument('--api-only', action='store_true', help='Skip Codex authentication checks; provider credentials and real API request stay manual.')
    parser.add_argument('--local-tex', action='store_true', help='Probe existing local TeX sandbox; no permission changes.')
    parser.add_argument('--tex-root', type=Path, help='With --setup, explicitly configure this TeX Live root and probe it; never auto-elevate.')
    parser.add_argument('--full', action='store_true', help='Also run frontend/native regression suites (builds dist and uses test temporary files).')
    parser.add_argument('--output', type=Path, default=ARTIFACTS / 'windows-acceptance.json', help='Sanitized JSON report under artifacts/.')
    args = parser.parse_args(argv)
    if args.setup and not args.workspace and not args.api_only:
        parser.error('--setup requires --workspace (an existing Codex project) or --api-only.')
    if args.tex_root and not args.setup:
        parser.error('--tex-root changes capability permissions and requires explicit --setup; use --local-tex for a probe only.')
    if args.api_only and args.workspace:
        parser.error('--api-only preserves existing Codex configuration; omit --workspace or remove --api-only to bind a Codex workspace.')
    for key in ('workspace', 'tex_root'):
        path = getattr(args, key)
        if path:
            path = Path(os.path.abspath(path))
            if not path.is_dir():
                parser.error('--' + key.replace('_', '-') + ' must be an existing directory.')
            setattr(args, key, path)
    try:
        args.output = checked_output(args.output)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    return args


def main(argv=None):
    args = parse_args(argv)
    if sys.platform != 'win32' or sys.version_info < (3, 9):
        print('This runner requires Windows and Python 3.9+. See acceptance/README.md for macOS guidance.')
        return 2
    report = Runner(args).run()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print('\nAutomated: %s; overall: %s. No model request was sent.' % (report['automatedResult'], report['overallResult']))
    print('Report: ' + str(args.output))
    if report['automatedResult'] == 'FAIL':
        print('Next: resolve the FAIL checks using acceptance/README.md and rerun. Manual acceptance remains unverified.')
    else:
        print('Next: follow acceptance/README.md; upload artifacts/acceptance-project.zip to a NEW Overleaf project.')
        for step in report['manualChecks']:
            print('[MANUAL] ' + step['detail'])
    return 1 if report['automatedResult'] == 'FAIL' else 0


if __name__ == '__main__':
    raise SystemExit(main())
