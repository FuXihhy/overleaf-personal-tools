import { unzipSync } from 'fflate';
import type { ProjectFile } from '../core/types';
import { readProjectRoot, type ProjectRootMetadata } from './project-metadata';

/** Only text sources are retained. Images/PDFs in the source ZIP are never inflated. */
const SOURCE_EXTENSION = /\.(?:tex|sty|cls|ltx|def|cfg|clo|tikz|bib|txt|bbx|cbx|lbx|bst|fd|enc|map)$/i;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_FILES = 2000;

export interface ProjectDiscovery {
  files: ProjectFile[];
  /** Empty when a user selection is necessary. Never guesses among multiple roots. */
  rootPath: string;
  rootCandidates: string[];
  name?: string;
}

export interface FullProjectCapture {
  rootPath: string;
  files: Array<{ path: string; content: string }>;
}

export interface ProjectSourceOptions {
  fetch?: typeof fetch;
  rootPath?: string;
  name?: string;
  maxArchiveBytes?: number;
  /** Injection seam for synthetic metadata fixtures; never requires project text. */
  readMetadata?: (projectId: string, signal: AbortSignal) => Promise<ProjectRootMetadata | undefined>;
}

export function normalizeProjectPath(value: string): string {
  if (!value || value.includes('\0') || value.includes('\\') || value.startsWith('/')) {
    throw new Error('Invalid project path');
  }
  const parts = value.split('/');
  if (parts.some(part => part === '..') || /^[a-zA-Z]:/.test(value)) {
    throw new Error('Project path must remain inside the project');
  }
  return parts.filter(part => part !== '.' && part !== '').join('/');
}

/** Bounded decoding happens after the ZIP filter has checked uncompressed sizes. */
export function decodeProjectArchive(bytes: Uint8Array): Map<string, string> {
  let sourceBytes = 0;
  let sourceCount = 0;
  const extracted = unzipSync(bytes, {
    filter(file) {
      if (file.name.endsWith('/') || !SOURCE_EXTENSION.test(file.name)) return false;
      normalizeProjectPath(file.name);
      sourceCount++;
      sourceBytes += file.originalSize;
      if (sourceCount > MAX_SOURCE_FILES || file.originalSize > MAX_FILE_BYTES || sourceBytes > MAX_TOTAL_SOURCE_BYTES) {
        throw new Error('项目源码过大，已停止解析。请精简项目或联系维护者调整限额。');
      }
      return true;
    },
  });
  const sources = new Map<string, string>();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (const [rawPath, content] of Object.entries(extracted)) {
    const path = normalizeProjectPath(rawPath);
    if (sources.has(path)) throw new Error(`ZIP 中有重复路径：${path}`);
    let text: string;
    try { text = decoder.decode(content); }
    catch { throw new Error(`文件不是有效的 UTF-8 文本：${path}`); }
    if (text.includes('\0')) throw new Error(`文件包含二进制内容：${path}`);
    sources.set(path, text);
  }
  return sources;
}

function withoutComments(text: string): string {
  return text.split('\n').map(line => {
    for (let i = 0; i < line.length; i++) {
      if (line[i] !== '%') continue;
      let slashes = 0;
      for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) slashes++;
      if (slashes % 2 === 0) return line.slice(0, i);
    }
    return line;
  }).join('\n');
}

export function findRootCandidates(sources: ReadonlyMap<string, string>): string[] {
  return [...sources].filter(([path, text]) => /\.(?:tex|ltx)$/i.test(path) && /\\documentclass\s*(?:\[[^\]]*\]\s*)?\{/.test(withoutComments(text)))
    .map(([path]) => path).sort((a, b) => a.localeCompare(b));
}

async function readBoundedBody(response: Response, limit: number): Promise<Uint8Array> {
  const size = Number(response.headers.get('content-length'));
  if (Number.isFinite(size) && size > limit) throw new Error('项目 ZIP 超过 32 MiB 读取上限。');
  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > limit) throw new Error('项目 ZIP 超过读取上限。');
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new Error('项目 ZIP 超过读取上限。');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

/**
 * Read-only project source adapter. It uses the source-export endpoint already
 * exposed by Overleaf. A short independent project-metadata connection obtains
 * the actual main-document setting, without joining/editing any document.
 * Archive bytes and source text stay in tab memory; nothing is persisted here.
 * invalidate() is for explicit refresh; keystrokes should use setLiveDocument().
 */
