"""Shared installer mechanics; only this user's exact owned registrations."""
import os
from pathlib import Path
import shlex
import sys
from platform_utils import IS_WINDOWS, support_directory, check_components, private_directory

PYTHON = sys.executable if IS_WINDOWS else '/usr/bin/python3'
LAUNCH_NAME = 'launch.cmd' if IS_WINDOWS else 'launch'


def paths(home, host_name, leaf):
    support = support_directory(home)
    directory = support / leaf
    if IS_WINDOWS:
        manifest = support / 'NativeMessagingHosts' / (host_name + '.json')
    else:
        manifest = Path(home) / 'Library/Application Support/Google/Chrome/NativeMessagingHosts' / (host_name + '.json')
    return directory, manifest


def launcher(directory, script):
    if IS_WINDOWS:
        # No PATH lookup, shell-injected browser input, or console output.
        python = PYTHON.replace('%', '%%')
        target = str(directory / script).replace('%', '%%')
        if any(c in python + target for c in '\r\n"'):
            raise ValueError('Unsafe native launcher path.')
        return ('@echo off\r\nchcp 65001 >nul\r\nsetlocal DisableDelayedExpansion\r\n"' + python + '" -X utf8 -u "' + target + '" %*\r\n').encode('utf-8')
    return ('#!/bin/sh\nexec ' + PYTHON + ' ' + shlex.quote(str(directory / script)) + '\n').encode()


def prepare_directories(home, directory, manifest):
    for path in (directory, manifest):
        check_components(path)
    private_directory(support_directory(home))
    private_directory(directory)
    if IS_WINDOWS:
        private_directory(manifest.parent)
    else:
        manifest.parent.mkdir(parents=True, exist_ok=True)


def registration(home, host_name, manifest, remove=False):
    # A synthetic home installs files only; tests must not alter real HKCU.
    if not IS_WINDOWS or Path(home).absolute() != Path.home().absolute():
        return
    import winreg
    name = 'Software\\Google\\Chrome\\NativeMessagingHosts\\' + host_name
    for view in (winreg.KEY_WOW64_32KEY, winreg.KEY_WOW64_64KEY):
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, name, 0, winreg.KEY_READ | view) as key:
                current, kind = winreg.QueryValueEx(key, '')
                if kind != winreg.REG_SZ or os.path.normcase(current) != os.path.normcase(str(manifest)):
                    raise ValueError('A native messaging registration belongs to another installation.')
        except FileNotFoundError:
            pass
    for view in (winreg.KEY_WOW64_32KEY, winreg.KEY_WOW64_64KEY):
        if remove:
            try:
                winreg.DeleteKeyEx(winreg.HKEY_CURRENT_USER, name, view, 0)
            except FileNotFoundError:
                pass
        else:
            with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, name, 0, winreg.KEY_SET_VALUE | view) as key:
                winreg.SetValueEx(key, '', 0, winreg.REG_SZ, str(manifest))
