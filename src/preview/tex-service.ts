import type { Settings, ProjectFile } from '../core/types';
import { OverleafCloudClient, type CloudProjectBinding, type CloudCompiler } from '../overleaf/cloud-client';
import { readOverleafAccount } from '../overleaf/account';
import { readProjectRoot } from '../overleaf/project-metadata';
import { buildCloudDocument } from './cloud-document';
import { renderLocalTex } from './local-client';
import { readSharedCloudState, withSharedCloudLock, type SharedCloudSession, type SharedCloudState, type SharedCloudFile } from './cloud-coordinator';

export interface TexPreviewInput {
  files: ProjectFile[];
  rootPath: string;
  readFile(file: ProjectFile): Promise<string>;
  settings: Settings;
  formula: string;
  display: boolean;
  isCurrent(): boolean;
}
export interface TexPreviewResult { pdf: Uint8Array; diagnostics: string[] }
interface Environment { compiler: CloudCompiler; texLiveVersion: string }
export interface TexServiceOptions {
  accountId?: string;
  readState?: typeof readSharedCloudState;
  withLock?: typeof withSharedCloudLock;
  readEnvironment?: () => Promise<Environment>;
}
const PREVIEW_NAME = 'Overleaf Personal Tools — Preview';
const canceled = () => new DOMException('公式已改变。', 'AbortError');
async function digest(text: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), n => n.toString(16).padStart(2, '0')).join('');
}

/** Account-wide scratch workspace orchestration. HTTP stays on the logged-in tab;
 * the extension coordinator serializes the complete transaction across tabs. */
export class TexPreviewService {
  readonly cloud: OverleafCloudClient;
  private session?: SharedCloudSession;
  private operationCurrent?: () => boolean;
  private busy = false;
  private forceUpload = false;
  private nextCloudCompile = 0;
  private readonly accountId?: string;
  private readonly readState: typeof readSharedCloudState;
  private readonly withLock: typeof withSharedCloudLock;
  private environment?: { value: Environment; expiresAt: number };
  private pdfCache = new Map<string, TexPreviewResult>();

  constructor(private readonly projectId: string, cloud?: OverleafCloudClient, private readonly isActive: () => boolean = () => true, private readonly options: TexServiceOptions = {}) {
    this.accountId = options.accountId ?? (typeof document === 'undefined' ? undefined : readOverleafAccount());
    this.readState = options.readState ?? readSharedCloudState;
    this.withLock = options.withLock ?? withSharedCloudLock;
    this.cloud = cloud ?? new OverleafCloudClient(projectId, {
      accountId: this.accountId,
      isActive: () => isActive() && Boolean(this.session?.alive()) && (!this.operationCurrent || this.operationCurrent()),
      beforeRequest: async () => { if (!this.session) throw canceled(); await this.session.checkpoint(); },
      onUncertain: () => this.session?.quarantine(),
    });
  }
  private account(): string {
    if (!this.accountId) throw new Error('无法识别当前 Overleaf 账号，请登录并刷新页面后使用云端预览。');
    return this.accountId;
  }
  async loadSharedBinding(): Promise<void> {
    if (!this.accountId) return;
    const state = await this.readState(this.accountId);
    if (!this.isActive()) return;
    if (state.binding) this.cloud.restorePreviewProject(state.binding);
    this.nextCloudCompile = state.nextCompileAt ?? 0;
  }
  invalidate() { this.forceUpload = true; this.environment = undefined; this.pdfCache.clear(); }
  invalidateEnvironment() { this.environment = undefined; this.pdfCache.clear(); }
  get cooldownRemainingMs() { return Math.max(0, this.nextCloudCompile - Date.now()); }