export class OverleafProjectSource {
  private readonly fetcher: typeof fetch;
  private readonly options: ProjectSourceOptions;
  private sources?: Map<string, string>;
  private pending?: Promise<Map<string, string>>;
  private readonly live = new Map<string, string>();
  private rootMetadata?: ProjectRootMetadata;
  private metadataRead = false;
  private metadataPending?: Promise<ProjectRootMetadata | undefined>;
  private metadataAbort?: AbortController;
  private metadataRevision = 0;
  private observedNativeRootPath?: string;
  private rootOverride?: string;
  private generation = 0;

  constructor(readonly projectId: string, options: ProjectSourceOptions = {}) {
    if (!/^[a-f\d]{24}$/i.test(projectId)) throw new Error('Invalid Overleaf project ID');
    this.options = options;
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.rootOverride = options.rootPath;
  }

  setRootPath(path?: string): void {
    this.rootOverride = path ? normalizeProjectPath(path) : undefined;
  }

  /**
   * Capture a native selection synchronously, before React unmounts its select.
   * This is observed project metadata, not an extension rootFile override.
   */
  observeNativeRoot(path: string): boolean {
    let normalized: string;
    try { normalized = normalizeProjectPath(path); } catch { return false; }
    if (!this.sources?.has(normalized)) return false;
    this.observedNativeRootPath = normalized;
    this.rememberNativeRoot(normalized);
    return true;
  }

  private rememberNativeRoot(path: string): void {
    const changed = !this.metadataRead || this.rootMetadata?.rootPath !== path;
    this.rootMetadata = { rootPath: path };
    this.metadataRead = true;
    if (changed) {
      this.metadataRevision++;
      this.metadataAbort?.abort();
    }
  }

  /** Call only with an unambiguous full project path supplied by the editor bridge. */
  setLiveDocument(path: string, content: string): void {
    const normalized = normalizeProjectPath(path);
    if (!SOURCE_EXTENSION.test(normalized)) return;
    if (content.length > MAX_FILE_BYTES) throw new Error('编辑中的源文件过大。');
    this.live.set(normalized, content);
  }

  /** Clears stale archive and buffer snapshots, for explicit refresh / rename. */
  invalidate(): void {
    this.generation++;
    this.sources = undefined;
    this.pending = undefined;
    this.live.clear();
    this.metadataAbort?.abort();
    this.metadataAbort = undefined;
    this.metadataPending = undefined;
    this.rootMetadata = undefined;
    this.metadataRead = false;
    this.metadataRevision++;
    this.observedNativeRootPath = undefined;
  }

  private async metadata(): Promise<ProjectRootMetadata | undefined> {
    if (this.metadataRead) return this.rootMetadata;
    if (this.metadataPending) return this.metadataPending;
    const generation = this.generation;
    const revision = this.metadataRevision;
    const controller = new AbortController();
    this.metadataAbort = controller;
    const promise = (async () => {
      let metadata: ProjectRootMetadata | undefined;
      try {
        metadata = await (this.options.readMetadata ?? ((projectId, signal) => readProjectRoot(projectId, { signal })))(this.projectId, controller.signal);
      } catch { /* Metadata failure preserves the existing safe root heuristic. */ }
      if (generation !== this.generation) throw new Error('项目已刷新，请重新读取。');
      // A native selection made after this request started is newer evidence.
      // Do not overwrite it even if an old socket response arrives after close.
      if (revision !== this.metadataRevision) return this.rootMetadata;
      this.rootMetadata = metadata;
      this.metadataRead = true;
      return metadata;
    })();
    this.metadataPending = promise;
    try { return await promise; }
    finally { if (this.metadataPending === promise) { this.metadataPending = undefined; this.metadataAbort = undefined; } }
  }

