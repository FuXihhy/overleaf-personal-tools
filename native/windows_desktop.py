"""Windows Desktop transport and executable discovery, without shell wrappers.

The installed Desktop uses a byte-mode named pipe with length-prefixed JSON.
This module authenticates the connected server *before* any protocol payload:
its token must be this user's session, its package must be the installed OpenAI
package, and its image must be the package's actual desktop executable. The
pipe is opened with identification-only SQOS, so an impostor cannot impersonate
the caller while it is being checked. No auth files or conversation logs are read.
"""
import ctypes
from ctypes import wintypes as w
import os
from pathlib import Path
import platform
import threading
import time


PIPE_PATH = r'\\.\pipe\codex-ipc'
PACKAGE_FAMILY = 'OpenAI.Codex_2p2nqsd0c76g0'
INVALID_HANDLE = ctypes.c_void_p(-1).value
_api = None


class WindowsDesktopError(OSError):
    pass


class _Overlapped(ctypes.Structure):
    _fields_ = [('Internal', ctypes.c_size_t), ('InternalHigh', ctypes.c_size_t),
                ('Offset', w.DWORD), ('OffsetHigh', w.DWORD), ('hEvent', w.HANDLE)]


class _BasicLimits(ctypes.Structure):
    _fields_ = [('PerProcessUserTimeLimit', ctypes.c_longlong),
                ('PerJobUserTimeLimit', ctypes.c_longlong), ('LimitFlags', w.DWORD),
                ('MinimumWorkingSetSize', ctypes.c_size_t), ('MaximumWorkingSetSize', ctypes.c_size_t),
                ('ActiveProcessLimit', w.DWORD), ('Affinity', ctypes.c_size_t),
                ('PriorityClass', w.DWORD), ('SchedulingClass', w.DWORD)]


class _IOCounters(ctypes.Structure):
    _fields_ = [(name, ctypes.c_ulonglong) for name in
                ('ReadOperationCount', 'WriteOperationCount', 'OtherOperationCount',
                 'ReadTransferCount', 'WriteTransferCount', 'OtherTransferCount')]


class _ExtendedLimits(ctypes.Structure):
    _fields_ = [('BasicLimitInformation', _BasicLimits), ('IoInfo', _IOCounters),
                ('ProcessMemoryLimit', ctypes.c_size_t), ('JobMemoryLimit', ctypes.c_size_t),
                ('PeakProcessMemoryUsed', ctypes.c_size_t), ('PeakJobMemoryUsed', ctypes.c_size_t)]


class _ThreadEntry(ctypes.Structure):
    _fields_ = [('dwSize', w.DWORD), ('cntUsage', w.DWORD), ('th32ThreadID', w.DWORD),
                ('th32OwnerProcessID', w.DWORD), ('tpBasePri', w.LONG),
                ('tpDeltaPri', w.LONG), ('dwFlags', w.DWORD)]


