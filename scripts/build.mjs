import { build } from 'esbuild';
import { mkdir, copyFile, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { socketClientBrowserGlobalPlugin } from './socket-client-plugin.mjs';
await rm('dist', {recursive: true, force: true});
await mkdir('dist', {recursive: true});
await build({entryPoints: {'editor-bridge':'src/overleaf/editor-bridge.ts', content:'src/content.ts', background:'src/background.ts', 'api-settings':'src/codex/api-settings.ts'}, outdir:'dist', bundle:true, format:'iife', target:'chrome111', minify:true, legalComments:'linked', sourcemap:true, plugins:[socketClientBrowserGlobalPlugin]});
await build({entryPoints: ['src/preview/render.ts'], outfile:'dist/renderer.js', bundle:true, format:'esm', target:'chrome111', minify:true, legalComments:'linked', sourcemap:true});
await build({entryPoints: ['src/preview/cloud-pdf.ts'], outfile:'dist/cloud-pdf.js', bundle:true, format:'esm', target:'chrome111', minify:true, legalComments:'linked', sourcemap:true});
await cp('node_modules/pdfjs-dist/standard_fonts', 'dist/pdf-standard-fonts', {recursive:true});
await mkdir('dist/assets', {recursive:true});
await copyFile('assets/zero-two-avatar.png', 'dist/assets/zero-two-avatar.png');
await copyFile('assets/codex-app.png', 'dist/assets/codex-app.png');
await copyFile('manifest.json', 'dist/manifest.json');
await copyFile('api-settings.html', 'dist/api-settings.html');
await copyFile('api-settings.css', 'dist/api-settings.css');
// License inventory is checked against the pinned installed packages so an
// upgrade cannot silently reuse stale attributions in a distributable build.
for (const [name, version, license] of [
  ['mathjax-full', '3.2.2', 'MathJax-LICENSE.txt'],
  ['fflate', '0.8.2', 'fflate-LICENSE.txt'],
  ['pdfjs-dist', '6.4.299', 'PDFjs-LICENSE.txt'],
]) {
  const metadata = JSON.parse(await readFile(`node_modules/${name}/package.json`, 'utf8'));
  if (metadata.version !== version
      || !((await readFile(`node_modules/${name}/LICENSE`)).equals(await readFile(`licenses/${license}`)))) {
    throw new Error(`Review THIRD_PARTY_NOTICES.md and licenses/ for the installed ${name} before building.`);
  }
}
const socket = JSON.parse(await readFile('node_modules/socket.io-client/package.json', 'utf8'));
const socketReadme = await readFile('node_modules/socket.io-client/README.md', 'utf8');
const socketLicenseStart = socketReadme.indexOf('(The MIT License)');
if (socket.version !== '0.9.17-overleaf-6' || socketLicenseStart < 0
    || socketReadme.slice(socketLicenseStart) !== await readFile('licenses/socket.io-client-LICENSE.txt', 'utf8')) {
  throw new Error('Review the pinned socket.io-client license before building.');
}
await copyFile('THIRD_PARTY_NOTICES.md', 'dist/THIRD_PARTY_NOTICES.md');
await copyFile('LICENSE', 'dist/LICENSE');
await cp('licenses', 'dist/licenses', {recursive:true});
await writeFile('dist/THIRD_PARTY_NOTICES.txt', 'See THIRD_PARTY_NOTICES.md and licenses/ for the runtime component inventory, full license texts, font exceptions, and artwork provenance.\n');
console.log('Built unpacked extension in dist/');