  /** Explicit first-use action; repeated clicks and other tabs reuse the account binding. */
  async prepareSharedProject(): Promise<CloudProjectBinding> {
    if (this.busy) throw new Error('预览正在编译，请等待当前请求结束。');
    this.busy = true;
    try {
      return await this.withLock(this.account(), this.isActive, async session => {
        this.session = session;
        try {
          if (session.state.binding) {
            this.cloud.restorePreviewProject(session.state.binding);
            await this.cloud.refreshMetadata();
          } else {
            if (session.state.creationPending) throw new Error('上次创建共享预览项目的结果尚未确认；请先检查 Overleaf 项目列表，扩展不会自动重复创建。');
            await session.saveState({ ...session.state, creationPending: { name: PREVIEW_NAME, startedAt: Date.now() } });
            try { await this.cloud.createPreviewProject(PREVIEW_NAME); }
            finally {
              const binding = this.cloud.getPreviewProject();
              if (binding && session.alive()) await session.saveState({ ...session.state, binding, creationPending: undefined });
              else if (session.alive() && ['not-started', 'rejected'].includes(this.cloud.creationOutcome)) {
                await session.saveState({ ...session.state, creationPending: undefined });
              }
            }
          }
          await this.reconcile(session);
          const binding = this.cloud.getPreviewProject()!;
          await session.saveState({ ...session.state, binding });
          return binding;
        } finally { this.session = undefined; }
      });
    } finally { this.busy = false; }
  }

  /** Reconcile only journaled uploads and previously owned file identities. An
   * unrecognized file could shadow an installed package, so stop before writes. */
  private async reconcile(session: SharedCloudSession): Promise<void> {
    const remote = this.cloud.getFiles();
    let workspace = session.state.workspace;
    if (!workspace) {
      if (remote.some(file => file.path !== 'main.tex')) throw new Error('共享预览项目含未登记的文件，请勿把它作为普通论文项目编辑。');
      workspace = { sourceProjectId: this.projectId, files: remote.map(file => ({ ...file, digest: '' })), dirty: true };
    }
    const pending = new Set(workspace.pendingPaths ?? []);
    const owned = new Map(workspace.files.map(file => [file.path, file]));
    const files: SharedCloudFile[] = [];
    for (const file of remote) {
      const prior = owned.get(file.path);
      if (pending.has(file.path)) files.push({ ...file, digest: '' });
      else if (prior && prior.id === file.id && prior.type === file.type) files.push(prior);
      else throw new Error('共享预览项目中的文件未经扩展登记或已被替换，已停止同步：' + file.path);
    }
    await session.saveState({ ...session.state, binding: this.cloud.getPreviewProject(), workspace: { ...workspace, files, pendingPaths: [] } });
  }
  private async sourceEnvironment(): Promise<Environment> {
    if (this.environment && this.environment.expiresAt > Date.now()) return this.environment.value;
    const value = await (this.options.readEnvironment ?? (async () => {
      const metadata = await readProjectRoot(this.projectId);
      if (!metadata.compiler || !metadata.texLiveVersion) throw new Error('无法读取原项目的编译器或 TeX Live 版本，请刷新项目后重试。');
      return { compiler: metadata.compiler, texLiveVersion: metadata.texLiveVersion };
    }))();
    this.environment = { value, expiresAt: Date.now() + 15_000 };
    return value;
  }
  private remember(key: string, value: TexPreviewResult) {
    this.pdfCache.delete(key);this.pdfCache.set(key, value);
    let bytes = [...this.pdfCache.values()].reduce((sum, entry) => sum + entry.pdf.byteLength, 0);
    while (this.pdfCache.size > 12 || bytes > 16 * 1024 * 1024) {
      const first = this.pdfCache.keys().next().value!;
      bytes -= this.pdfCache.get(first)!.pdf.byteLength;this.pdfCache.delete(first);
    }
  }

