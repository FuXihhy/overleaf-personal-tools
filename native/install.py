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
# Script-directory imports also work for importlib-based installer tests.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from platform_utils import IS_WINDOWS, private_permissions, check_components, is_link
from native_setup import PYTHON, LAUNCH_NAME, paths as host_paths, launcher, prepare_directories, registration
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
    return host_paths(home, HOST_NAME, "native-host")


def native_manifest(identifier, directory):
    return {"name": HOST_NAME, "description": "Sandboxed TeX preview for Overleaf Personal Tools", "path": str(directory / LAUNCH_NAME), "type": "stdio", "allowed_origins": ["chrome-extension://" + identifier + "/"]}


def require_owned_directory(directory):
    check_components(directory)
    if is_link(directory):
        raise ValueError("Refusing a symlink at the dedicated native host directory.")
    if directory.exists():
        marker = directory / MARKER
        if not marker.is_file() or is_link(marker) or json.loads(marker.read_text()).get("name") != HOST_NAME:
            raise ValueError("Existing native host directory is not marked as owned by this installer.")


def install(identifier, source, home):
    directory, manifest_path = paths(home)
    require_owned_directory(directory)
    if is_link(manifest_path):
        raise ValueError("Refusing a symlink at the native host manifest.")
    if manifest_path.exists():
        previous = json.loads(manifest_path.read_text())
        if previous.get("name") != HOST_NAME or previous.get("path") != str(directory / LAUNCH_NAME):
            raise ValueError("Existing native host registration belongs to another installation.")
    prepare_directories(home, directory, manifest_path)
    # Atomic replace avoids following a malicious pre-existing file symlink.
    content = {
        "host.py": source.read_bytes(),
        LAUNCH_NAME: launcher(directory, "host.py"),
        MARKER: (json.dumps({"name": HOST_NAME, "extensionId": identifier}) + "\n").encode(),
    }
    for companion_name in ('platform_utils.py', 'windows_tex.py'):
        companion = source.parent / companion_name
        if companion.is_file():
            content[companion_name] = companion.read_bytes()
    for name, data in content.items():
        temporary = directory / (name + ".new")
        if is_link(temporary):
            raise ValueError("Unexpected symlink in native host directory.")
        temporary.write_bytes(data)
        private_permissions(temporary, 0o700 if name == LAUNCH_NAME else 0o600)
        os.replace(str(temporary), str(directory / name))
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = manifest_path.with_suffix(".json.new")
    if is_link(temporary):
        raise ValueError("Unexpected native manifest staging symlink.")
    temporary.write_text(json.dumps(native_manifest(identifier, directory), indent=2) + "\n", encoding="utf-8")
    private_permissions(temporary, 0o600)
    os.replace(str(temporary), str(manifest_path))
    registration(home, HOST_NAME, manifest_path)
    return directory, manifest_path


def uninstall(home):
    directory, manifest_path = paths(home)
    check_components(manifest_path)
    require_owned_directory(directory)
    if is_link(manifest_path):
        raise ValueError("Refusing to remove a symlink native host registration.")
    if manifest_path.exists():
        current = json.loads(manifest_path.read_text())
        if current.get("name") != HOST_NAME or current.get("path") != str(directory / LAUNCH_NAME):
            raise ValueError("Refusing to remove another native host installation.")
    registration(home, HOST_NAME, manifest_path, remove=True)
    if manifest_path.exists():
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
        if IS_WINDOWS:
            from windows_tex import configure_tex_roots
            configure_tex_roots()
    else:
        # Preparation is deliberately read-only; registration needs --install.
        print(json.dumps({"action": "prepared; no files changed", "extensionId": identifier, "hostDirectory": str(directory), "manifestPath": str(manifest_path), "manifest": native_manifest(identifier, directory)}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        print("Native host setup failed: " + str(error), file=sys.stderr)
        sys.exit(1)
