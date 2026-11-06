import { readFile } from 'node:fs/promises';

const VERSION_HEADER = '/*! Socket.IO.js build:0.9.17-overleaf-6, development.';

/**
 * The pinned browser distribution predates strict-mode bundles. Its outer IIFE
 * passes its own `this` to all browser modules; an ordinary call makes that
 * undefined inside our strict bundle. Bind only that outer call, preserving the
 * package's private CommonJS exports and every method's ordinary `this`.
 * This is a build-time source transform: no eval, Function, window.io or CDN.
 */
export function bindLegacySocketBrowserGlobal(source) {
  const outerOpenings = source.match(/\n\(function\(\) \{/g) ?? [];
  const outerClosing = /\n\}\)\(\);\s*$/;
  if (!source.startsWith(VERSION_HEADER) || outerOpenings.length !== 1 || !outerClosing.test(source)) {
    throw new Error('Pinned socket.io browser wrapper changed; review its global binding before building.');
  }
  return source.replace(outerClosing, '\n}).call(globalThis);\n');
}

export const socketClientBrowserGlobalPlugin = {
  name: 'pinned-socket-browser-global',
  setup(build) {
    build.onLoad({ filter: /[/\\]socket\.io-client[/\\]dist[/\\]socket\.io\.js$/ }, async args => ({
      contents: bindLegacySocketBrowserGlobal(await readFile(args.path, 'utf8')),
      loader: 'js',
    }));
  },
};