def _win():
    global _api
    if os.name != 'nt':
        raise WindowsDesktopError('Windows desktop transport is unavailable on this platform.')
    if _api is not None:
        return _api
    k = ctypes.WinDLL('kernel32', use_last_error=True)
    a = ctypes.WinDLL('advapi32', use_last_error=True)
    specs = {
        'CreateFileW': ([w.LPCWSTR, w.DWORD, w.DWORD, w.LPVOID, w.DWORD, w.DWORD, w.HANDLE], w.HANDLE),
        'WaitNamedPipeW': ([w.LPCWSTR, w.DWORD], w.BOOL),
        'CloseHandle': ([w.HANDLE], w.BOOL),
        'GetNamedPipeServerProcessId': ([w.HANDLE, ctypes.POINTER(w.ULONG)], w.BOOL),
        'OpenProcess': ([w.DWORD, w.BOOL, w.DWORD], w.HANDLE),
        'GetCurrentProcess': ([], w.HANDLE),
        'QueryFullProcessImageNameW': ([w.HANDLE, w.DWORD, w.LPWSTR, ctypes.POINTER(w.DWORD)], w.BOOL),
        'GetProcessTimes': ([w.HANDLE] + [ctypes.POINTER(w.FILETIME)] * 4, w.BOOL),
        'GetPackageFamilyName': ([w.HANDLE, ctypes.POINTER(w.UINT), w.LPWSTR], w.LONG),
        'GetPackageFullName': ([w.HANDLE, ctypes.POINTER(w.UINT), w.LPWSTR], w.LONG),
        'GetPackagePathByFullName': ([w.LPCWSTR, ctypes.POINTER(w.UINT), w.LPWSTR], w.LONG),
        'GetPackagesByPackageFamily': ([w.LPCWSTR, ctypes.POINTER(w.UINT), ctypes.POINTER(w.LPWSTR), ctypes.POINTER(w.UINT), w.LPWSTR], w.LONG),
        'CreateEventW': ([w.LPVOID, w.BOOL, w.BOOL, w.LPCWSTR], w.HANDLE),
        'ReadFile': ([w.HANDLE, w.LPVOID, w.DWORD, ctypes.POINTER(w.DWORD), ctypes.POINTER(_Overlapped)], w.BOOL),
        'WriteFile': ([w.HANDLE, w.LPCVOID, w.DWORD, ctypes.POINTER(w.DWORD), ctypes.POINTER(_Overlapped)], w.BOOL),
        'GetOverlappedResult': ([w.HANDLE, ctypes.POINTER(_Overlapped), ctypes.POINTER(w.DWORD), w.BOOL], w.BOOL),
        'CancelIoEx': ([w.HANDLE, ctypes.POINTER(_Overlapped)], w.BOOL),
        'WaitForSingleObject': ([w.HANDLE, w.DWORD], w.DWORD),
        'CreateJobObjectW': ([w.LPVOID, w.LPCWSTR], w.HANDLE),
        'SetInformationJobObject': ([w.HANDLE, ctypes.c_int, w.LPVOID, w.DWORD], w.BOOL),
        'AssignProcessToJobObject': ([w.HANDLE, w.HANDLE], w.BOOL),
        'TerminateJobObject': ([w.HANDLE, w.UINT], w.BOOL),
        'CreateToolhelp32Snapshot': ([w.DWORD, w.DWORD], w.HANDLE),
        'Thread32First': ([w.HANDLE, ctypes.POINTER(_ThreadEntry)], w.BOOL),
        'Thread32Next': ([w.HANDLE, ctypes.POINTER(_ThreadEntry)], w.BOOL),
        'OpenThread': ([w.DWORD, w.BOOL, w.DWORD], w.HANDLE),
        'ResumeThread': ([w.HANDLE], w.DWORD),
    }
    for name, (args, result) in specs.items():
        fn = getattr(k, name); fn.argtypes = args; fn.restype = result
    for name, args, result in [
        ('OpenProcessToken', [w.HANDLE, w.DWORD, ctypes.POINTER(w.HANDLE)], w.BOOL),
        ('GetTokenInformation', [w.HANDLE, ctypes.c_int, w.LPVOID, w.DWORD, ctypes.POINTER(w.DWORD)], w.BOOL),
        ('GetLengthSid', [w.LPVOID], w.DWORD),
    ]:
        fn = getattr(a, name); fn.argtypes = args; fn.restype = result
    _api = k, a
    return _api


def _error(message):
    # Win32 error numbers are useful diagnostics, never process arguments/data.
    return WindowsDesktopError('%s (Windows error %s).' % (message, ctypes.get_last_error()))


def _package_string(fn, first):
    count = w.UINT()
    code = fn(first, ctypes.byref(count), None)
    if code != 122 or not 1 < count.value < 32768:
        raise WindowsDesktopError('Could not verify the installed Desktop package.')
    value = ctypes.create_unicode_buffer(count.value)
    if fn(first, ctypes.byref(count), value) != 0:
        raise WindowsDesktopError('Could not read the installed Desktop package identity.')
    return value.value


def package_roots():
    """Only packages registered for this user, with the known publisher family."""
    k, _ = _win()
    count, length = w.UINT(), w.UINT()
    code = k.GetPackagesByPackageFamily(PACKAGE_FAMILY, ctypes.byref(count), None, ctypes.byref(length), None)
    if code == 0 and count.value == 0:
        return []
    if code != 122 or not 0 < count.value <= 32 or not 0 < length.value <= 65536:
        raise WindowsDesktopError('Could not enumerate installed Codex packages.')
    names = (w.LPWSTR * count.value)()
    buf = ctypes.create_unicode_buffer(length.value)
    if k.GetPackagesByPackageFamily(PACKAGE_FAMILY, ctypes.byref(count), names, ctypes.byref(length), buf) != 0:
        raise WindowsDesktopError('Installed Codex packages changed during discovery.')
    return [Path(_package_string(k.GetPackagePathByFullName, names[i])) for i in range(count.value)]


