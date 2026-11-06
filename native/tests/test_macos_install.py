"""Real macOS installation/launch smoke checks in disposable synthetic homes."""
import json
import os
from pathlib import Path
import select
import struct
import subprocess
import sys
import tempfile
import time
import unittest

from test_codex_host import installer, ROOT


@unittest.skipUnless(sys.platform == 'darwin', 'macOS native installation')
class MacOSInstallationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='opt-mac-install-')
        # macOS exposes its system temporary root through /var -> /private/var.
        # Canonicalize this fixture, never an untrusted production destination.
        self.home = Path(self.temporary.name).resolve() / 'Synthetic user & space'
        self.home.mkdir()
        self.environment = dict(os.environ, HOME=str(self.home), PATH='/usr/bin:/bin')

    def tearDown(self):
        self.temporary.cleanup()

    def command(self, *arguments):
        return subprocess.run(['/usr/bin/python3', str(ROOT / 'native/install_codex.py'), *arguments],
                              env=self.environment, stdin=subprocess.DEVNULL, capture_output=True,
                              timeout=15)

    def install_api(self):
        result = self.command('--install', '--api-only')
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        return installer.paths(self.home)

    def test_api_only_installs_complete_private_copy_without_codex_configuration(self):
        directory, manifest = self.install_api()
        self.assertFalse((self.home / '.codex').exists())
        self.assertFalse((directory / installer.READER_MARKER).exists())
        for name in ('codex_host.py', 'desktop_ipc.py', 'desktop_state.py', 'api_provider.py',
                     'prompt_display.py', 'project_context.py', 'manuscript_mcp.py',
                     'context_transport.py', 'platform_utils.py', 'windows_desktop.py', 'cache_lifecycle.py'):
            with self.subTest(name=name):
                self.assertEqual((directory / name).read_bytes(), (ROOT / 'native' / name).read_bytes())
                self.assertEqual((directory / name).stat().st_mode & 0o777, 0o600)
        self.assertEqual((directory / installer.LAUNCH_NAME).stat().st_mode & 0o777, 0o700)
        registration = json.loads(manifest.read_text())
        identifier = installer.extension_id(json.loads((ROOT / 'manifest.json').read_text()))
        self.assertEqual(registration['allowed_origins'], ['chrome-extension://' + identifier + '/'])
        self.assertEqual(registration['path'], str(directory / installer.LAUNCH_NAME))

    def test_installed_launcher_exchanges_native_frames_without_codex_or_inference(self):
        directory, _ = self.install_api()
        process = subprocess.Popen([str(directory / installer.LAUNCH_NAME)], env=self.environment,
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            body = json.dumps({'version': 1, 'id': 'mac-install-smoke', 'op': 'provider-list'}).encode()
            process.stdin.write(struct.pack('<I', len(body)) + body)
            process.stdin.flush()
            response = bytearray()
            target = 4
            deadline = time.monotonic() + 10
            while len(response) < target:
                remaining = deadline - time.monotonic()
                self.assertGreater(remaining, 0, 'Installed helper did not return a complete native frame.')
                ready, _, _ = select.select([process.stdout], [], [], remaining)
                self.assertTrue(ready, 'Installed helper did not return a native frame.')
                chunk = os.read(process.stdout.fileno(), target - len(response))
                self.assertTrue(chunk, 'Installed helper closed before its response.')
                response.extend(chunk)
                if len(response) == 4:
                    size = struct.unpack('<I', response)[0]
                    self.assertLessEqual(size, 1024 * 1024)
                    target += size
            result = json.loads(response[4:])
            self.assertEqual((result['type'], result['id'], result['profiles']),
                             ('profiles', 'mac-install-smoke', []))
            process.stdin.close()
            process.wait(timeout=5)
            self.assertEqual(process.returncode, 0)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            for stream in (process.stdin, process.stdout, process.stderr):
                stream.close()

    def test_api_only_update_and_uninstall_preserve_data_and_other_host(self):
        directory, manifest = self.install_api()
        retained = directory.parent / 'api-connections'
        retained.mkdir()
        (retained / 'synthetic-data').write_text('retain')
        other = directory.parent / 'native-host'
        other.mkdir()
        (other / 'sentinel').write_text('other helper')
        self.install_api()
        result = self.command('--uninstall', '--api-only')
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertFalse(directory.exists())
        self.assertFalse(manifest.exists())
        self.assertEqual((retained / 'synthetic-data').read_text(), 'retain')
        self.assertEqual((other / 'sentinel').read_text(), 'other helper')

    def test_api_only_rejects_codex_workspace_options_before_installing(self):
        for option, value in (('--workspace', str(self.home)), ('--project-id', 'a' * 36)):
            with self.subTest(option=option):
                result = self.command('--install', '--api-only', option, value)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(b'cannot be combined', result.stderr)
        self.assertFalse(installer.paths(self.home)[0].exists())

    def test_api_only_removal_cannot_orphan_existing_codex_reader_registration(self):
        directory, manifest = self.install_api()
        (directory / installer.READER_MARKER).write_text('{}')
        result = self.command('--uninstall', '--api-only')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'Codex reader registration', result.stderr)
        self.assertTrue(directory.exists())
        self.assertTrue(manifest.exists())


if __name__ == '__main__':
    unittest.main()
