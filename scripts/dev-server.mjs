import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { build } from 'esbuild';
import { strToU8, zipSync } from 'fflate';
import { sources, PROJECT_ID } from '../dev/fixtures.mjs';
import { socketClientBrowserGlobalPlugin } from './socket-client-plugin.mjs';

// Explicitly local-only. No authentication or personal project data is used.
const root = resolve(import.meta.dirname, '..');
const port = Number(process.env.OPT_DEV_PORT || 43123);
await build({ entryPoints: [resolve(root, 'dev/harness.ts')], outfile: resolve(root, 'dev/harness.js'), bundle: true, format: 'esm', target: 'chrome111', external: ['/dist/*','/dev/content.js'], sourcemap: true });
await build({ entryPoints: [resolve(root, 'dev/api-settings-harness.ts')], outfile: resolve(root, 'dev/generated/api-settings-harness.js'), bundle: true, format: 'esm', target: 'chrome145', sourcemap: true });
await build({ entryPoints: [resolve(root, 'src/content.ts')], outfile: resolve(root, 'dev/content.js'), bundle: true, format: 'esm', target: 'chrome111', sourcemap: true, plugins: [{
  name: 'synthetic-cloud-transport', setup(plugin) {
    plugin.onLoad({ filter: /[/\\]src[/\\]overleaf[/\\]cloud-client\.ts$/ }, async () => ({
      contents: await readFile(resolve(root, 'dev/cloud-client.ts'), 'utf8'), loader: 'ts',
    }));
  },
}, socketClientBrowserGlobalPlugin] });
const zip = zipSync(Object.fromEntries(Object.entries(sources).map(([path, text]) => [path, strToU8(text)])));
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.map': 'application/json', '.png': 'image/png' };
const server = createServer(async (request, response) => {
  try {
    if (request.method !== 'GET') { response.writeHead(405).end(); return; }
    const path = new URL(request.url, `http://127.0.0.1:${port}`).pathname;
    if (path === `/project/${PROJECT_ID}/download/zip`) { response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': zip.length }).end(zip); return; }
    const allowed = path.startsWith('/dev/') || path.startsWith('/dist/');
    const target = path === `/project/${PROJECT_ID}` || path === '/' ? resolve(root, 'dev/index.html') : allowed ? resolve(root, '.' + path) : '';
    if (!target || !target.startsWith(root + '/')) { response.writeHead(404).end('Not found'); return; }
    const body = await readFile(target);
    response.writeHead(200, { 'Content-Type': contentTypes[extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body);
  } catch { response.writeHead(404).end('Not found'); }
});
server.listen(port, '127.0.0.1', () => console.log(`Local integration harness: http://127.0.0.1:${port}/project/${PROJECT_ID}`));
