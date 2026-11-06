import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { createContext, runInContext } from 'node:vm';
import { readFile } from 'node:fs/promises';
// @ts-expect-error The build plugin is intentionally a plain Node ESM module.
import { bindLegacySocketBrowserGlobal, socketClientBrowserGlobalPlugin } from '../scripts/socket-client-plugin.mjs';

const entry = `
  import io from 'socket.io-client/dist/socket.io.js';
  const socket = io.connect('https://www.overleaf.com', {
    'force new connection': true, 'auto connect': false, reconnect: false,
    transports: ['websocket'], query: 'projectId=1123456789abcdef01234567'
  });
  globalThis.socketBundleResult = {
    documentMatches: socket.socket.options.document === document,
    sameOrigin: !socket.socket.isXDomain(),
    webSocketAvailable: io.Transport.websocket.check(),
    query: socket.socket.options.query,
    cached: Object.keys(io.sockets).length,
  };
  socket.disconnect();
`;

async function bundle(patched: boolean): Promise<string> {
  const result = await build({
    stdin: { contents: entry, resolveDir: process.cwd(), sourcefile: 'socket-browser-regression.ts', loader: 'ts' },
    bundle: true, platform: 'browser', format: 'iife', target: 'chrome145', minify: true,
    banner: { js: '"use strict";' }, write: false,
    plugins: patched ? [socketClientBrowserGlobalPlugin] : [],
  });
  return result.outputFiles[0].text;
}

function browserContext() {
  const sentinel = Object.freeze({ belongsToWebsite: true });
  const location = new URL('https://www.overleaf.com/project/0123456789abcdef01234567');
  const globals: Record<string, unknown> = {
    location, document: { domain: location.hostname, location, readyState: 'complete' },
    navigator: { userAgent: 'Chrome' }, WebSocket: class {},
    setTimeout, clearTimeout,
  };
  globals.window = globals;
  Object.defineProperty(globals, 'io', { value: sentinel, writable: false, enumerable: true });
  return { context: createContext(globals), sentinel };
}

describe('pinned socket.io browser bundle', () => {
  it('reproduces the strict-wrapper failure without the compatibility transform', async () => {
    const source = await bundle(false);
    expect(() => runInContext(source, browserContext().context)).toThrow(/document|undefined/);
  });

  it('constructs the real bundled browser client with isolated global context and no website io mutation', async () => {
    const { context, sentinel } = browserContext();
    runInContext(await bundle(true), context);
    expect(context.socketBundleResult).toEqual({
      documentMatches: true, sameOrigin: true, webSocketAvailable: true,
      query: 'projectId=1123456789abcdef01234567', cached: 0,
    });
    expect(context.io).toBe(sentinel);
  });

  it('fails closed when the pinned vendor version or outer wrapper changes', async () => {
    const source = await readFile('node_modules/socket.io-client/dist/socket.io.js', 'utf8');
    expect(() => bindLegacySocketBrowserGlobal(source.replace('0.9.17-overleaf-6', '0.9.18'))).toThrow('wrapper changed');
    expect(() => bindLegacySocketBrowserGlobal(source + '\notherCode();')).toThrow('wrapper changed');
    expect(() => bindLegacySocketBrowserGlobal(source.replace('(function() {', '(function changed() {'))).toThrow('wrapper changed');
  });
});
