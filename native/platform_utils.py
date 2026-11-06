"""Private storage and interprocess locks on POSIX and Windows.

Windows permissions are owner/SYSTEM protected ACLs, not the DOS read-only bit.
Reparse points (including junctions) are rejected before storage operations.
"""
import errno
import os
from pathlib import Path
import stat
import sys
import time

IS_WINDOWS = sys.platform == 'win32'


def support_directory(home=None):
    home = Path(home) if home is not None else Path.home()
    if IS_WINDOWS:
        # A packaged Codex process can redirect LocalAppData into its MSIX
        # LocalCache. Chrome then sees a different directory at the same name.
        # A user-profile root is shared by packaged and ordinary processes and
        # keeps scoped snapshot paths below the legacy Win32 length limit.
        return home / '.overleaf-personal-tools'
    return home / 'Library/Application Support/OverleafPersonalTools'


def is_link(path):
    try:
        info = Path(path).lstat()
        return stat.S_ISLNK(info.st_mode) or bool(getattr(info, 'st_file_attributes', 0) & 0x400)
    except FileNotFoundError:
        return False


def check_components(path):
    path = Path(path).absolute()
    for part in (path, *path.parents):
        if is_link(part):
            raise ValueError('Private storage cannot contain symlinks or reparse points.')


if IS_WINDOWS:
    import ctypes
    from ctypes import wintypes as w
    import msvcrt

    adv = ctypes.WinDLL('advapi32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    adv.GetNamedSecurityInfoW.argtypes = [w.LPWSTR, w.DWORD, w.DWORD, ctypes.POINTER(w.LPVOID), w.LPVOID, ctypes.POINTER(w.LPVOID), w.LPVOID, ctypes.POINTER(w.LPVOID)]
    adv.GetNamedSecurityInfoW.restype = w.DWORD
    adv.GetSecurityInfo.argtypes = [w.HANDLE, w.DWORD, w.DWORD, ctypes.POINTER(w.LPVOID), w.LPVOID, ctypes.POINTER(w.LPVOID), w.LPVOID, ctypes.POINTER(w.LPVOID)]
    adv.GetSecurityInfo.restype = w.DWORD
    adv.ConvertSidToStringSidW.argtypes = [w.LPVOID, ctypes.POINTER(w.LPWSTR)]
    adv.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [w.LPCWSTR, w.DWORD, ctypes.POINTER(w.LPVOID), w.LPVOID]
    adv.GetSecurityDescriptorDacl.argtypes = [w.LPVOID, ctypes.POINTER(w.BOOL), ctypes.POINTER(w.LPVOID), ctypes.POINTER(w.BOOL)]
    adv.SetSecurityInfo.argtypes = [w.HANDLE, w.DWORD, w.DWORD, w.LPVOID, w.LPVOID, w.LPVOID, w.LPVOID]
    adv.SetSecurityInfo.restype = w.DWORD
    adv.SetNamedSecurityInfoW.argtypes = [w.LPWSTR, w.DWORD, w.DWORD, w.LPVOID, w.LPVOID, w.LPVOID, w.LPVOID]
    adv.SetNamedSecurityInfoW.restype = w.DWORD
    adv.OpenProcessToken.argtypes = [w.HANDLE, w.DWORD, ctypes.POINTER(w.HANDLE)]
    adv.GetTokenInformation.argtypes = [w.HANDLE, ctypes.c_int, w.LPVOID, w.DWORD, ctypes.POINTER(w.DWORD)]
    adv.GetAce.argtypes = [w.LPVOID, w.DWORD, ctypes.POINTER(w.LPVOID)]
    kernel.GetCurrentProcess.restype = w.HANDLE
    kernel.LocalFree.argtypes = [w.LPVOID]
    kernel.CloseHandle.argtypes = [w.HANDLE]
    kernel.ReOpenFile.argtypes = [w.HANDLE, w.DWORD, w.DWORD, w.DWORD]
    kernel.ReOpenFile.restype = w.HANDLE

    def _sid_text(sid):
        result = w.LPWSTR()
        if not adv.ConvertSidToStringSidW(sid, ctypes.byref(result)):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            return result.value
        finally:
            kernel.LocalFree(result)

    def _current_sid():
        token = w.HANDLE()
        if not adv.OpenProcessToken(kernel.GetCurrentProcess(), 8, ctypes.byref(token)):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            size = w.DWORD()
            adv.GetTokenInformation(token, 1, None, 0, ctypes.byref(size))
            data = ctypes.create_string_buffer(size.value)
            if not adv.GetTokenInformation(token, 1, data, len(data), ctypes.byref(size)):
                raise ctypes.WinError(ctypes.get_last_error())
            return _sid_text(ctypes.cast(data, ctypes.POINTER(w.LPVOID))[0])
        finally:
            kernel.CloseHandle(token)

    CURRENT_SID = _current_sid()

    def _security(target):
        owner, dacl, descriptor = w.LPVOID(), w.LPVOID(), w.LPVOID()
        if isinstance(target, int):
            result = adv.GetSecurityInfo(w.HANDLE(msvcrt.get_osfhandle(target)), 1, 5, ctypes.byref(owner), None, ctypes.byref(dacl), None, ctypes.byref(descriptor))
        else:
            result = adv.GetNamedSecurityInfoW(str(target), 1, 5, ctypes.byref(owner), None, ctypes.byref(dacl), None, ctypes.byref(descriptor))
        if result:
            raise ctypes.WinError(result)
        return owner, dacl, descriptor


def owned_by_user(target, info=None):
    if not IS_WINDOWS:
        info = info or (os.fstat(target) if isinstance(target, int) else os.stat(target))
        return info.st_uid == os.getuid()
    owner, _, descriptor = _security(target)
    try:
        return _sid_text(owner) == CURRENT_SID
    finally:
        kernel.LocalFree(descriptor)


def is_private(target, info=None):
    if not IS_WINDOWS:
        info = info or (os.fstat(target) if isinstance(target, int) else os.stat(target))
        return info.st_uid == os.getuid() and not info.st_mode & 0o077
    owner, dacl, descriptor = _security(target)
    try:
        if _sid_text(owner) != CURRENT_SID or not dacl:
            return False
        # ACL header: revision, reserved, size, AceCount, reserved.
        count = ctypes.cast(dacl, ctypes.POINTER(ctypes.c_ushort))[2]
        for index in range(count):
            ace = w.LPVOID()
            if not adv.GetAce(dacl, index, ctypes.byref(ace)):
                raise ctypes.WinError(ctypes.get_last_error())
            kind = ctypes.c_ubyte.from_address(ace.value).value
            if kind == 0:  # ACCESS_ALLOWED_ACE: header(4), mask(4), SID
                if _sid_text(w.LPVOID(ace.value + 8)) not in (CURRENT_SID, 'S-1-5-18'):
                    return False
            elif kind != 1:  # Unknown/object/callback grants fail closed.
                return False
        return True
    finally:
        kernel.LocalFree(descriptor)


def private_permissions(target, mode=0o600):
    if not IS_WINDOWS:
        if isinstance(target, int):
            os.fchmod(target, mode)
        else:
            os.chmod(str(target), mode)
        return
    if not owned_by_user(target):
        raise PermissionError('Private storage must belong to the current Windows user.')
    descriptor = w.LPVOID()
    access = 'FA' if mode & 0o200 else 'FRSDWD'
    sddl = 'D:P(A;OICI;%s;;;%s)(A;OICI;FA;;;SY)' % (access, CURRENT_SID)
    if not adv.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(descriptor), None):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        present, defaulted, dacl = w.BOOL(), w.BOOL(), w.LPVOID()
        if not adv.GetSecurityDescriptorDacl(descriptor, ctypes.byref(present), ctypes.byref(dacl), ctypes.byref(defaulted)):
            raise ctypes.WinError(ctypes.get_last_error())
        if isinstance(target, int):
            # CRT descriptors omit WRITE_DAC. Reopen the same file object, not
            # its pathname, so an atomic replacement cannot redirect this ACL.
            handle = kernel.ReOpenFile(w.HANDLE(msvcrt.get_osfhandle(target)), 0x00060000, 7, 0)
            if handle == w.HANDLE(-1).value:
                raise ctypes.WinError(ctypes.get_last_error())
            try:
                result = adv.SetSecurityInfo(handle, 1, 0x80000004, None, None, dacl, None)
            finally:
                kernel.CloseHandle(handle)
        else:
            result = adv.SetNamedSecurityInfoW(str(target), 1, 0x80000004, None, None, dacl, None)
        if result:
            raise ctypes.WinError(result)
    finally:
        kernel.LocalFree(descriptor)


