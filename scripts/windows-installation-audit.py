"""Read-only Windows installation audit; write only the requested JSON report.

Run with the same Windows account as Chrome. No native host is executed, no
installer is imported, and no credentials, conversations or project caches are
read. The manifest key inspected here is the extension's public identity key.
Exit 0 means all requested checks passed; exit 1 means a mismatch or read
failure. Use --expect-workspace to require Codex project configuration as well
as installed bytes. This does not verify live Chrome health or chat membership.
"""
import argparse
import ast
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys


ROOT = Path(__file__).absolute().parents[1]
SUPPORT = Path.home() / '.overleaf-personal-tools'
EXTENSION_ID = 'pffppbkokpnfafpechmlambifflkmbbn'
ORIGIN = 'chrome-extension://' + EXTENSION_ID + '/'
REGISTRY_ROOT = 'Software\\Google\\Chrome\\NativeMessagingHosts\\'
HOSTS = (
    ('com.overleaf.personal_tools.codex', 'codex-native-host', (
        'api_provider.py', 'cache_lifecycle.py', 'codex_host.py',
        'context_transport.py', 'desktop_ipc.py', 'desktop_state.py',
        'manuscript_mcp.py', 'platform_utils.py', 'project_context.py',
        'prompt_display.py', 'windows_desktop.py',
    )),
    ('com.overleaf.personal_tools', 'native-host', (
        'host.py', 'platform_utils.py', 'windows_tex.py',
    )),
)
DIST_FILES = (
    'content.js', 'editor-bridge.js', 'background.js', 'api-settings.js',
    'api-settings.html', 'api-settings.css', 'renderer.js', 'cloud-pdf.js',
)


def check_components(path):
    """Do not follow a substituted file/junction into unrelated user data."""
    for part in (path, *path.parents):
        try:
            info = part.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError('Refusing a symlink or reparse point: ' + str(part))


def read_bytes(path, limit=32 * 1024 * 1024):
    check_components(path)
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
        raise ValueError('Expected a regular audit input within ' + str(limit) + ' bytes: ' + str(path))
    return path.read_bytes()


def fingerprint(data):
    return {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def json_object(data):
    value = json.loads(data)
    if not isinstance(value, dict):
        raise ValueError('Expected a JSON object')
    return value


def same_path(actual, expected):
    return isinstance(actual, str) and os.path.normcase(os.path.abspath(actual)) == os.path.normcase(str(expected.absolute()))


def public_extension_id(manifest):
    decoded = base64.b64decode(manifest['key'], validate=True)
    if not 32 <= len(decoded) <= 4096:
        raise ValueError('Invalid public extension key size')
    return ''.join(chr(ord('a') + int(n, 16)) for n in hashlib.sha256(decoded).hexdigest()[:32])


def declared_version(data):
    # Read a literal without importing or executing either native host.
    for node in ast.parse(data.decode('utf-8-sig')).body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'VERSION' for t in node.targets):
            if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                return node.value.value
    return None


