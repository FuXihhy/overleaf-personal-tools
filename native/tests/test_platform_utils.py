"""Real Windows ACL, reparse-point, byte-I/O and process-lock checks.

All files, ACL changes and junctions are confined to a newly created synthetic
temporary tree. These tests require no symlink privilege, account secrets or UI.
They do not mock the Windows security APIs or the filesystem.
"""
import multiprocessing
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import platform_utils as platform
import project_context as context


def lock_holder(path, ready, release, result):
    descriptor = None
    try:
        descriptor = os.open(path, os.O_RDWR | getattr(os, 'O_BINARY', 0))
        platform.fcntl.flock(descriptor, platform.fcntl.LOCK_EX)
        ready.set()
        if not release.wait(15):
            raise TimeoutError('Synthetic lock holder did not receive release.')
        result.put(('ok', 'released'))
    except Exception as error:
        result.put(('error', type(error).__name__ + ': ' + str(error)))
    finally:
        if descriptor is not None:
            os.close(descriptor)


def lock_contender(path, started, acquired, result):
    descriptor = None
    try:
        descriptor = os.open(path, os.O_RDWR | getattr(os, 'O_BINARY', 0))
        started.set()
        platform.fcntl.flock(descriptor, platform.fcntl.LOCK_EX)
        acquired.set()
        result.put(('ok', 'acquired'))
    except Exception as error:
        result.put(('error', type(error).__name__ + ': ' + str(error)))
    finally:
        if descriptor is not None:
            os.close(descriptor)