  async render(input: TexPreviewInput): Promise<TexPreviewResult> {
    if (this.busy) throw new Error('预览正在编译，请等待当前请求结束。');
    const ensureCurrent = () => { if (!this.isActive() || !input.isCurrent()) throw canceled(); };
    this.busy = true;
    try {
      ensureCurrent();
      if (!input.rootPath) throw new Error('无法确定项目主文件，请检查 Overleaf 的主文件设置。');
      if (input.settings.texBackend === 'overleaf') this.account();
      const document = await buildCloudDocument(input);
      ensureCurrent();
      if (input.settings.texBackend === 'local') {
        const result = await renderLocalTex({ version: 1, op: 'render', id: crypto.randomUUID(), compiler: input.settings.texCompiler, document });
        ensureCurrent();
        if (!result.pdfBase64) throw new Error(result.diagnostics.join('\n') || '本机 TeX 未生成 PDF。');
        if (result.pdfBase64.length > 1_000_000) throw new Error('本机 TeX 返回的 PDF 超过限制。');
        const raw = atob(result.pdfBase64);
        return { pdf: Uint8Array.from(raw, char => char.charCodeAt(0)), diagnostics: [...new Set([...document.diagnostics, ...result.diagnostics])] };
      }
      const environment = await this.sourceEnvironment();
      const hashes = new Map<string, string>();
      for (const file of document.files) { hashes.set(file.path, await digest(file.content));ensureCurrent(); }
      const cacheKey = JSON.stringify([this.projectId, environment, [...hashes], document.entryPath]);
      const cached = this.pdfCache.get(cacheKey);
      if (cached) { this.remember(cacheKey, cached);return cached; }
      return await this.withLock(this.account(), () => this.isActive() && input.isCurrent(), async session => {
        this.session = session;this.operationCurrent = input.isCurrent;
        let attempted = false;
        try {
          ensureCurrent();
          if (!session.state.binding) throw new Error('请先在 Extension 设置中启用共享云端预览项目。');
          this.cloud.restorePreviewProject(session.state.binding);
          this.nextCloudCompile = session.state.nextCompileAt ?? 0;
          while (Date.now() < this.nextCloudCompile) {
            ensureCurrent();await new Promise(resolve => setTimeout(resolve, Math.min(250, this.nextCloudCompile - Date.now())));
          }
          ensureCurrent();
          await this.cloud.refreshMetadata();
          await this.reconcile(session);
          const previous = session.state.workspace!;
          const force = this.forceUpload || previous.dirty;
          let files = [...previous.files];
          const saveWorkspace = async (extra: Partial<NonNullable<SharedCloudState['workspace']>> = {}) => session.saveState({ ...session.state,
            binding: this.cloud.getPreviewProject(), workspace: { sourceProjectId: this.projectId, files, dirty: true, compiler: environment.compiler, texLiveVersion: environment.texLiveVersion, ...extra } });
          await saveWorkspace();
          const obsolete = files.filter(file => !hashes.has(file.path));
          if (obsolete.length) {
            ensureCurrent();attempted = true;
            await this.cloud.removeManagedFiles(obsolete);
            files = files.filter(file => hashes.has(file.path));await saveWorkspace();
          }
          ensureCurrent();
          const binding = this.cloud.getPreviewProject()!;
          if (binding.compiler !== environment.compiler || binding.texLiveVersion !== environment.texLiveVersion) {
            attempted = true;await this.cloud.setCompiler(environment.compiler, environment.texLiveVersion);await saveWorkspace();
          }
          let entryId: string | undefined;
          for (const file of document.files) {
            ensureCurrent();
            const hash = hashes.get(file.path)!;
            let saved = files.find(item => item.path === file.path);
            if (force || saved?.digest !== hash) {
              await saveWorkspace({ pendingPaths: [file.path] });
              ensureCurrent();attempted = true;
              const uploaded = await this.cloud.uploadText(file.path, file.content);
              saved = { path: file.path, digest: hash, ...uploaded };
              files = files.filter(item => item.path !== file.path);files.push(saved);
              // Complete ownership bookkeeping even if the formula changed during upload.
              await saveWorkspace({ pendingPaths: [] });
            }
            if (file.path === document.entryPath) {
              if (saved?.type !== 'doc') throw new Error('Overleaf 未把预览入口识别为可编译文档。');
              entryId = saved.id;
            }
          }
          ensureCurrent();
          if (!entryId) throw new Error('未找到上传后的预览入口。');
          this.forceUpload = false;
          this.nextCloudCompile = Date.now() + 3000;
          await session.saveState({ ...session.state, nextCompileAt: this.nextCloudCompile,
            binding: this.cloud.getPreviewProject(), workspace: { sourceProjectId: this.projectId, files, dirty: false, ...environment } });
          attempted = true;
          const result = await this.cloud.compile(entryId, document.entryPath);
          ensureCurrent();
          const complete = { pdf: result.pdf, diagnostics: [...new Set([...document.diagnostics, ...result.diagnostics])] };
          this.remember(cacheKey, complete);
          return complete;
        } catch (error) {
          if (attempted && !(error instanceof DOMException && error.name === 'AbortError') && session.alive()) {
            this.nextCloudCompile = Date.now() + 10_000;
            await session.saveState({ ...session.state, nextCompileAt: this.nextCloudCompile });
          }
          throw error;
        } finally { this.session = undefined;this.operationCurrent = undefined; }
      });
    } finally { this.busy = false; }
  }
}
