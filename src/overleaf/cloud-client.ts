import { normalizeProjectPath } from './project-source';
import { requireSameOriginOverleaf } from './origin';

export type CloudCompiler = 'pdflatex' | 'xelatex' | 'lualatex';
export interface SharedCloudProjectBinding {
  kind: 'shared-v1';
  accountId: string;
  projectId: string;
  name: string;
  rootFolderId?: string;
  compiler?: CloudCompiler;
  /** Overleaf's imageName value, not merely the year printed in the UI. */
  texLiveVersion?: string;
}
export type CloudProjectBinding = SharedCloudProjectBinding;
export type CloudCreationOutcome = 'not-started' | 'uncertain' | 'created' | 'rejected';
export interface CloudProjectFile { path: string; id: string; type: 'doc' | 'file' }
export interface CloudSocket {
  on(event: string, callback: (data?: unknown) => void): unknown;
  disconnect(): unknown;
}
export interface CloudClientOptions {
  accountId?: string;
  /** Cross-tab lease fence, checked immediately before network work. */
  beforeRequest?: () => Promise<void>;
  /** A request may have reached Overleaf despite a missing response. */
  onUncertain?: () => void;
  fetch?: typeof fetch;
  csrfToken?: string | (() => string);
  origin?: string;
  connectSocket?: (origin: string, options: Record<string, unknown>) => CloudSocket | Promise<CloudSocket>;
  socketTimeoutMs?: number;
  /** Check the owning extension lifetime at actual network-work boundaries. */
  isActive?: () => boolean;
}
export interface CloudCompileResult { pdf: Uint8Array; diagnostics: string[] }

const ID = /^[a-f\d]{24}$/i;
const COMPILERS = new Set<CloudCompiler>(['pdflatex', 'xelatex', 'lualatex']);
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_PDF_BYTES = 16 * 1024 * 1024;
const MAX_LOG_BYTES = 256 * 1024;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Overleaf 返回了无法识别的数据。');
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error('Overleaf 返回了无效的项目或文件 ID。');
  return value.toLowerCase();
}
function compiler(value: unknown): CloudCompiler | undefined {
  return typeof value === 'string' && COMPILERS.has(value as CloudCompiler) ? value as CloudCompiler : undefined;
}

/**
 * Static path bundles private CommonJS exports, never website window.io.
 * scripts/socket-client-plugin.mjs explicitly binds this legacy UMD's outer
 * browser global because our enclosing extension bundle runs in strict mode.
 */
async function connectSocket(origin: string, options: Record<string, unknown>, checkActive: () => Promise<void>): Promise<CloudSocket> {
  // The upstream 0.9 browser distribution does not provide TypeScript declarations.
  // @ts-expect-error untyped upstream browser bundle
  const module = await import('socket.io-client/dist/socket.io.js');
  await checkActive();
  const io = module.default ?? module;
  return io.connect(origin, options) as CloudSocket;
}

async function boundedBytes(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new Error('Overleaf 输出超过读取大小上限。');
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) throw new Error('Overleaf 输出超过读取大小上限。');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('Overleaf 输出超过读取大小上限。'); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function readProjectFiles(root: Record<string, unknown>): CloudProjectFile[] {
  const files: CloudProjectFile[] = [];
  const paths = new Set<string>();
  const ids = new Set<string>();
  const visit = (folder: Record<string, unknown>, prefix: string, depth: number) => {
    if (depth > 50 || files.length > 2000) throw new Error('共享预览项目目录超过限制。');
    for (const [field, type] of [['docs', 'doc'], ['fileRefs', 'file']] as const) {
      const entries = folder[field] ?? [];
      if (!Array.isArray(entries)) throw new Error('共享预览项目目录无效。');
      for (const value of entries) {
        const entry = record(value);
        if (typeof entry.name !== 'string' || !entry.name || entry.name.includes('/')) throw new Error('共享预览项目文件名无效。');
        const path = normalizeProjectPath(prefix + entry.name), entityId = id(entry._id);
        if (paths.has(path) || ids.has(entityId)) throw new Error('共享预览项目目录包含重复文件。');
        paths.add(path); ids.add(entityId);
        files.push({ path, id: entityId, type });
        if (files.length > 2000) throw new Error('共享预览项目目录超过限制。');
      }
    }
    const folders = folder.folders ?? [];
    if (!Array.isArray(folders)) throw new Error('共享预览项目目录无效。');
    for (const value of folders) {
      const child = record(value);
      if (typeof child.name !== 'string' || !child.name || child.name.includes('/')) throw new Error('共享预览项目文件夹名无效。');
      const childId = id(child._id);
      if (ids.has(childId)) throw new Error('共享预览项目目录包含重复文件夹。');
      ids.add(childId);
      visit(child, normalizeProjectPath(prefix + child.name) + '/', depth + 1);
    }
  };
  visit(root, '', 0);
  return files;
}