def codex_executable():
    """Prefer Desktop's matching CLI; never execute a PATH-selected .cmd file."""
    for root in package_roots():
        candidate = root / 'app' / 'resources' / 'codex.exe'
        if candidate.is_file():
            return str(candidate)
    # Standard npm installation, using the native optional package directly.
    arch = 'arm64' if platform.machine().lower() in ('arm64', 'aarch64') else 'x64'
    triple = 'aarch64-pc-windows-msvc' if arch == 'arm64' else 'x86_64-pc-windows-msvc'
    npm = Path(os.environ.get('APPDATA', str(Path.home() / 'AppData' / 'Roaming'))) / 'npm' / 'node_modules' / '@openai' / 'codex'
    for parent in (npm / 'node_modules' / '@openai' / ('codex-win32-' + arch), npm):
        candidate = parent / 'vendor' / triple / 'codex' / 'codex.exe'
        if candidate.is_file() and not candidate.is_symlink():
            return str(candidate.resolve())
    raise WindowsDesktopError('Codex was not found. Install the Windows Codex desktop app or Codex CLI.')


def _token_identity(process):
    k, a = _win()
    token = w.HANDLE()
    if not a.OpenProcessToken(process, 8, ctypes.byref(token)):
        raise _error('Could not inspect Desktop user identity')
    try:
        size = w.DWORD()
        a.GetTokenInformation(token, 1, None, 0, ctypes.byref(size))  # TokenUser
        if not 0 < size.value <= 65536:
            raise WindowsDesktopError('Invalid Desktop token identity.')
        buf = ctypes.create_string_buffer(size.value)
        if not a.GetTokenInformation(token, 1, buf, size, ctypes.byref(size)):
            raise _error('Could not inspect Desktop user identity')
        sid = ctypes.cast(buf, ctypes.POINTER(w.LPVOID)).contents.value
        sid_size = a.GetLengthSid(sid)
        if not 8 <= sid_size <= 68:
            raise WindowsDesktopError('Invalid Desktop user SID.')
        user = ctypes.string_at(sid, sid_size)
        session = w.DWORD()
        if not a.GetTokenInformation(token, 12, ctypes.byref(session), ctypes.sizeof(session), ctypes.byref(size)):
            raise _error('Could not inspect Desktop login session')
        return user, session.value
    finally:
        k.CloseHandle(token)


def verify_pipe_server(handle):
    """Return verified process metadata; keep the handle open across all checks."""
    k, _ = _win()
    pid = w.ULONG()
    if not k.GetNamedPipeServerProcessId(handle, ctypes.byref(pid)) or not pid.value:
        raise _error('Could not identify Desktop pipe server')
    process = k.OpenProcess(0x1000, False, pid.value)
    if not process:
        raise _error('Could not inspect Desktop pipe server')
    try:
        if _token_identity(process) != _token_identity(k.GetCurrentProcess()):
            raise WindowsDesktopError('Desktop coordination peer belongs to another user or login session.')
        family = _package_string(k.GetPackageFamilyName, process)
        if family != PACKAGE_FAMILY:
            raise WindowsDesktopError('Desktop coordination peer is not the installed OpenAI desktop application.')
        package = _package_string(k.GetPackageFullName, process)
        root = Path(_package_string(k.GetPackagePathByFullName, package)).resolve()
        size = w.DWORD(32768); image = ctypes.create_unicode_buffer(size.value)
        if not k.QueryFullProcessImageNameW(process, 0, image, ctypes.byref(size)):
            raise _error('Could not inspect Desktop executable')
        executable = Path(image.value).resolve()
        if executable not in (root / 'app' / 'ChatGPT.exe', root / 'app' / 'Codex.exe'):
            raise WindowsDesktopError('Desktop pipe server executable is not the installed desktop application.')
        created, exited, kernel, user = w.FILETIME(), w.FILETIME(), w.FILETIME(), w.FILETIME()
        if not k.GetProcessTimes(process, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kernel), ctypes.byref(user)):
            raise _error('Could not verify Desktop process startup')
        born = ((created.dwHighDateTime << 32) | created.dwLowDateTime) / 10000000 - 11644473600
        # Detect a server replacement or PID reuse before allowing any bytes out.
        current = w.ULONG()
        if not k.GetNamedPipeServerProcessId(handle, ctypes.byref(current)) or current.value != pid.value:
            raise WindowsDesktopError('Desktop pipe server changed during verification.')
        return {'pid': pid.value, 'created_at': born, 'package': package, 'image': str(executable)}
    finally:
        k.CloseHandle(process)


