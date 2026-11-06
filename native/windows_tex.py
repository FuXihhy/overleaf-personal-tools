"""Windows TeX containment: capability-scoped AppContainer and kill-on-close job.

Uses Windows APIs and pywin32. No unsandboxed fallback is provided. Installation
grants one non-network capability read/execute access to a validated TeX Live
tree; every invocation has a fresh AppContainer identity and writable job only.
"""
import ctypes
from ctypes import wintypes as W
import os
from pathlib import Path
import subprocess
import uuid

CAPABILITY = 'overleafPersonalToolsTeXRead'
READ_EXECUTE = 0x1200A9


def _api():
    if os.name != 'nt':
        raise OSError('AppContainer requires Windows.')
    import win32api
    import win32con
    import win32event
    import win32job
    import win32security
    return win32api, win32con, win32event, win32job, win32security


def capability_sid():
    """Derive the custom *file-read* capability; never a network capability."""
    *_, security = _api()
    kernel = ctypes.WinDLL('kernelbase', use_last_error=True)
    advapi = ctypes.WinDLL('advapi32', use_last_error=True)
    derive = kernel.DeriveCapabilitySidsFromName
    derive.argtypes = [W.LPCWSTR, ctypes.POINTER(ctypes.POINTER(W.LPVOID)),
                      ctypes.POINTER(W.DWORD), ctypes.POINTER(ctypes.POINTER(W.LPVOID)),
                      ctypes.POINTER(W.DWORD)]
    derive.restype = W.BOOL
    kernel.LocalFree.argtypes = [W.LPVOID]
    advapi.GetLengthSid.argtypes = [W.LPVOID]
    advapi.GetLengthSid.restype = W.DWORD
    groups, caps = ctypes.POINTER(W.LPVOID)(), ctypes.POINTER(W.LPVOID)()
    ng, nc = W.DWORD(), W.DWORD()
    if not derive(CAPABILITY, ctypes.byref(groups), ctypes.byref(ng), ctypes.byref(caps), ctypes.byref(nc)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        if nc.value != 1:
            raise OSError('Unexpected capability SID count.')
        return security.SID(ctypes.string_at(caps[0], advapi.GetLengthSid(caps[0])))
    finally:
        for ptrs, count in ((groups, ng.value), (caps, nc.value)):
            for i in range(count):
                kernel.LocalFree(ptrs[i])
            kernel.LocalFree(ptrs)


def _not_reparse(path):
    path = Path(path)
    for component in (path, *path.parents):
        if component.exists() and getattr(component.lstat(), 'st_file_attributes', 0) & 0x400:
            raise ValueError('Refusing a reparse point in the TeX sandbox path.')


def configure_tex_root(root):
    """Explicit install action, never called by a web render/status request."""
    *_, security = _api()
    root = Path(root).absolute()
    _not_reparse(root)
    if not (root / 'texmf-dist' / 'web2c').is_dir() or not (root / 'bin' / 'windows').is_dir():
        raise ValueError('Only a complete Windows TeX Live installation can be authorized.')
    # kpathsea resolves long names through the enclosing texlive directory.
    # Grant that directory itself, never its other installed versions/children.
    if root.parent.name.lower() != 'texlive':
        raise ValueError('TeX Live must be installed below a dedicated texlive directory.')
    _grant_read(Path(root.anchor), inherit=False)
    _grant_read(root.parent, inherit=False)
    _grant_read(root, inherit=True)


def _grant_read(path, inherit):
    *_, security = _api()
    sid = capability_sid()
    flags = 3 if inherit else 0
    sd = security.GetNamedSecurityInfo(str(path), security.SE_FILE_OBJECT, security.DACL_SECURITY_INFORMATION)
    acl = sd.GetSecurityDescriptorDacl()
    if acl is None:
        raise ValueError('Refusing a TeX tree with an unrestricted DACL.')
    original = [acl.GetAce(i) for i in range(acl.GetAceCount())]
    for i in range(acl.GetAceCount()):
        ace = acl.GetAce(i)
        if ace[0][0] == security.ACCESS_ALLOWED_ACE_TYPE and ace[2] == sid:
            if ace[1] != READ_EXECUTE or ace[0][1] & 3 != flags:
                raise ValueError('An incompatible existing TeX capability grant was not changed.')
            return
    acl.AddAccessAllowedAceEx(security.ACL_REVISION, flags, READ_EXECUTE, sid)
    # Windows propagates this read-only ACE to descendants. Existing user and
    # system ACEs are preserved. The SID grants neither network nor user files.
    if inherit:
        security.SetNamedSecurityInfo(str(path), security.SE_FILE_OBJECT,
                                     security.DACL_SECURITY_INFORMATION, None, None, acl, None)
    else:
        # SetFileSecurity avoids walking an entire drive for a non-inheriting
        # directory-only grant (GetLongPathName needs directory enumeration).
        sd.SetSecurityDescriptorDacl(True, acl, False)
        security.SetFileSecurity(str(path), security.DACL_SECURITY_INFORMATION, sd)
    verified = security.GetNamedSecurityInfo(str(path), security.SE_FILE_OBJECT,
                                             security.DACL_SECURITY_INFORMATION).GetSecurityDescriptorDacl()
    actual = [verified.GetAce(i) for i in range(verified.GetAceCount())] if verified else []
    if any(ace not in actual for ace in original):
        raise OSError('TeX capability setup did not preserve an original ACL entry.')


def configure_tex_roots():
    """Authorize the locally discovered TeX installations during explicit setup."""
    from host import compiler_paths, tex_root
    roots = sorted({tex_root(executable) for executable in compiler_paths().values()})
    for root in roots:
        try:
            configure_tex_root(root)
        except Exception as error:
            raise OSError('Windows TeX AppContainer setup could not grant directory access to %s: %s. '
                          'An administrator must run the TeX installer once; compilation remains disabled.' % (root, error)) from error
    return roots


def configured(root):
    try:
        *_, security = _api()
        _not_reparse(root)
        sid = capability_sid()
        for path, flags in ((Path(root), 3), (Path(root).parent, 0), (Path(Path(root).anchor), 0)):
            sd = security.GetNamedSecurityInfo(str(path), security.SE_FILE_OBJECT, security.DACL_SECURITY_INFORMATION)
            acl = sd.GetSecurityDescriptorDacl()
            if acl is None or not any(acl.GetAce(i)[0][0] == 0 and acl.GetAce(i)[2] == sid
                                      and acl.GetAce(i)[1] == READ_EXECUTE
                                      and acl.GetAce(i)[0][1] & 3 == flags for i in range(acl.GetAceCount())):
                return False
        return True
    except Exception:
        return False


class STARTUPINFO(ctypes.Structure):
    _fields_ = [('cb', W.DWORD), ('lpReserved', W.LPWSTR), ('lpDesktop', W.LPWSTR),
                ('lpTitle', W.LPWSTR), ('dwX', W.DWORD), ('dwY', W.DWORD),
                ('dwXSize', W.DWORD), ('dwYSize', W.DWORD), ('dwXCountChars', W.DWORD),
                ('dwYCountChars', W.DWORD), ('dwFillAttribute', W.DWORD),
                ('dwFlags', W.DWORD), ('wShowWindow', W.WORD), ('cbReserved2', W.WORD),
                ('lpReserved2', W.LPVOID), ('hStdInput', W.HANDLE),
                ('hStdOutput', W.HANDLE), ('hStdError', W.HANDLE)]


class STARTUPINFOEX(ctypes.Structure):
    _fields_ = [('StartupInfo', STARTUPINFO), ('lpAttributeList', W.LPVOID)]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [('hProcess', W.HANDLE), ('hThread', W.HANDLE), ('dwProcessId', W.DWORD), ('dwThreadId', W.DWORD)]


class SID_AND_ATTRIBUTES(ctypes.Structure):
    _fields_ = [('Sid', W.LPVOID), ('Attributes', W.DWORD)]


class SECURITY_CAPABILITIES(ctypes.Structure):
    _fields_ = [('AppContainerSid', W.LPVOID), ('Capabilities', ctypes.POINTER(SID_AND_ATTRIBUTES)),
                ('CapabilityCount', W.DWORD), ('Reserved', W.DWORD)]


class SandboxedProcess:
    """Popen-like minimum used by host.py. Handles are never inheritable by default."""
    def __init__(self, arguments, cwd, env, log):
        self._api = _api()
        api, con, event, jobs, security = self._api
        self.returncode = None
        self._process = None
        self._job = None
        self._profile = 'OverleafPersonalTools.TeX.' + uuid.uuid4().hex
        self._profile_created = False
        self.pid = None
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        userenv = ctypes.WinDLL('userenv', use_last_error=True)
        advapi = ctypes.WinDLL('advapi32', use_last_error=True)
        self._userenv = userenv
        userenv.DeleteAppContainerProfile.argtypes = [W.LPCWSTR]
        userenv.DeleteAppContainerProfile.restype = ctypes.c_long
        userenv.CreateAppContainerProfile.argtypes = [W.LPCWSTR, W.LPCWSTR, W.LPCWSTR,
            ctypes.POINTER(SID_AND_ATTRIBUTES), W.DWORD, ctypes.POINTER(W.LPVOID)]
        userenv.CreateAppContainerProfile.restype = ctypes.c_long
        advapi.FreeSid.argtypes = [W.LPVOID]
        advapi.GetTokenInformation.argtypes = [W.HANDLE, ctypes.c_int, W.LPVOID, W.DWORD, ctypes.POINTER(W.DWORD)]
        advapi.GetTokenInformation.restype = W.BOOL
        kernel.InitializeProcThreadAttributeList.argtypes = [W.LPVOID, W.DWORD, W.DWORD, ctypes.POINTER(ctypes.c_size_t)]
        kernel.UpdateProcThreadAttribute.argtypes = [W.LPVOID, W.DWORD, ctypes.c_size_t, W.LPVOID, ctypes.c_size_t, W.LPVOID, W.LPVOID]
        kernel.DeleteProcThreadAttributeList.argtypes = [W.LPVOID]
        kernel.CreateProcessW.argtypes = [W.LPCWSTR, W.LPWSTR, W.LPVOID, W.LPVOID, W.BOOL,
            W.DWORD, W.LPVOID, W.LPCWSTR, ctypes.POINTER(STARTUPINFOEX), ctypes.POINTER(PROCESS_INFORMATION)]
        kernel.CreateProcessW.restype = W.BOOL
        kernel.CloseHandle.argtypes = [W.HANDLE]
        kernel.ResumeThread.argtypes = [W.HANDLE]
        kernel.ResumeThread.restype = W.DWORD
        cap_buffer = ctypes.create_string_buffer(bytes(capability_sid()))
        capability = SID_AND_ATTRIBUTES(ctypes.cast(cap_buffer, W.LPVOID), 4)
        profile_sid = W.LPVOID()
        attributes = None
        pi = PROCESS_INFORMATION()
        import msvcrt
        with open(os.devnull, 'rb') as null:
            input_handle, output_handle = msvcrt.get_osfhandle(null.fileno()), msvcrt.get_osfhandle(log.fileno())
            try:
                hr = userenv.CreateAppContainerProfile(self._profile, self._profile, 'Isolated single TeX preview',
                                                       ctypes.byref(capability), 1, ctypes.byref(profile_sid))
                if hr < 0:
                    raise OSError('CreateAppContainerProfile failed: 0x%08x' % (hr & 0xffffffff))
                self._profile_created = True
                package_sid = security.SID(ctypes.string_at(profile_sid, 8 + 4 * ctypes.string_at(profile_sid, 2)[1]))
                _not_reparse(cwd)
                token = security.OpenProcessToken(api.GetCurrentProcess(), con.TOKEN_QUERY)
                try:
                    owner = security.GetTokenInformation(token, security.TokenUser)[0]
                finally:
                    token.Close()
                acl = security.ACL()
                for sid in (owner, security.CreateWellKnownSid(security.WinLocalSystemSid, None), package_sid):
                    acl.AddAccessAllowedAceEx(security.ACL_REVISION, 3, 0x1F01FF, sid)
                security.SetNamedSecurityInfo(str(cwd), security.SE_FILE_OBJECT,
                    security.DACL_SECURITY_INFORMATION | security.PROTECTED_DACL_SECURITY_INFORMATION,
                    None, None, acl, None)
                size = ctypes.c_size_t()
                kernel.InitializeProcThreadAttributeList(None, 2, 0, ctypes.byref(size))
                attributes = ctypes.create_string_buffer(size.value)
                if not kernel.InitializeProcThreadAttributeList(attributes, 2, 0, ctypes.byref(size)):
                    raise ctypes.WinError(ctypes.get_last_error())
                caps = SECURITY_CAPABILITIES(profile_sid, ctypes.pointer(capability), 1, 0)
                handles = (W.HANDLE * 2)(input_handle, output_handle)
                for number, value in ((0x20009, caps), (0x20002, handles)):
                    if not kernel.UpdateProcThreadAttribute(attributes, 0, number, ctypes.byref(value), ctypes.sizeof(value), None, None):
                        raise ctypes.WinError(ctypes.get_last_error())
                startup = STARTUPINFOEX()
                startup.StartupInfo.cb = ctypes.sizeof(startup)
                startup.StartupInfo.dwFlags = 0x100  # STARTF_USESTDHANDLES
                startup.StartupInfo.hStdInput = input_handle
                startup.StartupInfo.hStdOutput = startup.StartupInfo.hStdError = output_handle
                startup.lpAttributeList = ctypes.cast(attributes, W.LPVOID)
                self._job = jobs.CreateJobObject(None, '')
                limits = jobs.QueryInformationJobObject(self._job, jobs.JobObjectExtendedLimitInformation)
                limits['BasicLimitInformation'].update(LimitFlags=(jobs.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
                    jobs.JOB_OBJECT_LIMIT_ACTIVE_PROCESS | jobs.JOB_OBJECT_LIMIT_JOB_TIME |
                    jobs.JOB_OBJECT_LIMIT_PROCESS_MEMORY | jobs.JOB_OBJECT_LIMIT_JOB_MEMORY),
                    ActiveProcessLimit=8, PerJobUserTimeLimit=120000000)
                limits['ProcessMemoryLimit'] = 512 * 1024 * 1024
                limits['JobMemoryLimit'] = 768 * 1024 * 1024
                jobs.SetInformationJobObject(self._job, jobs.JobObjectExtendedLimitInformation, limits)
                jobs.SetInformationJobObject(self._job, jobs.JobObjectBasicUIRestrictions, {'UIRestrictionsClass': 0xff})
                environment = ctypes.create_unicode_buffer('\0'.join(k + '=' + str(v) for k, v in sorted(env.items(), key=lambda item: item[0].upper())) + '\0\0')
                command = ctypes.create_unicode_buffer(subprocess.list2cmdline([str(a) for a in arguments]))
                # Whitelist precisely the two inherited I/O handles. No auth,
                # native-messaging, thread or job handles reach the child.
                for h in (input_handle, output_handle):
                    api.SetHandleInformation(h, con.HANDLE_FLAG_INHERIT, con.HANDLE_FLAG_INHERIT)
                flags = 0x00080000 | 0x400 | 0x08000000 | 0x4  # extended, Unicode, no-window, suspended
                if not kernel.CreateProcessW(str(arguments[0]), command, None, None, True, flags,
                                              environment, str(cwd), ctypes.byref(startup), ctypes.byref(pi)):
                    raise ctypes.WinError(ctypes.get_last_error())
                self._process = api.OpenProcess(con.PROCESS_ALL_ACCESS, False, pi.dwProcessId)
                self.pid = pi.dwProcessId
                jobs.AssignProcessToJobObject(self._job, self._process)
                child_token = security.OpenProcessToken(self._process, con.TOKEN_QUERY)
                try:
                    is_container, required = W.DWORD(), W.DWORD()
                    if not advapi.GetTokenInformation(int(child_token), 29, ctypes.byref(is_container),
                                                       ctypes.sizeof(is_container), ctypes.byref(required)):
                        raise ctypes.WinError(ctypes.get_last_error())
                    if is_container.value != 1:  # TokenIsAppContainer
                        raise OSError('Child did not enter AppContainer; refusing to run TeX.')
                finally:
                    child_token.Close()
                if kernel.ResumeThread(pi.hThread) == 0xffffffff:
                    raise ctypes.WinError(ctypes.get_last_error())
            except BaseException:
                if pi.hProcess:
                    # Also covers a failure before assigning the suspended child.
                    import win32process
                    win32process.TerminateProcess(int(pi.hProcess), 1)
                self.close()
                raise
            finally:
                for h in (input_handle, output_handle):
                    api.SetHandleInformation(h, con.HANDLE_FLAG_INHERIT, 0)
                for h in (pi.hThread, pi.hProcess):
                    if h:
                        kernel.CloseHandle(h)
                if attributes is not None:
                    kernel.DeleteProcThreadAttributeList(attributes)
                if profile_sid:
                    advapi.FreeSid(profile_sid)

    def poll(self):
        import win32process
        code = win32process.GetExitCodeProcess(self._process)
        self.returncode = None if code == 259 else code
        return self.returncode

    def wait(self, timeout=None):
        _, _, event, _, _ = self._api
        if event.WaitForSingleObject(self._process, 0xffffffff if timeout is None else int(timeout * 1000)) == 258:
            raise subprocess.TimeoutExpired('sandboxed TeX', timeout)
        return self.poll()

    def close(self):
        if self._job is not None:
            self._api[3].TerminateJobObject(self._job, 1)
            self._job.Close()
            self._job = None
        if self._process is not None:
            self.wait(timeout=2)
            self._process.Close()
            self._process = None
        if self._profile_created:
            self._userenv.DeleteAppContainerProfile(self._profile)
            self._profile_created = False


if __name__ == '__main__':
    import argparse
    import json
    parser = argparse.ArgumentParser(description='Configure only the Windows TeX AppContainer read capability.')
    parser.add_argument('--configure', nargs='+', type=Path, required=True,
                        help='Explicit existing TeX Live root(s), e.g. D:\\texlive\\2024; run once as administrator.')
    options = parser.parse_args()
    try:
        result = []
        for root in options.configure:
            configure_tex_root(root)
            result.append({'root': str(root), 'configured': configured(root),
                           'readOnlyRecursive': str(root),
                           'readOnlyDirectoryOnly': [str(root.parent), str(Path(root.anchor))],
                           'capability': CAPABILITY, 'originalAclEntriesPreserved': True})
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except Exception as error:
        parser.exit(1, 'Windows TeX sandbox setup failed; compilation stays disabled: ' + str(error) + '\n')