def workspace_configuration(expected_workspace=None, expected_project_id=None):
    """Inspect only the helper's explicit routing configuration, never history."""
    path = SUPPORT / 'codex-native-host' / 'workspace.json'
    result = {'status': 'unconfigured', 'present': False,
              'effectiveWorkingDirectory': str(SUPPORT / 'codex-assistant'),
              'backendProjectId': None, 'backendProjectVerified': False,
              'expectedWorkspace': str(expected_workspace) if expected_workspace else None,
              'expectedBackendProjectId': expected_project_id,
              'matchesExpectedWorkspace': None, 'matchesExpectedBackendProjectId': None}
    try:
        check_components(path)
        if path.exists():
            result['present'] = True
            config = json_object(read_bytes(path, 4096))
            workspace, identifier = config.get('workspace'), config.get('projectId')
            if set(config) - {'workspace', 'projectId'}:
                raise ValueError('Workspace configuration contains unexpected fields')
            if not isinstance(workspace, str) or '\0' in workspace or not Path(workspace).is_absolute() or not Path(workspace).is_dir():
                raise ValueError('Configured workspace must be an existing absolute directory')
            if identifier is not None and (not isinstance(identifier, str) or not re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', identifier)):
                raise ValueError('Configured backend project ID must be a UUID')
            result.update(status='configured' if identifier else 'workspace-only',
                          effectiveWorkingDirectory=workspace, backendProjectId=identifier)
    except (OSError, ValueError, TypeError) as error:
        result['status'] = 'invalid'
        result['effectiveWorkingDirectory'] = None
        result['error'] = str(error)
    if expected_workspace is not None:
        result['matchesExpectedWorkspace'] = result['status'] == 'configured' and same_path(result['effectiveWorkingDirectory'], expected_workspace)
    if expected_project_id is not None:
        result['matchesExpectedBackendProjectId'] = result['status'] == 'configured' and result['backendProjectId'] == expected_project_id
    result['checksPassed'] = result['status'] != 'invalid' and all(result[key] is not False for key in ('matchesExpectedWorkspace', 'matchesExpectedBackendProjectId'))
    return result


def audit(expected_workspace=None, expected_project_id=None):
    import winreg

    report = {
        'schemaVersion': 2,
        'auditedAt': datetime.now(timezone.utc).isoformat(),
        'version': None,
        'fixedExtensionId': EXTENSION_ID,
        'fixedAllowedOrigin': ORIGIN,
        'distManifestMatches': False,
        'versionsMatch': False,
        'fixedExtensionIdMatches': False,
        'distFiles': {},
        'hosts': [],
        'errors': [],
        'warnings': [],
    }
    errors = report['errors']
    try:
        source_bytes = read_bytes(ROOT / 'manifest.json')
        dist_bytes = read_bytes(ROOT / 'dist' / 'manifest.json')
        source = json_object(source_bytes)
        dist = json_object(dist_bytes)
        package = json_object(read_bytes(ROOT / 'package.json'))
        report['version'] = source.get('version')
        report['manifest'] = {'source': fingerprint(source_bytes), 'dist': fingerprint(dist_bytes)}
        report['distManifestMatches'] = source_bytes == dist_bytes
        versions = {'manifest': source.get('version'), 'distManifest': dist.get('version'), 'package': package.get('version')}
        report['versions'] = versions
        report['versionsMatch'] = bool(isinstance(versions['manifest'], str) and re.fullmatch(r'\d+(?:\.\d+){1,3}', versions['manifest']) and len(set(versions.values())) == 1)
        report['fixedExtensionIdMatches'] = public_extension_id(source) == public_extension_id(dist) == EXTENSION_ID
    except (OSError, ValueError, TypeError, KeyError) as error:
        errors.append('Extension manifests: ' + str(error))

    for name in DIST_FILES:
        try:
            data = read_bytes(ROOT / 'dist' / name)
            report['distFiles'][name] = {**fingerprint(data), 'nonempty': bool(data)}
        except (OSError, ValueError) as error:
            report['distFiles'][name] = {'nonempty': False}
            errors.append('dist/' + name + ': ' + str(error))

    for name, leaf, files in HOSTS:
        directory = SUPPORT / leaf
        manifest_path = SUPPORT / 'NativeMessagingHosts' / (name + '.json')
        host = {'name': name, 'registrationMatches': False, 'registryViews': {},
                'fixedOriginMatches': False, 'manifestMatches': False,
                'launcherPresent': False, 'sourceFilesMatch': {}, 'sourceFiles': {}}
        report['hosts'].append(host)
        for label, view in (('32', winreg.KEY_WOW64_32KEY), ('64', winreg.KEY_WOW64_64KEY)):
            try:
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, REGISTRY_ROOT + name, 0, winreg.KEY_READ | view) as key:
                    value, kind = winreg.QueryValueEx(key, '')
                host['registryViews'][label] = {'typeMatches': kind == winreg.REG_SZ, 'pathMatches': same_path(value, manifest_path)}
            except OSError as error:
                host['registryViews'][label] = {'typeMatches': False, 'pathMatches': False}
                errors.append(name + ' HKCU ' + label + '-bit: ' + str(error))
        host['registrationMatches'] = all(all(view.values()) for view in host['registryViews'].values())
        try:
            # Read only our expected manifest, never a registry-selected path.
            manifest_bytes = read_bytes(manifest_path)
            manifest = json_object(manifest_bytes)
            host['manifestFingerprint'] = fingerprint(manifest_bytes)
            host['fixedOriginMatches'] = manifest.get('allowed_origins') == [ORIGIN]
            host['manifestMatches'] = manifest.get('name') == name and manifest.get('type') == 'stdio' and same_path(manifest.get('path'), directory / 'launch.cmd')
            launcher_bytes = read_bytes(directory / 'launch.cmd')
            host['launcherPresent'] = bool(launcher_bytes)
            host['launcherFingerprint'] = fingerprint(launcher_bytes)
        except (OSError, ValueError, TypeError) as error:
            errors.append(name + ' manifest/launcher: ' + str(error))
        for filename in files:
            host['sourceFilesMatch'][filename] = False
            try:
                source_data = read_bytes(ROOT / 'native' / filename)
                installed_data = read_bytes(directory / filename)
                source_hash, installed_hash = fingerprint(source_data), fingerprint(installed_data)
                host['sourceFiles'][filename] = {'source': source_hash, 'installed': installed_hash}
                host['sourceFilesMatch'][filename] = source_hash == installed_hash
                if filename in ('host.py', 'codex_host.py'):
                    host['declaredVersion'] = declared_version(installed_data)
            except (OSError, ValueError, SyntaxError) as error:
                errors.append(name + '/' + filename + ': ' + str(error))

    report['pythonCopiesChecked'] = sum(len(host['sourceFilesMatch']) for host in report['hosts'])
    report['pythonCopiesMatched'] = sum(sum(host['sourceFilesMatch'].values()) for host in report['hosts'])
    report['codexVersionMatches'] = report['hosts'][0].get('declaredVersion') == report['version'] and bool(report['version'])
    passed = not errors and all(report[key] for key in ('distManifestMatches', 'versionsMatch', 'fixedExtensionIdMatches', 'codexVersionMatches'))
    passed = passed and all(entry['nonempty'] for entry in report['distFiles'].values())
    passed = passed and report['pythonCopiesChecked'] == report['pythonCopiesMatched'] == 14
    passed = passed and all(all(host[key] for key in ('registrationMatches', 'fixedOriginMatches', 'manifestMatches', 'launcherPresent')) for host in report['hosts'])
    report['installationResult'] = 'passed' if passed else 'failed'
    workspace = workspace_configuration(expected_workspace, expected_project_id)
    report['workspaceConfiguration'] = workspace
    if workspace['status'] == 'unconfigured':
        report['warnings'].append('No Codex workspace is configured; new chats use the helper data directory and have no explicit backend project assignment.')
    elif workspace['status'] == 'workspace-only':
        report['warnings'].append('A working directory is configured without an explicit backend project ID.')
    if not workspace['checksPassed']:
        errors.append('Codex workspace configuration is invalid, missing, or does not match the requested project.')
    report['result'] = 'passed' if passed and workspace['checksPassed'] else 'failed'
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, help='JSON report path; default: artifacts/windows-installation-audit-<version>.json')
    parser.add_argument('--expect-workspace', type=Path, help='Require this working directory and a configured backend project ID.')
    parser.add_argument('--expect-project-id', help='Also require this exact app-server backend project ID; not necessarily the Desktop project ID.')
    options = parser.parse_args()
    if sys.platform != 'win32':
        parser.error('This audit requires Windows and the Chrome user account.')
    expected_workspace = Path(os.path.abspath(options.expect_workspace)) if options.expect_workspace else None
    if options.expect_project_id and not re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', options.expect_project_id):
        parser.error('--expect-project-id must be a backend project UUID.')
    report = audit(expected_workspace, options.expect_project_id)
    version = report['version'] if isinstance(report['version'], str) and re.fullmatch(r'\d+(?:\.\d+){1,3}', report['version']) else 'unknown'
    output = Path(os.path.abspath(options.output or ROOT / 'artifacts' / ('windows-installation-audit-' + version + '.json')))
    check_components(output)
    if output.suffix.lower() != '.json' or output.is_relative_to(SUPPORT.absolute()):
        parser.error('The output must be a JSON report outside the installed helper directory.')
    if output.is_relative_to(ROOT) and not output.is_relative_to(ROOT / 'artifacts'):
        parser.error('Reports inside this checkout must be written under artifacts/.')
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'result': report['result'], 'version': report['version'],
                      'pythonCopiesMatched': report['pythonCopiesMatched'],
                      'pythonCopiesChecked': report['pythonCopiesChecked'],
                      'workspaceStatus': report['workspaceConfiguration']['status'],
                      'workspaceChecksPassed': report['workspaceConfiguration']['checksPassed'],
                      'warnings': report['warnings'], 'report': str(output)}, ensure_ascii=False))
    return 0 if report['result'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