function compileMessage(status: string): string {
  const messages: Record<string, string> = {
    'too-recently-compiled': '编译请求过于频繁，请稍后再次预览。',
    'compile-in-progress': '共享预览项目正在编译，请等待后再次预览。',
    'autocompile-backoff': 'Overleaf 暂时限制了编译频率，请稍后重试。',
    'rate-limited': 'Overleaf 暂时限制了请求频率，请稍后重试。',
    'timedout': '云端 TeX 编译超时。',
    'unavailable': 'Overleaf 编译服务暂时不可用。',
    'stopped-on-first-error': '云端 TeX 编译遇到错误。',
    'failure': '云端 TeX 编译失败。',
    'error': '云端 TeX 编译失败。',
  };
  return messages[status] ?? `云端 TeX 未成功编译（${status.slice(0, 100)}）。`;
}

/**
 * A session-authenticated client whose writes are confined to one extension-created
 * shared project for the current account. Metadata must verify ownership before
 * writes; legacy per-source clone bindings are never adopted.
 * These are Overleaf's internal endpoints and may change independently of this extension.
 */
export class OverleafCloudClient {
  private readonly fetcher: typeof fetch;
  private readonly options: CloudClientOptions;
  private readonly origin: string;
  private binding?: CloudProjectBinding;
  private queue: Promise<unknown> = Promise.resolve();
  private pendingOperations = 0;
  private pendingCompiles = 0;
  private creating = false;
  private createOutcome: CloudCreationOutcome = 'not-started';
  private metadataVerified = false;
  private files: CloudProjectFile[] = [];

  constructor(readonly sourceProjectId: string, options: CloudClientOptions = {}) {
    this.sourceProjectId = id(sourceProjectId);
    this.options = { ...options, accountId: options.accountId ? id(options.accountId) : undefined };
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.origin = requireSameOriginOverleaf(options.origin ?? (typeof location === 'undefined' ? 'https://www.overleaf.com' : undefined));
  }

  getPreviewProject(): CloudProjectBinding | undefined { return this.binding ? { ...this.binding } : undefined; }
  /** Lets the caller clear a creation journal only when a duplicate is impossible. */
  get creationOutcome(): CloudCreationOutcome { return this.createOutcome; }

  restorePreviewProject(binding: CloudProjectBinding): void {
    const projectId = id(binding.projectId);
    const accountId = this.account();
    if (binding.kind !== 'shared-v1' || id(binding.accountId) !== accountId || projectId === this.sourceProjectId) {
      throw new Error('共享预览项目与当前账号的绑定不匹配；已拒绝写入。');
    }
    if (binding.rootFolderId) id(binding.rootFolderId);
    if (this.creating || this.pendingOperations) throw new Error('云端预览正在处理请求，请稍后切换项目。');
    this.binding = { ...binding, accountId, projectId, rootFolderId: binding.rootFolderId ? id(binding.rootFolderId) : undefined };
    this.metadataVerified = false;
    this.files = [];
  }

  private account(): string {
    if (!this.options.accountId) throw new Error('无法确定当前 Overleaf 账号，请刷新页面后重试。');
    return this.options.accountId;
  }

  private target(): CloudProjectBinding {
    if (!this.binding || this.binding.kind !== 'shared-v1' || this.binding.accountId !== this.account() || this.binding.projectId === this.sourceProjectId) {
      throw new Error('请先创建共享预览项目。');
    }
    id(this.binding.projectId);
    return this.binding;
  }

  /** Snapshot from the last verified metadata response, never from page globals. */
  getFiles(): CloudProjectFile[] { return this.files.map(file => ({ ...file })); }

  refreshMetadata(): Promise<void> { this.target(); return this.enqueue(() => this.loadMetadata()); }

