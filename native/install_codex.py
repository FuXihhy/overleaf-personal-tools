#!/usr/bin/python3
"""Prepare or explicitly register this extension's local Codex Assistant native host."""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
import shlex
import shutil
import subprocess
import time
import sys

HOST_NAME = "com.overleaf.personal_tools.codex"
# Script-directory imports also work for importlib-based installer tests.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from platform_utils import IS_WINDOWS, private_permissions, check_components, is_link
from native_setup import PYTHON, LAUNCH_NAME, paths as host_paths, launcher, prepare_directories, registration
MARKER = ".overleaf-personal-tools-codex-host.json"
READER_MARKER = '.reader-registration.json'


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
    return host_paths(home, HOST_NAME, "codex-native-host")


def native_manifest(identifier, directory):
    return {"name": HOST_NAME, "description": "Codex Assistant for Overleaf Personal Tools", "path": str(directory / LAUNCH_NAME), "type": "stdio", "allowed_origins": ["chrome-extension://" + identifier + "/"]}


def require_owned_directory(directory):
    check_components(directory)
    if is_link(directory):
        raise ValueError("Refusing a symlink at the dedicated native host directory.")
    if directory.exists():
        marker = directory / MARKER
        if not marker.is_file() or is_link(marker) or json.loads(marker.read_text()).get("name") != HOST_NAME:
            raise ValueError("Existing native host directory is not marked as owned by this installer.")


def install(identifier, source, home, workspace=None, project_id=None):
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
        "codex_host.py": source.read_bytes(),
        LAUNCH_NAME: launcher(directory, "codex_host.py"),
        MARKER: (json.dumps({"name": HOST_NAME, "extensionId": identifier}) + "\n").encode(),
    }
    adapters = {}
    for name in ('desktop_ipc.py', 'desktop_state.py', 'api_provider.py', 'prompt_display.py',
                 'project_context.py', 'manuscript_mcp.py', 'context_transport.py',
                 'platform_utils.py', 'windows_desktop.py', 'cache_lifecycle.py'):
        companion = source.parent / name
        # Synthetic installer fixtures may supply only a stub host. Production
        # hosts import both adapters and must ship the matching files atomically.
        if companion.is_file():
            adapters[name] = companion.read_bytes()
        elif b'from desktop_' in content['codex_host.py']:
            raise ValueError('The Codex helper is missing its Desktop adapter: ' + name)
    # Install dependencies before publishing the entrypoint that imports them.
    content = dict(adapters, **content)
    workspace_path = directory / 'workspace.json'
    if is_link(workspace_path):
        raise ValueError('Refusing a symlink workspace configuration.')
    if workspace is not None:
        workspace = Path(workspace)
        if not workspace.is_absolute() or not workspace.is_dir():
            raise ValueError('The Codex workspace must be an existing absolute directory.')
        if project_id is not None and (not isinstance(project_id, str) or not re.fullmatch(r'[a-fA-F0-9-]{36}', project_id)):
            raise ValueError('Invalid Codex backend project ID.')
        content['workspace.json'] = (json.dumps({'workspace': str(workspace.resolve()), 'projectId': project_id}) + '\n').encode()
    elif project_id is not None:
        raise ValueError('--project-id requires --workspace.')
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


def configure_reader_mcp(directory, executable):
    """Register only our fixed read-only stdio reader, preserving other entries."""
    name = 'overleaf_project'
    script = str(directory / 'manuscript_mcp.py')
    if not Path(script).is_file():
        raise ValueError('The complete project reader was not installed.')
    current = subprocess.run([executable, 'mcp', 'get', name, '--json'],
                             capture_output=True, timeout=20, check=False)
    if current.returncode == 0:
        try:
            entry = json.loads(current.stdout)
            transport = entry.get('transport', entry)
        except (ValueError, TypeError):
            raise ValueError('Could not verify the existing overleaf_project MCP registration.') from None
        if transport.get('command') != PYTHON or transport.get('args') != [script]:
            raise ValueError('An overleaf_project MCP registration already belongs to another installation; it was not changed.')
        if entry.get('enabled') is False:
            raise ValueError('The overleaf_project MCP is disabled. Enable it in Codex MCP settings to read complete projects.')
    else:
        result = subprocess.run([executable, 'mcp', 'add', name, '--', PYTHON, script],
                                capture_output=True, timeout=20, check=False)
        if result.returncode:
            raise ValueError('Could not register the local overleaf_project MCP reader in Codex.')
    # Only changes to the reader or snapshot decoder require a new Desktop
    # startup gate. Re-registering a CLI cannot reload an existing reader process.
    # Include names/separators so missing/replaced dependencies cannot collide.
    reader_digest = hashlib.sha256()
    for name in ('manuscript_mcp.py', 'project_context.py', 'platform_utils.py', 'cache_lifecycle.py'):
        path = directory / name
        if is_link(path):
            raise ValueError('Unexpected project reader source symlink.')
        reader_digest.update(name.encode('ascii') + b'\0')
        reader_digest.update(path.read_bytes() if path.is_file() else b'<missing>')
        reader_digest.update(b'\0')
    reader_digest = reader_digest.hexdigest()
    marker = directory / READER_MARKER
    if is_link(marker):
        raise ValueError('Unexpected project reader registration symlink.')
    valid_marker = False
    if marker.exists():
        try:
            saved = json.loads(marker.read_text())
            valid_marker = (saved.get('version') == 1 and saved.get('script') == script
                            and saved.get('readerDigest') == reader_digest
                            and type(saved.get('registeredAt')) in (int, float)
                            and 0 < saved['registeredAt'] <= time.time())
        except (ValueError, TypeError):
            pass
    if current.returncode != 0 or not valid_marker:
        temporary = directory / (READER_MARKER + '.new')
        if is_link(temporary):
            raise ValueError('Unexpected reader marker staging symlink.')
        descriptor = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0), 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            private_permissions(stream.fileno(), 0o600)
            json.dump({'version': 1, 'registeredAt': time.time(), 'script': script,
                       'readerDigest': reader_digest}, stream)
        os.replace(str(temporary), str(marker))


