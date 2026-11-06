"""Cross-platform assertions for private synthetic test fixtures."""
import os
from pathlib import Path
import unittest
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from platform_utils import IS_WINDOWS, is_private, private_permissions


def assert_private(test, path, mode):
    test.assertTrue(is_private(path), 'The file/directory must have a private ACL or POSIX mode.')
    if not IS_WINDOWS:
        test.assertEqual(Path(path).stat().st_mode & 0o777, mode)
    elif mode == 0o400:
        with test.assertRaises(PermissionError):
            with open(path, 'ab'):
                pass


def make_symlink(path, target, target_is_directory=False):
    try:
        Path(path).symlink_to(target, target_is_directory=target_is_directory)
    except OSError as error:
        if IS_WINDOWS and error.winerror == 1314:
            raise unittest.SkipTest('Windows user lacks symbolic-link privilege; real junction attacks are tested separately.') from error
        raise
