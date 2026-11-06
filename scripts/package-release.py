#!/usr/bin/env python3
"""Package the current source tree and built browser extension; no user state."""
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile


ROOT = Path(__file__).resolve().parents[1]


def archive(destination, entries):
    with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as output:
        for source, name in entries:
            if source.is_symlink() or not source.is_file():
                raise ValueError('Expected a regular release file: ' + str(source))
            output.write(source, name)
    with zipfile.ZipFile(destination) as output:
        if output.testzip() is not None:
            raise ValueError('Release archive failed its CRC check.')


def main():
    package = json.loads((ROOT / 'package.json').read_text())
    version = package['version']
    manifest = json.loads((ROOT / 'manifest.json').read_text())
    built = json.loads((ROOT / 'dist/manifest.json').read_text())
    if manifest['version'] != version or built['version'] != version:
        raise ValueError('Run the checks/build for the current version first.')
    files = subprocess.check_output(
        ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=ROOT
    ).decode().split('\0')
    # Explicit roots keep unrelated local additions out of release artifacts.
    roots = {'src', 'native', 'tests', 'scripts', 'dev', 'assets', 'docs'}
    top = {'.gitignore', 'README.md', 'CHANGELOG.md', 'CHROMEWEBSTORE.md',
           'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json',
           'manifest.json', 'api-settings.html', 'api-settings.css', 'dev.sh'}
    source_entries = []
    for name in sorted(set(files) - {''}):
        path = Path(name)
        if name not in top and path.parts[0] not in roots:
            continue
        if name.startswith('docs/screenshots/') or '__pycache__' in path.parts:
            continue
        if (path.name.startswith('.env') or path.suffix in {'.pem', '.key', '.p12', '.pfx', '.db', '.sqlite3', '.log'}
                or path.name in {'auth.json', 'workspace.json', 'profiles.json'}):
            raise ValueError('Local state must not be packaged: ' + name)
        source_entries.append((ROOT / name, f'overleaf-personal-tools-{version}/' + name))
    names = {name.split('/', 1)[1] for _, name in source_entries}
    required = {'src/content.ts', 'src/preview/render.ts', 'src/codex/panel.ts',
                'native/host.py', 'native/codex_host.py', 'native/install.py',
                'native/install_codex.py', 'pnpm-lock.yaml', 'docs/windows.md'}
    if not required.issubset(names):
        raise ValueError('Source archive is missing required components: ' + str(required - names))
    output = ROOT / 'artifacts' / ('release-' + version)
    output.mkdir(parents=True, exist_ok=True)
    browser = output / f'overleaf-personal-tools-{version}.zip'
    source = output / f'overleaf-personal-tools-{version}-source.zip'
    browser_entries = [(path, path.relative_to(ROOT / 'dist').as_posix())
                       for path in sorted((ROOT / 'dist').rglob('*')) if path.is_file()]
    archive(browser, browser_entries)
    archive(source, source_entries)
    checksums = ''.join(hashlib.sha256(path.read_bytes()).hexdigest() + '  ' + path.name + '\n'
                        for path in (browser, source))
    (output / 'SHA256SUMS.txt').write_text(checksums)
    print(json.dumps({'version': version, 'browserFiles': len(browser_entries),
                      'sourceFiles': len(source_entries), 'output': str(output)}, indent=2))


if __name__ == '__main__':
    main()