def unregister_reader_mcp(directory, executable):
    """Remove only the exact owned registration, never another same-name MCP."""
    current = subprocess.run([executable, 'mcp', 'get', 'overleaf_project', '--json'],
                             capture_output=True, timeout=20, check=False)
    if current.returncode:
        return
    try:
        entry = json.loads(current.stdout)
        transport = entry.get('transport', entry)
    except (ValueError, TypeError):
        raise ValueError('Could not verify the project reader registration for removal.') from None
    if transport.get('command') != PYTHON or transport.get('args') != [str(directory / 'manuscript_mcp.py')]:
        return
    result = subprocess.run([executable, 'mcp', 'remove', 'overleaf_project'],
                            capture_output=True, timeout=20, check=False)
    if result.returncode:
        raise ValueError('Could not remove the owned project reader registration.')


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


def resolve_project_id(source, workspace, server_factory=None):
    """Resolve an existing app-server project; no thread or model is started."""
    if server_factory is None:
        spec = importlib.util.spec_from_file_location('opt_codex_installer_host', str(source))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        server_factory = module.AppServer
    server = server_factory(workspace)
    try:
        cursor, seen, matches = None, set(), []
        while True:
            params = {'limit': 100}
            if cursor:
                params['cursor'] = cursor
            page = server.request('project/list', params)
            for project in page.get('data', []):
                if project.get('name') == workspace.name and any(root.get('path') == str(workspace) for root in project.get('roots', [])):
                    matches.append(project['id'])
            cursor = page.get('nextCursor')
            if not cursor:
                break
            if cursor in seen:
                raise ValueError('Codex returned an invalid project cursor.')
            seen.add(cursor)
        if len(matches) != 1:
            raise ValueError('Could not identify one existing Codex project for this workspace; supply its backend --project-id.')
        return matches[0]
    finally:
        server.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument("--install", action="store_true", help="Register the host for this user's Google Chrome.")
    actions.add_argument("--uninstall", action="store_true", help="Remove only this host's registration and marked directory.")
    parser.add_argument("--extension-manifest", type=Path, default=Path(__file__).resolve().parent.parent / "manifest.json")
    parser.add_argument('--workspace', type=Path, help='Existing Codex project directory; history stays in its private data directory.')
    parser.add_argument('--project-id', help='Existing app-server backend project ID; otherwise resolved from the workspace.')
    options = parser.parse_args()
    home = Path.home()
    if options.uninstall:
        directory, _ = paths(home)
        require_owned_directory(directory)
        source = Path(__file__).resolve().parent / 'codex_host.py'
        spec = importlib.util.spec_from_file_location('opt_codex_reader_remove', str(source))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        unregister_reader_mcp(directory, module.codex_path())
        directory, manifest_path = uninstall(home)
        print("Removed %s and %s" % (manifest_path, directory))
        return
    identifier = extension_id(json.loads(options.extension_manifest.read_text()))
    source = Path(__file__).resolve().parent / "codex_host.py"
    if not source.is_file() or not Path(PYTHON).is_file():
        raise ValueError("Missing codex_host.py or the fixed system Python runtime.")
    directory, manifest_path = paths(home)
    if options.project_id and not options.workspace:
        raise ValueError('--project-id requires --workspace.')
    workspace = options.workspace.resolve() if options.workspace else None
    if workspace and not workspace.is_dir():
        raise ValueError('The Codex workspace must already exist.')
    project_id = options.project_id
    if options.install and workspace and not project_id:
        project_id = resolve_project_id(source, workspace)
    if options.install:
        install(identifier, source, home, workspace, project_id)
        spec = importlib.util.spec_from_file_location('opt_codex_reader_setup', str(source))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        configure_reader_mcp(directory, module.codex_path())
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