@unittest.skipUnless(sys.platform == 'win32', 'Exercises the real Windows security and filesystem APIs.')
class WindowsPlatformSecurityTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='opt-security-')
        self.base = Path(self.temporary.name).resolve()
        self.private = self.base / 'private'
        platform.private_directory(self.private)
        self.junctions = []

    def tearDown(self):
        # Remove our junction entries non-recursively before TemporaryDirectory
        # traverses its own tree. Targets are synthetic siblings under self.base.
        for junction in self.junctions:
            self.assertTrue(junction.parent.resolve().is_relative_to(self.base))
            if platform.is_link(junction):
                os.rmdir(junction)
        self.temporary.cleanup()

    def junction(self, target, name):
        import _winapi
        path = self.base / name
        self.assertTrue(target.resolve().is_relative_to(self.base))
        _winapi.CreateJunction(str(target), str(path))
        self.junctions.append(path)
        return path

    def broad_acl(self, path):
        """Give Everyone read access to a synthetic object using the real DACL."""
        self.assertTrue(path.absolute().is_relative_to(self.base))
        ctypes, w, adv, kernel = platform.ctypes, platform.w, platform.adv, platform.kernel
        descriptor = w.LPVOID()
        sddl = 'D:P(A;OICI;FA;;;%s)(A;OICI;FA;;;SY)(A;OICI;FR;;;WD)' % platform.CURRENT_SID
        if not adv.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(descriptor), None):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            present, defaulted, dacl = w.BOOL(), w.BOOL(), w.LPVOID()
            if not adv.GetSecurityDescriptorDacl(descriptor, ctypes.byref(present), ctypes.byref(dacl), ctypes.byref(defaulted)):
                raise ctypes.WinError(ctypes.get_last_error())
            code = adv.SetNamedSecurityInfoW(str(path), 1, 0x80000004, None, None, dacl, None)
            if code:
                raise ctypes.WinError(code)
        finally:
            kernel.LocalFree(descriptor)

    def test_real_junction_root_is_rejected_without_changing_target(self):
        target = self.base / 'target'; target.mkdir()
        sentinel = target / 'untouched.txt'; sentinel.write_bytes(b'synthetic sentinel')
        junction = self.junction(target, 'root-junction')
        self.assertTrue(platform.is_link(junction))
        with self.assertRaisesRegex(ValueError, 'reparse|symlink'):
            platform.private_directory(junction)
        with self.assertRaisesRegex(context.ProjectContextError, 'symlink'):
            context.ProjectContextStore(junction)
        self.assertEqual(sentinel.read_bytes(), b'synthetic sentinel')
        self.assertEqual(sorted(p.name for p in target.iterdir()), ['untouched.txt'])

    def test_real_junction_parent_is_rejected_before_child_creation(self):
        target = self.base / 'target'; target.mkdir()
        junction = self.junction(target, 'parent-junction')
        child = junction / 'must-not-be-created'
        with self.assertRaisesRegex(ValueError, 'reparse|symlink'):
            platform.check_components(child)
        with self.assertRaises(ValueError):
            platform.private_directory(child)
        with self.assertRaises(context.ProjectContextError):
            context.ProjectContextStore(child)
        self.assertFalse((target / child.name).exists())

    def test_atomic_write_rejects_junction_destination(self):
        target = self.base / 'target'; target.mkdir()
        # This entry is placed within the private publication directory.
        import _winapi
        destination = self.private / 'snapshot.json'
        _winapi.CreateJunction(str(target), str(destination))
        self.junctions.append(destination)
        with self.assertRaises(context.ProjectContextError):
            context._atomic_bytes(destination, b'not a manuscript', immutable=True)
        self.assertTrue(platform.is_link(destination))
        self.assertEqual(list(target.iterdir()), [])

    def test_everyone_read_grant_is_rejected_and_repaired_on_same_open_file(self):
        path = self.private / 'profile-fixture.bin'
        context._atomic_bytes(path, b'synthetic non-secret')
        self.broad_acl(path)
        self.assertTrue(platform.owned_by_user(path))
        self.assertFalse(platform.is_private(path))
        with self.assertRaises(context.ProjectContextError):
            context._read_bytes(path, 1000)
        descriptor = os.open(path, os.O_RDONLY | os.O_BINARY)
        try:
            self.assertFalse(platform.is_private(descriptor))
            platform.private_permissions(descriptor, 0o600)
            self.assertTrue(platform.is_private(descriptor))
        finally:
            os.close(descriptor)
        self.assertTrue(platform.is_private(path))
        self.assertEqual(context._read_bytes(path, 1000), b'synthetic non-secret')

    def test_broad_directory_acl_is_detected_and_repaired(self):
        self.broad_acl(self.private)
        self.assertFalse(platform.is_private(self.private))
        with self.assertRaisesRegex(ValueError, 'non-private'):
            platform.touch_private_directory(self.private)
        platform.private_directory(self.private)
        self.assertTrue(platform.is_private(self.private))
        platform.touch_private_directory(self.private)
        child = self.private / 'inherited.bin'; child.write_bytes(b'synthetic')
        self.assertTrue(platform.is_private(child))

    def test_immutable_acl_denies_append_truncation_and_allows_explicit_owner_repair(self):
        path = self.private / 'immutable.bin'
        context._atomic_bytes(path, b'original', immutable=True)
        self.assertTrue(platform.is_private(path))
        for mode in ('ab', 'wb', 'r+b'):
            with self.subTest(mode=mode), self.assertRaises(PermissionError):
                with open(path, mode):
                    pass
        self.assertEqual(path.read_bytes(), b'original')
        # The owner retains WRITE_DAC; do not rely on Windows chmod/DOS flags.
        descriptor = os.open(path, os.O_RDONLY | os.O_BINARY)
        try:
            platform.private_permissions(descriptor, 0o600)
        finally:
            os.close(descriptor)
        path.write_bytes(b'explicitly repaired')
        platform.private_permissions(path, 0o400)
        self.assertEqual(context._read_bytes(path, 1000), b'explicitly repaired')
        with self.assertRaises(PermissionError):
            path.open('ab')

    def test_binary_ctrl_z_crlf_and_nul_roundtrip_without_crt_translation(self):
        content = b'first\r\nsecond\x1aafter-ctrl-z\n\x00\r\n' + bytes(range(256))
        for immutable in (False, True):
            with self.subTest(immutable=immutable):
                path = self.private / ('raw-%s.bin' % immutable)
                context._atomic_bytes(path, content, immutable=immutable)
                self.assertEqual(path.stat().st_size, len(content))
                self.assertEqual(path.read_bytes(), content)
                self.assertEqual(context._read_bytes(path, len(content)), content)

    def test_immutable_publication_never_clobbers_an_existing_file(self):
        path = self.private / 'snapshot.json'
        context._atomic_bytes(path, b'first immutable version', immutable=True)
        with self.assertRaises(context.ProjectContextError):
            context._atomic_bytes(path, b'wrong replacement', immutable=True)
        self.assertEqual(context._read_bytes(path, 1000), b'first immutable version')
        self.assertTrue(platform.is_private(path))
        self.assertEqual(sorted(p.name for p in self.private.iterdir()), ['snapshot.json'])

    def test_nonblocking_cross_process_lock_conflicts_then_releases_on_exit(self):
        path = self.private / 'process.lock'; context._atomic_bytes(path, b'lock')
        spawn = multiprocessing.get_context('spawn')
        ready, release, result = spawn.Event(), spawn.Event(), spawn.Queue()
        worker = spawn.Process(target=lock_holder, args=(str(path), ready, release, result))
        descriptor = os.open(path, os.O_RDWR | os.O_BINARY)
        try:
            worker.start()
            self.assertTrue(ready.wait(10), 'Child did not acquire the native byte-range lock.')
            os.lseek(descriptor, 2, os.SEEK_SET)
            with self.assertRaises(BlockingIOError):
                platform.fcntl.flock(descriptor, platform.fcntl.LOCK_EX | platform.fcntl.LOCK_NB)
            self.assertEqual(os.lseek(descriptor, 0, os.SEEK_CUR), 2)
            release.set(); worker.join(10)
            self.assertEqual(worker.exitcode, 0)
            self.assertEqual(result.get(timeout=5), ('ok', 'released'))
            platform.fcntl.flock(descriptor, platform.fcntl.LOCK_EX | platform.fcntl.LOCK_NB)
            self.assertEqual(os.lseek(descriptor, 0, os.SEEK_CUR), 2)
            platform.fcntl.flock(descriptor, platform.fcntl.LOCK_UN)
            self.assertEqual(os.lseek(descriptor, 0, os.SEEK_CUR), 2)
        finally:
            release.set()
            if worker.is_alive():
                worker.terminate(); worker.join(5)
            os.close(descriptor); result.close()

    def test_process_termination_releases_lock_without_cooperative_unlock(self):
        path = self.private / 'crash.lock'; context._atomic_bytes(path, b'lock')
        spawn = multiprocessing.get_context('spawn')
        ready, release, result = spawn.Event(), spawn.Event(), spawn.Queue()
        worker = spawn.Process(target=lock_holder, args=(str(path), ready, release, result))
        descriptor = os.open(path, os.O_RDWR | os.O_BINARY)
        try:
            worker.start()
            self.assertTrue(ready.wait(10))
            with self.assertRaises(BlockingIOError):
                platform.fcntl.flock(descriptor, platform.fcntl.LOCK_EX | platform.fcntl.LOCK_NB)
            worker.terminate(); worker.join(10)
            self.assertFalse(worker.is_alive())
            platform.fcntl.flock(descriptor, platform.fcntl.LOCK_EX | platform.fcntl.LOCK_NB)
            platform.fcntl.flock(descriptor, platform.fcntl.LOCK_UN)
        finally:
            if worker.is_alive():
                worker.terminate(); worker.join(5)
            os.close(descriptor); result.close()

    def test_blocking_contender_waits_for_actual_unlock(self):
        path = self.private / 'blocking.lock'; context._atomic_bytes(path, b'lock')
        spawn = multiprocessing.get_context('spawn')
        started, acquired, result = spawn.Event(), spawn.Event(), spawn.Queue()
        descriptor = os.open(path, os.O_RDWR | os.O_BINARY)
        worker = spawn.Process(target=lock_contender, args=(str(path), started, acquired, result))
        try:
            platform.fcntl.flock(descriptor, platform.fcntl.LOCK_EX)
            worker.start()
            self.assertTrue(started.wait(10))
            self.assertFalse(acquired.wait(0.2))
            platform.fcntl.flock(descriptor, platform.fcntl.LOCK_UN)
            self.assertTrue(acquired.wait(10))
            worker.join(10)
            self.assertEqual(worker.exitcode, 0)
            self.assertEqual(result.get(timeout=5), ('ok', 'acquired'))
        finally:
            os.close(descriptor)
            if worker.is_alive():
                worker.terminate(); worker.join(5)
            result.close()


if __name__ == '__main__':
    unittest.main()