  private async snapshot(): Promise<Map<string, string>> {
    if (this.sources) return this.sources;
    if (this.pending) return this.pending;
    const generation = this.generation;
    const promise = (async () => {
      const response = await this.fetcher(`/project/${this.projectId}/download/zip`, {
        method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        signal: AbortSignal.timeout(45_000),
      });
      if (!response.ok) throw new Error(`无法读取项目源码（HTTP ${response.status}）。请确认已登录并具有项目读取权限。`);
      const contentType = response.headers.get('content-type') ?? '';
      if (/text\/html|application\/json/i.test(contentType)) throw new Error('Overleaf 未返回项目 ZIP，可能需要重新登录。');
      const bytes = await readBoundedBody(response, this.options.maxArchiveBytes ?? MAX_ARCHIVE_BYTES);
      const sources = decodeProjectArchive(bytes);
      if (generation !== this.generation) throw new Error('项目已刷新，请重新读取。');
      this.sources = sources;
      return sources;
    })();
    this.pending = promise;
    try { return await promise; }
    finally { if (this.pending === promise) this.pending = undefined; }
  }

  async discover(): Promise<ProjectDiscovery> {
    const sources = new Map(await this.snapshot());
    for (const [path, text] of this.live) if (sources.has(path)) sources.set(path, text);
    const files = [...sources.keys()].sort((a, b) => a.localeCompare(b))
      .map(path => ({ id: `zip:${path}`, path, kind: 'doc' as const }));
    const rootCandidates = findRootCandidates(sources);
    let rootPath = rootCandidates.length === 1 ? rootCandidates[0] : '';
    // Overleaf mounts this control only while its settings dialog is open.
    // Reading the selection is more authoritative than our content heuristic;
    // never open the dialog or change its value on the user's behalf here.
    const selectedRoot = () => typeof document === 'undefined' ? undefined
      : document.querySelector<HTMLSelectElement>('select#rootDocId')?.selectedOptions[0]?.textContent?.trim();
    // React may briefly restore the previous value while saving a controlled
    // select. A captured user change remains newer than that transient DOM.
    let nativeRoot = this.observedNativeRootPath ?? selectedRoot();
    if (!this.rootOverride && !(nativeRoot && sources.has(nativeRoot))) {
      const metadata = await this.metadata();
      if (metadata?.rootPath && sources.has(metadata.rootPath)) rootPath = metadata.rootPath;
      // The user may have opened/changed native settings while metadata loaded.
      nativeRoot = this.observedNativeRootPath ?? selectedRoot();
    }
    if (nativeRoot && sources.has(nativeRoot)) {
      rootPath = nativeRoot;
      this.rememberNativeRoot(nativeRoot);
    }
    if (this.rootOverride) {
      const path = normalizeProjectPath(this.rootOverride);
      if (!sources.has(path)) throw new Error(`指定的主文件不存在：${path}`);
      rootPath = path;
    }
    const name = this.options.name ?? (typeof document === 'undefined' ? undefined
      : document.querySelector<HTMLMetaElement>('meta[name="ol-projectName"]')?.content);
    return { files, rootPath, rootCandidates, name };
  }

  async readFile(file: ProjectFile): Promise<string> {
    const path = normalizeProjectPath(file.path);
    const sources = await this.snapshot();
    if (!sources.has(path)) throw new Error(`项目中没有文件：${path}`);
    return this.live.get(path) ?? sources.get(path)!;
  }

  /** Independent fresh export for an assistant turn. It must not invalidate the
   * editor/preview cache or overlay stale, previously opened files over a newer
   * collaborative export. The caller freezes only current editor buffers. */
  async captureFull(options: { liveDocuments?: ReadonlyMap<string, string>; signal?: AbortSignal } = {}): Promise<FullProjectCapture> {
    options.signal?.throwIfAborted();
    const live = new Map(options.liveDocuments ?? []);
    const fresh = new OverleafProjectSource(this.projectId, {
      ...this.options,
      rootPath: this.rootOverride,
      readMetadata: () => this.metadata(),
      fetch: (input, init) => this.fetcher(input, { ...init, signal: options.signal ? AbortSignal.any([options.signal, init?.signal ?? AbortSignal.timeout(45_000)]) : init?.signal }),
    });
    for (const [path, content] of live) fresh.setLiveDocument(path, content);
    const project = await fresh.discover();
    options.signal?.throwIfAborted();
    const paths = new Set(project.files.map(file => file.path));
    for (const path of live.keys()) if (!paths.has(path)) throw new Error(`The active source file is not present in the fresh project export: ${path}`);
    const files = await Promise.all(project.files.map(async file => ({ path: file.path, content: await fresh.readFile(file) })));
    options.signal?.throwIfAborted();
    return { rootPath: project.rootPath, files };
  }
}