class NamedPipeSocket:
    """Socket-like byte transport with cancellable reads and no impersonation."""
    def __init__(self, path=PIPE_PATH, timeout=5):
        if str(path).lower() != PIPE_PATH.lower():
            raise WindowsDesktopError('Only the installed Desktop named pipe is allowed.')
        self._lock = threading.Lock()
        self._handle = None
        k, _ = _win()
        deadline = time.monotonic() + timeout
        while True:
            # FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION
            handle = k.CreateFileW(PIPE_PATH, 0xC0000000, 0, None, 3, 0x40110000, None)
            if handle != INVALID_HANDLE:
                break
            if ctypes.get_last_error() != 231 or time.monotonic() >= deadline:
                raise _error('Desktop coordination named pipe is not available')
            k.WaitNamedPipeW(PIPE_PATH, max(1, int((deadline - time.monotonic()) * 1000)))
        self._handle = handle
        try:
            self.peer = verify_pipe_server(handle)
        except Exception:
            self.close()
            raise

    def _transfer(self, data, reading=False):
        k, _ = _win()
        with self._lock:
            handle = self._handle
            if handle is None:
                raise WindowsDesktopError('Desktop coordination connection has closed.')
            event = k.CreateEventW(None, True, False, None)
            if not event:
                raise _error('Could not create Desktop I/O event')
            ov = _Overlapped(); ov.hEvent = event
            count = w.DWORD()
            buf = ctypes.create_string_buffer(data if not reading else data)
            size = data if reading else len(data)
            ok = (k.ReadFile if reading else k.WriteFile)(handle, buf, size, ctypes.byref(count), ctypes.byref(ov))
            error = 0 if ok else ctypes.get_last_error()
        try:
            if not ok:
                if error in (109, 232, 233) and reading:
                    return b''
                if error != 997:
                    raise WindowsDesktopError('Desktop pipe I/O failed (Windows error %s).' % error)
                if not k.GetOverlappedResult(handle, ctypes.byref(ov), ctypes.byref(count), True):
                    error = ctypes.get_last_error()
                    if error in (109, 232, 233, 995) and reading:
                        return b''
                    raise WindowsDesktopError('Desktop pipe I/O failed (Windows error %s).' % error)
            return buf.raw[:count.value] if reading else count.value
        finally:
            k.CloseHandle(event)

    def recv(self, size):
        return self._transfer(size, reading=True)

    def sendall(self, data):
        offset = 0
        while offset < len(data):
            count = self._transfer(data[offset:offset + 1024 * 1024])
            if not count:
                raise WindowsDesktopError('Desktop pipe closed while writing.')
            offset += count

    def shutdown(self, how=None):
        self.close()

    def close(self):
        k, _ = _win()
        with self._lock:
            if self._handle is not None:
                handle, self._handle = self._handle, None
                k.CancelIoEx(handle, None)
                k.CloseHandle(handle)


class ProcessJob:
    """Own only a newly spawned helper and its descendants, never Desktop."""
    def __init__(self, process, suspended=False):
        k, _ = _win()
        self.handle = k.CreateJobObjectW(None, None)
        if not self.handle:
            raise _error('Could not create Codex child process job')
        limits = _ExtendedLimits()
        limits.BasicLimitInformation.LimitFlags = 0x2000  # KILL_ON_JOB_CLOSE
        try:
            if not k.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
                raise _error('Could not configure Codex child process job')
            if not k.AssignProcessToJobObject(self.handle, int(process._handle)):
                raise _error('Could not contain Codex child processes')
            if suspended:
                _resume_initial_thread(process.pid)
        except Exception:
            self.close()
            raise

    def close(self):
        if self.handle:
            k, _ = _win()
            k.TerminateJobObject(self.handle, 1)
            k.CloseHandle(self.handle)
            self.handle = None


def _resume_initial_thread(pid):
    """Popen closes its initial thread handle; reopen only the suspended child.

    Starting suspended removes the race in which a helper could start its own
    child before Job assignment. No other process or existing thread is resumed.
    """
    k, _ = _win()
    snapshot = k.CreateToolhelp32Snapshot(4, 0)  # TH32CS_SNAPTHREAD
    if snapshot == INVALID_HANDLE:
        raise _error('Could not inspect the new suspended Codex process')
    identifiers = []
    try:
        entry = _ThreadEntry(); entry.dwSize = ctypes.sizeof(entry)
        ok = k.Thread32First(snapshot, ctypes.byref(entry))
        while ok:
            if entry.th32OwnerProcessID == pid:
                identifiers.append(entry.th32ThreadID)
            ok = k.Thread32Next(snapshot, ctypes.byref(entry))
    finally:
        k.CloseHandle(snapshot)
    if len(identifiers) != 1:
        raise WindowsDesktopError('The suspended Codex process has an unexpected thread state.')
    thread = k.OpenThread(2, False, identifiers[0])  # THREAD_SUSPEND_RESUME
    if not thread:
        raise _error('Could not open the new Codex process thread')
    try:
        if k.ResumeThread(thread) != 1:
            raise WindowsDesktopError('Could not resume the contained Codex process.')
    finally:
        k.CloseHandle(thread)
