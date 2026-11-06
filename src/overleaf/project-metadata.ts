import { requireSameOriginOverleaf } from './origin';

/** Minimal read-only metadata from Overleaf's authenticated project-join event. */
export interface ProjectRootMetadata { rootDocId?: string; rootPath?: string; compiler?: 'pdflatex' | 'xelatex' | 'lualatex'; texLiveVersion?: string }
export interface MetadataSocket {
  on(event: string, callback: (value?: unknown) => void): unknown;
  disconnect(): unknown;
}
export interface ProjectMetadataOptions {
  origin?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  connectSocket?: (origin: string, options: Record<string, unknown>) => MetadataSocket | Promise<MetadataSocket>;
}

const ID = /^[a-f\d]{24}$/i;
const MAX_ENTRIES = 6000;
const MAX_DEPTH = 48;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Overleaf 项目元数据格式无效。');
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error('Overleaf 项目元数据 ID 无效。');
  return value.toLowerCase();
}
function segment(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 255 || value === '.' || value === '..'
    || /[\\/:\u0000-\u001f\u007f]/.test(value)) throw new Error('Overleaf 项目元数据路径无效。');
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Overleaf 项目目录格式无效。');
  return value;
}

/**
 * Public ProjectEditorHandler.buildProjectModelView uses rootDoc_id and one
 * rootFolder. Its docs contain only _id/name: no document text is requested.
 * Do not retain the unrelated member/owner fields in joinProjectResponse.
 */
export function parseProjectRoot(projectId: string, payload: unknown): ProjectRootMetadata {
  const expected = identifier(projectId);
  const project = record(record(payload).project);
  if (identifier(project._id) !== expected) throw new Error('Overleaf 项目元数据与当前项目不匹配。');
  const environment: Pick<ProjectRootMetadata, 'compiler' | 'texLiveVersion'> = {};
  if (['pdflatex', 'xelatex', 'lualatex'].includes(String(project.compiler))) environment.compiler = project.compiler as ProjectRootMetadata['compiler'];
  if (typeof project.imageName === 'string' && project.imageName.length <= 300 && !/[\r\n\0]/.test(project.imageName)) environment.texLiveVersion = project.imageName;
  if (project.rootDoc_id == null) return environment;
  const rootDocId = identifier(project.rootDoc_id);
  const roots = array(project.rootFolder);
  if (roots.length !== 1) throw new Error('Overleaf 项目根目录不唯一。');
  let count = 0;
  let rootPath: string | undefined;
  const paths = new Set<string>();
  const visited = new Set<object>();
  const stack = [{ value: roots[0], prefix: '', depth: 0 }];
  while (stack.length) {
    const item = stack.pop()!;
    const folder = record(item.value);
    if (++count > MAX_ENTRIES || item.depth > MAX_DEPTH || visited.has(folder)) throw new Error('Overleaf 项目目录超过解析限额。');
    visited.add(folder);
    const docs = array(folder.docs), fileRefs = array(folder.fileRefs);
    if (count + docs.length + fileRefs.length > MAX_ENTRIES) throw new Error('Overleaf 项目目录超过解析限额。');
    for (const entry of [...docs, ...fileRefs]) {
      if (++count > MAX_ENTRIES) throw new Error('Overleaf 项目目录超过解析限额。');
      const file = record(entry);
      const path = item.prefix + segment(file.name);
      if (path.length > 2048 || paths.has(path)) throw new Error('Overleaf 项目目录含重复或过长路径。');
      paths.add(path);
      if (identifier(file._id) === rootDocId) {
        if (rootPath !== undefined) throw new Error('Overleaf 主文件 ID 对应多个路径。');
        rootPath = path;
      }
    }
    const children = array(folder.folders);
    if (count + stack.length + children.length > MAX_ENTRIES) throw new Error('Overleaf 项目目录超过解析限额。');
    for (const child of children) {
      const path = item.prefix + segment(record(child).name);
      if (path.length > 2048 || paths.has(path)) throw new Error('Overleaf 项目目录含重复或过长路径。');
      paths.add(path);
      stack.push({ value: child, prefix: path + '/', depth: item.depth + 1 });
    }
  }
  if (!rootPath) throw new Error('Overleaf 主文件不在项目目录中。');
  return { rootDocId, rootPath, ...environment };
}

async function connectSocket(origin: string, options: Record<string, unknown>): Promise<MetadataSocket> {
  // Use the pinned private browser module, not a page-owned global or socket.
  // Its strict-mode binding is handled by scripts/socket-client-plugin.mjs.
  // @ts-expect-error upstream 0.9 browser bundle has no TypeScript declaration
  const module = await import('socket.io-client/dist/socket.io.js');
  const io = module.default ?? module;
  return io.connect(origin, options) as MetadataSocket;
}

/**
 * A short, session-authenticated, forced-new connection. The server auto-joins
 * the project specified in the query. We never emit an application event,
 * join a document, reuse/disconnect the website's socket, or change settings.
 * Normal server join/leave presence activity may still occur.
 */
export async function readProjectRoot(projectId: string, options: ProjectMetadataOptions = {}): Promise<ProjectRootMetadata> {
  const expected = identifier(projectId);
  const origin = requireSameOriginOverleaf(options.origin);
  if (options.signal?.aborted) throw new DOMException('项目元数据读取已取消。', 'AbortError');
  const requestedTimeout = options.timeoutMs ?? 6000;
  const timeoutMs = Number.isFinite(requestedTimeout) ? Math.max(1, Math.min(requestedTimeout, 15_000)) : 6000;
  return new Promise<ProjectRootMetadata>((resolve, reject) => {
    let socket: MetadataSocket | undefined;
    let settled = false;
    const finish = (error?: unknown, result?: ProjectRootMetadata) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      try { socket?.disconnect(); } catch { /* No website socket is involved. */ }
      if (error) reject(error); else resolve(result ?? {});
    };
    const onAbort = () => finish(new DOMException('项目元数据读取已取消。', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('读取 Overleaf 主文件设置超时。')), timeoutMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    void Promise.resolve().then(() => settled ? undefined : (options.connectSocket ?? connectSocket)(origin, {
      'force new connection': true, reconnect: false, transports: ['websocket'],
      'connect timeout': timeoutMs, 'try multiple transports': false,
      query: new URLSearchParams({ projectId: expected }).toString(),
    })).then(value => {
      if (!value) return;
      socket = value;
      if (settled) { try { socket.disconnect(); } catch { /* Late connection. */ } return; }
      const fail = () => finish(new Error('暂时无法读取 Overleaf 主文件设置。'));
      for (const event of ['connectionRejected', 'connect_failed', 'error', 'disconnect']) socket.on(event, fail);
      socket.on('joinProjectResponse', payload => {
        try { finish(undefined, parseProjectRoot(expected, payload)); } catch (error) { finish(error); }
      });
    }).catch(error => finish(error));
  });
}
