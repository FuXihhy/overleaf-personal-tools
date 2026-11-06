#!/usr/bin/python3
"""Prepare or explicitly register this extension's macOS Chrome native host."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import sys

HOST_NAME = "com.overleaf.personal_tools"
PYTHON = "/usr/bin/python3"
MARKER = ".overleaf-personal-tools-native-host.json"


def extension_id(manifest):
    key = manifest.get("key")
    if not isinstance(key, str):
        raise ValueError("Extension manifest must contain a stable public key.")
    decoded = base64.b64decode(key, validate=True)
    if not 32 <= len(decoded) <= 4096:
        raise ValueError("Invalid extension public key size.")
    digest = hashlib.sha256(decoded).hexdigest()[:32]
    return "".join(chr(ord("a") + int(nibble, 16)) for nibble in digest)


def paths(home):
    support = home / "Library" / "Application Support"
    directory = support / "OverleafPersonalTools" / "native-host"
    manifest = support / "Google" / "Chrome" / "NativeMessagingHosts" / (HOST_NAME + ".json")
    return directory, manifest


def native_manifest(identifier, directory):
    return {"name": HOST_NAME, "description": "Sandboxed TeX preview for Overleaf Personal Tools", "path": str(directory / "launch"), "type": "stdio", "allowed_origins": ["chrome-extension://" + identifier + "/"]}


def require_owned_directory(directory):
    if directory.is_symlink():
        raise ValueError("Refusing a symlink at the dedicated native host directory.")
    if directory.exists():
        marker = directory / MARKER
        if not marker.is_file() or marker.is_symlink() or json.loads(marker.read_text()).get("name") != HOST_NAME:
            raise ValueError("Existing native host directory is not marked as owned by this installer.")


def install(identifier, source, home):
    directory, manifest_path = paths(home)
    require_owned_directory(directory)
    if manifest_path.is_symlink():
        raise ValueError("Refusing a symlink at the native host manifest.")
    if manifest_path.exists():
        previous = json.loads(manifest_path.read_text())
        if previous.get("name") != HOST_NAME or previous.get("path") != str(directory / "launch"):
            raise ValueError("Existing native host registration belongs to another installation.")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(str(directory), 0o700)
    # Atomic replace avoids following a malicious pre-existing file symlink.
    content = {
        "host.py": source.read_bytes(),
        "launch": ("#!/bin/sh\nexec " + PYTHON + " " + shlex.quote(str(directory / "host.py")) + "\n").encode(),
        MARKER: (json.dumps({"name": HOST_NAME, "extensionId": identifier}) + "\n").encode(),
    }
    for name, data in content.items():
        temporary = directory / (name + ".new")
        if temporary.is_symlink():
            raise ValueError("Unexpected symlink in native host directory.")
        temporary.write_bytes(data)
        os.chmod(str(temporary), 0o700 if name == "launch" else 0o600)
        os.replace(str(temporary), str(directory / name))
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = manifest_path.with_suffix(".json.new")
    if temporary.is_symlink():
        raise ValueError("Unexpected native manifest staging symlink.")
    temporary.write_text(json.dumps(native_manifest(identifier, directory), indent=2) + "\n")
    os.chmod(str(temporary), 0o600)
    os.replace(str(temporary), str(manifest_path))
    return directory, manifest_path


def uninstall(home):
    directory, manifest_path = paths(home)
    require_owned_directory(directory)
    if manifest_path.is_symlink():
        raise ValueError("Refusing to remove a symlink native host registration.")
    if manifest_path.exists():
        current = json.loads(manifest_path.read_text())
        if current.get("name") != HOST_NAME or current.get("path") != str(directory / "launch"):
            raise ValueError("Refusing to remove another native host installation.")
        manifest_path.unlink()
    if directory.exists():
        shutil.rmtree(str(directory))
    return directory, manifest_path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument("--install", action="store_true", help="Register the host for this user's Google Chrome.")
    actions.add_argument("--uninstall", action="store_true", help="Remove only this host's registration and marked directory.")
    parser.add_argument("--extension-manifest", type=Path, default=Path(__file__).resolve().parent.parent / "manifest.json")
    options = parser.parse_args()
    home = Path.home()
    if options.uninstall:
        directory, manifest_path = uninstall(home)
        print("Removed %s and %s" % (manifest_path, directory))
        return
    identifier = extension_id(json.loads(options.extension_manifest.read_text()))
    source = Path(__file__).resolve().parent / "host.py"
    if not source.is_file() or not Path(PYTHON).is_file():
        raise ValueError("Missing host.py or the fixed system Python runtime.")
    directory, manifest_path = paths(home)
    if options.install:
        install(identifier, source, home)
        print("Installed %s for extension %s" % (HOST_NAME, identifier))
    else:
        # Preparation is deliberately read-only; registration needs --install.
        print(json.dumps({"action": "prepared; no files changed", "extensionId": identifier, "hostDirectory": str(directory), "manifestPath": str(manifest_path), "manifest": native_manifest(identifier, directory)}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        print("Native host setup failed: " + str(error), file=sys.stderr)
        sys.exit(1)
