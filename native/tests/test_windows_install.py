"""Real Windows launcher encoding and confined installation repair tests."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import install as tex_installer
import install_codex as codex_installer
import native_setup


class InstallerRepairTests(unittest.TestCase):
    def test_missing_manifest_still_removes_only_owned_registry_reference(self):
        for installer, name in ((tex_installer, 'host.py'), (codex_installer, 'codex_host.py')):
            with self.subTest(host=installer.HOST_NAME), tempfile.TemporaryDirectory() as folder:
                home = Path(folder) / 'user'
                source = Path(folder) / name
                source.write_text('# synthetic\n')
                with mock.patch.object(installer, 'registration') as registry:
                    directory, manifest = installer.install('a' * 32, source, home)
                    manifest.unlink()
                    registry.reset_mock()
                    installer.uninstall(home)
                    registry.assert_called_once_with(home, installer.HOST_NAME, manifest, remove=True)
                    self.assertFalse(directory.exists())

    @unittest.skipUnless(os.name == 'nt', 'Windows CMD encoding regression')
    def test_real_launcher_preserves_unicode_space_percent_and_binary_frames(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder) / '中文 spaced % marker & bang!'
            directory.mkdir()
            script = directory / 'host.py'
            script.write_text('import sys\nsys.stdout.buffer.write(sys.stdin.buffer.read())\n', encoding='utf-8')
            launch = directory / native_setup.LAUNCH_NAME
            launch.write_bytes(native_setup.launcher(directory, 'host.py'))
            data = b'\x1a\x00\r\n' + '中文😀'.encode('utf-8') + bytes(range(256))
            command = '"' + os.environ['COMSPEC'] + '" /d /s /c ""' + str(launch) + '""'
            result = subprocess.run(command, input=data,
                                    capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, data)


if __name__ == '__main__':
    unittest.main()