  private token(): string {
    const configured = this.options.csrfToken;
    let token = typeof configured === 'function' ? configured() : configured;
    token ??= typeof document === 'undefined' ? undefined : document.querySelector<HTMLMetaElement>('meta[name="ol-csrfToken"]')?.content;
    // Meta attributes may be JSON encoded by Overleaf's template helper.
    if (token?.startsWith('"')) { try { token = JSON.parse(token); } catch { /* reject below if absent */ } }
    if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw new Error('无法读取 Overleaf 登录令牌，请刷新页面后重试。');
    return token;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.pendingOperations++;
    const run = () => { this.ensureActive(); return operation(); };
    const result = this.queue.then(run, run).finally(() => { this.pendingOperations--; });
    this.queue = result.catch(() => undefined);
    return result;
  }

  private ensureActive(): void {
    if (this.options.isActive && !this.options.isActive()) throw new DOMException('预览已取消。', 'AbortError');
  }

  private async networkBoundary(): Promise<void> {
    this.ensureActive();
    await this.options.beforeRequest?.();
    this.ensureActive();
  }

  private async request(path: string, init: RequestInit, timeoutMs = 60_000): Promise<Response> {
    await this.networkBoundary();
    let response: Response;
    try {
      if (path === '/project/new') this.createOutcome = 'uncertain';
      response = await this.fetcher(path, {
        ...init, credentials: 'same-origin', redirect: 'error', cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) { this.options.onUncertain?.(); throw error; }
    if (!response.ok) {
      if (path === '/project/new' && response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 423) this.createOutcome = 'rejected';
      if (init.method !== 'GET' && (response.status >= 500 || response.status === 408 || response.status === 423)) this.options.onUncertain?.();
      const message = response.status === 429 ? 'Overleaf 请求过于频繁，请稍后重试。'
        : response.status === 401 || response.status === 403 ? 'Overleaf 登录已失效或没有共享预览项目的写入权限。'
          : response.status === 423 ? '共享预览项目正在编译，请稍后重试。'
            : `Overleaf 请求失败（HTTP ${response.status}）。`;
      throw new Error(message);
    }
    return response;
  }

  private async json(path: string, body: unknown, timeoutMs?: number): Promise<Record<string, unknown>> {
    const response = await this.request(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': this.token() }, body: JSON.stringify(body),
    }, timeoutMs);
    try { return record(await response.json()); }
    catch { this.options.onUncertain?.(); throw new Error('Overleaf 未返回预期的数据，可能需要重新登录。'); }
  }

  async createPreviewProject(name = 'Overleaf Personal Tools — previews'): Promise<CloudProjectBinding> {
    const accountId = this.account();
    if (this.binding) throw new Error('当前账号已有共享预览项目，请复用现有项目。');
    if (this.creating || this.pendingOperations) throw new Error('已有云端请求正在处理，请稍后重试。');
    if (!name.trim() || name.length > 150) throw new Error('预览项目名称不能为空或超过 150 字符。');
    this.createOutcome = 'not-started';
    this.creating = true;
    try {
      return await this.enqueue(async () => {
        // Official new-project flow: a basic main.tex, never a source-project clone.
        const response = await this.json('/project/new', { projectName: name.trim(), template: 'none' }, 60_000);
        let projectId: string;
        try {
          projectId = id(response.project_id);
          if (projectId === this.sourceProjectId) throw new Error('服务器返回了原项目 ID；已拒绝写入。');
          const ownerId = typeof response.owner_ref === 'string' ? response.owner_ref : record(response.owner)._id;
          if (id(ownerId) !== accountId) throw new Error('新预览项目的所属账号不匹配；已拒绝写入。');
        } catch (error) { this.options.onUncertain?.(); throw error; }
        // Preserve a known creation if its independent metadata read fails; callers
        // persist this binding before retrying instead of creating another project.
        this.binding = { kind: 'shared-v1', accountId, projectId, name: name.trim() };
        this.createOutcome = 'created';
        this.metadataVerified = false;
        await this.loadMetadata();
        return { ...this.target() };
      });
    } finally { this.creating = false; }
  }

  private async loadMetadata(): Promise<void> {
    this.ensureActive();
    const target = this.target();
    this.metadataVerified = false;
    const options = {
      'force new connection': true, reconnect: false, transports: ['websocket'],
      'connect timeout': this.options.socketTimeoutMs ?? 20_000,
      'try multiple transports': false, query: new URLSearchParams({ projectId: target.projectId }).toString(),
    };
    await this.networkBoundary();
    const socket = await (this.options.connectSocket
      ? this.options.connectSocket(this.origin, options)
      : connectSocket(this.origin, options, () => this.networkBoundary()));
    try {
      // Install join listeners immediately: awaiting a lease round trip here can
      // miss the server's initial joinProjectResponse. Fence again after receipt.
      this.ensureActive();
      const project = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('无法读取共享预览项目目录，请稍后重试；已创建的副本会保留。')), this.options.socketTimeoutMs ?? 20_000);
        const fail = () => { clearTimeout(timeout); reject(new Error('无法连接共享预览项目，请确认已登录。')); };
        for (const event of ['connectionRejected', 'connect_failed', 'error', 'disconnect']) socket.on(event, fail);
        socket.on('joinProjectResponse', value => {
          clearTimeout(timeout);
          try { resolve(record(record(value).project)); } catch (error) { reject(error); }
        });
      });
      await this.networkBoundary();
      if (id(project._id) !== target.projectId) throw new Error('Overleaf 返回的项目与共享预览项目不匹配。');
      if (id(record(project.owner)._id) !== this.account()) throw new Error('共享预览项目的所有者与当前账号不匹配；已拒绝写入。');
      if (!Array.isArray(project.rootFolder) || !project.rootFolder.length) throw new Error('共享预览项目目录不可用。');
      target.rootFolderId = id(record(project.rootFolder[0])._id);
      target.compiler = compiler(project.compiler);
      target.texLiveVersion = typeof project.imageName === 'string' ? project.imageName : undefined;
      this.files = readProjectFiles(record(project.rootFolder[0]));
      this.metadataVerified = true;
    } finally { socket.disconnect(); }
  }

  uploadText(path: string, content: string): Promise<{ id: string; type: 'doc' | 'file' }> {
    this.target();
    const normalized = normalizeProjectPath(path);
    if (!normalized || !/\.(?:tex|sty|cls|ltx|def|cfg|clo|tikz|bib|txt|bbx|cbx|lbx|bst|fd|enc|map)$/i.test(normalized)) throw new Error('云端预览只同步 TeX 文本文件。');
    const name = normalized.split('/').pop()!;
    if (name.length > 150 || content.includes('\0')) throw new Error('无效的预览文件。');
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    if (blob.size > MAX_TEXT_BYTES) throw new Error('预览源文件超过 2 MiB 上限。');
    return this.enqueue(async () => {
      const target = this.target();
      if (!this.metadataVerified) await this.loadMetadata();
      const form = new FormData();
      form.append('qqfile', blob, name);
      form.append('name', name);
      if (normalized.includes('/')) form.append('relativePath', normalized);
      const response = await this.request(`/project/${target.projectId}/upload?folder_id=${id(target.rootFolderId)}`, {
        method: 'POST', headers: { 'X-CSRF-TOKEN': this.token() }, body: form,
      });
      let data: Record<string, unknown>;
      try { data = record(await response.json()); } catch { this.options.onUncertain?.(); throw new Error('Overleaf 上传响应无效。'); }
      if (data.success !== true || (data.entity_type !== 'doc' && data.entity_type !== 'file')) throw new Error('Overleaf 未确认预览文件上传成功。');
      const uploaded: CloudProjectFile = { path: normalized, id: id(data.entity_id), type: data.entity_type };
      this.files = this.files.filter(file => file.path !== normalized);
      this.files.push(uploaded);
      return { id: uploaded.id, type: uploaded.type };
    });
  }

  /** Only recorded extension-owned entities can be removed. Unknown files are retained. */
  removeManagedFiles(managed: readonly CloudProjectFile[]): Promise<void> {
    this.target();
    const candidates = managed.map(file => {
      if (file.type !== 'doc' && file.type !== 'file') throw new Error('无效的预览文件类型。');
      return { path: normalizeProjectPath(file.path), id: id(file.id), type: file.type };
    });
    return this.enqueue(async () => {
      const target = this.target();
      if (!this.metadataVerified) await this.loadMetadata();
      // Validate the whole deletion set before deleting anything. A replaced path
      // may now be a user's file, so do not infer ownership from its name alone.
      const existing = candidates.filter(candidate => {
        const current = this.files.find(file => file.path === candidate.path);
        if (!current) return false;
        if (current.id !== candidate.id || current.type !== candidate.type) throw new Error('预览文件已被替换，已停止清理：' + candidate.path);
        return true;
      });
      for (const file of existing) {
        await this.request(`/project/${target.projectId}/${file.type}/${file.id}`, {
          method: 'DELETE', headers: { 'X-CSRF-TOKEN': this.token() },
        });
        this.files = this.files.filter(current => current.id !== file.id);
      }
    });
  }

  setCompiler(value: CloudCompiler, texLiveVersion?: string): Promise<void> {
    this.target();
    if (!compiler(value)) throw new Error('不支持的 TeX 编译器。');
    if (texLiveVersion !== undefined && (!texLiveVersion || texLiveVersion.length > 300 || /[\r\n\0]/.test(texLiveVersion))) throw new Error('无效的 TeX Live 版本。');
    return this.enqueue(async () => {
      const target = this.target();
      if (!this.metadataVerified) await this.loadMetadata();
      await this.request(`/project/${target.projectId}/settings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': this.token() },
        body: JSON.stringify({ compiler: value, ...(texLiveVersion ? { imageName: texLiveVersion } : {}) }),
      });
      target.compiler = value;
      if (texLiveVersion) target.texLiveVersion = texLiveVersion;
    });
  }

  compile(rootDocId: string, rootResourcePath: string): Promise<CloudCompileResult> {
    this.target(); id(rootDocId);
    const path = normalizeProjectPath(rootResourcePath);
    if (!/\.(?:tex|ltx)$/i.test(path)) throw new Error('预览入口必须是 TeX 文件。');
    if (this.pendingCompiles) return Promise.reject(new Error('云端预览正在排队或编译，请等待当前请求完成。'));
    this.pendingCompiles++;
    return this.enqueue(async () => {
      const target = this.target();
      if (!this.metadataVerified) await this.loadMetadata();
      const editorId = crypto.randomUUID();
      const response = await this.json(`/project/${target.projectId}/compile`, {
        rootDoc_id: rootDocId, rootResourcePath: path, check: 'silent',
        stopOnFirstError: true, incrementalCompilesEnabled: false, editorId,
      }, 300_000);
      const status = typeof response.status === 'string' ? response.status : 'unknown';
      if (['compile-in-progress', 'timedout', 'unknown'].includes(status)) this.options.onUncertain?.();
      const files = Array.isArray(response.outputFiles) ? response.outputFiles.filter(file => file && typeof file === 'object') as Record<string, unknown>[] : [];
      const diagnostics: string[] = [];
      const params = new URLSearchParams({ editorId });
      if (typeof response.clsiServerId === 'string' && response.clsiServerId.length < 200) params.set('clsiserverid', response.clsiServerId);
      const build = (file: Record<string, unknown>): string => {
        if (typeof file.build !== 'string' || !/^[a-zA-Z\d_-]{1,100}$/.test(file.build)) throw new Error('Overleaf 未返回有效的编译版本。');
        return file.build;
      };
      const log = files.find(file => file.path === 'output.log');
      if (log) {
        try {
          const logResponse = await this.request(`/project/${target.projectId}/build/${build(log)}/output/output.log?${params}`, { method: 'GET' });
          const text = new TextDecoder().decode(await boundedBytes(logResponse, MAX_LOG_BYTES));
          for (const line of text.split(/\r?\n/)) {
            if (/^!|LaTeX (?:Warning|Error):|Package .+ (?:Warning|Error):|Undefined control sequence|Emergency stop|Fatal error/.test(line)) diagnostics.push(line.trim().slice(0, 500));
            if (diagnostics.length >= 12) break;
          }
        } catch(error) {
          if(error instanceof DOMException && error.name==='AbortError')throw error;
          diagnostics.push('未能读取编译日志。');
        }
      }
      if (status !== 'success') throw new Error([compileMessage(status), ...diagnostics].join('\n'));
      const pdf = files.find(file => file.path === 'output.pdf');
      if (!pdf) throw new Error(['Overleaf 没有生成预览 PDF。', ...diagnostics].join('\n'));
      const pdfResponse = await this.request(`/download/project/${target.projectId}/build/${build(pdf)}/output/output.pdf?${params}`, { method: 'GET' });
      const bytes = await boundedBytes(pdfResponse, MAX_PDF_BYTES);
      if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') throw new Error('Overleaf 返回的内容不是 PDF，可能需要重新登录。');
      return { pdf: bytes, diagnostics };
    }).finally(() => { this.pendingCompiles--; });
  }
}