def private_directory(path):
    path = Path(path)
    check_components(path)
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not path.is_dir() or not owned_by_user(path):
        raise ValueError('Invalid private directory ownership.')
    private_permissions(path, 0o700)


def touch_private_directory(path):
    check_components(path)
    if not Path(path).is_dir() or not is_private(path):
        raise ValueError('Refusing to touch a non-private directory.')
    # Python 3.11 on Windows has no utime(..., follow_symlinks=False).
    # This namespace is protected by a current-user/SYSTEM ACL and the store
    # lock; all components above have been checked for reparse points.
    if IS_WINDOWS:
        os.utime(str(path), None)
    else:
        os.utime(str(path), None, follow_symlinks=False)


if not IS_WINDOWS:
    import fcntl
else:
    class fcntl:
        LOCK_EX, LOCK_NB, LOCK_UN = 2, 4, 8

        @staticmethod
        def flock(fd, operation):
            position = os.lseek(fd, 0, os.SEEK_CUR)
            try:
                os.lseek(fd, 0, os.SEEK_SET)
                while True:
                    try:
                        msvcrt.locking(fd, msvcrt.LK_UNLCK if operation & 8 else msvcrt.LK_NBLCK, 1)
                        return
                    except OSError as error:
                        if operation & 8:
                            raise
                        if error.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                            raise
                        if operation & 4:
                            raise BlockingIOError(errno.EAGAIN, 'Private storage is locked.') from error
                        time.sleep(0.025)
            finally:
                os.lseek(fd, position, os.SEEK_SET)
