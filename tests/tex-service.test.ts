import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/core/types';
import type { CloudCompiler, CloudProjectBinding, CloudProjectFile, OverleafCloudClient } from '../src/overleaf/cloud-client';
import { buildCloudDocument, type CloudDocumentBundle } from '../src/preview/cloud-document';
import { renderLocalTex } from '../src/preview/local-client';
import { TexPreviewService, type TexPreviewInput, type TexServiceOptions } from '../src/preview/tex-service';
import type { SharedCloudSession, SharedCloudState, withSharedCloudLock } from '../src/preview/cloud-coordinator';
import { validSharedCloudState } from '../src/cloud-coordinator-background';

vi.mock('../src/preview/cloud-document', () => ({ buildCloudDocument: vi.fn() }));
vi.mock('../src/preview/local-client', () => ({ renderLocalTex: vi.fn() }));

const ACCOUNT = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const SOURCE = '111111111111111111111111';
const SOURCE_B = '222222222222222222222222';
const PROJECT = '333333333333333333333333';
const binding: CloudProjectBinding = { kind: 'shared-v1', accountId: ACCOUNT, projectId: PROJECT, name: 'Shared preview', compiler: 'pdflatex', texLiveVersion: 'texlive-2026' };
const pdf = new TextEncoder().encode('%PDF-1.7\nsynthetic');
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(initial: SharedCloudState = { binding }) {
  let stored = structuredClone(initial), count = 100;
  const remote = new Map<string, CloudProjectFile & { content?: string }>();
  const nextId = () => (++count).toString(16).padStart(24, '0');
  const saveState = vi.fn(async (state: SharedCloudState) => {
    expect(validSharedCloudState(state, ACCOUNT)).toBe(true);
    stored = structuredClone(state);
  });
  const readState = vi.fn(async () => structuredClone(stored));
  const acquisitions = vi.fn();
  const quarantine = vi.fn();
  const withLock: typeof withSharedCloudLock = async (account, isCurrent, operation) => {
    expect(account).toBe(ACCOUNT); acquisitions();
    if (!isCurrent()) throw new DOMException('stale', 'AbortError');
    let active = true;
    const session: SharedCloudSession = { get state() { return structuredClone(stored); }, alive: () => active, checkpoint: async () => {}, saveState, quarantine };
    try { return await operation(session); } finally { active = false; }
  };
  const readEnvironment = vi.fn(async (): Promise<{ compiler: CloudCompiler; texLiveVersion: string }> => ({ compiler: 'pdflatex', texLiveVersion: 'texlive-2026' }));
  function cloudMock() {
    let target: CloudProjectBinding | undefined;
    return {
      creationOutcome: 'uncertain' as 'uncertain' | 'rejected' | 'not-started' | 'created',
      getPreviewProject: vi.fn(() => target ? { ...target } : undefined),
      restorePreviewProject: vi.fn((next: CloudProjectBinding) => { target = { ...next }; }),
      createPreviewProject: vi.fn(async (name: string) => {
        target = { ...binding, name };
        remote.set('main.tex', { path: 'main.tex', id: nextId(), type: 'doc', content: 'blank template' });
        return target;
      }),
      getFiles: vi.fn(() => [...remote.values()].map(({ content: _content, ...file }) => ({ ...file }))),
      refreshMetadata: vi.fn(async () => {}),
      uploadText: vi.fn(async (path: string, content: string) => {
        const file = { path, id: remote.get(path)?.id ?? nextId(), type: 'doc' as const, content };
        remote.set(path, file); return { id: file.id, type: file.type };
      }),
      removeManagedFiles: vi.fn(async (files: readonly CloudProjectFile[]) => { for (const file of files) { expect(remote.get(file.path)?.id).toBe(file.id); remote.delete(file.path); } }),
      setCompiler: vi.fn(async (compiler: CloudProjectBinding['compiler'], texLiveVersion?: string) => { target = { ...target!, compiler, texLiveVersion }; }),
      compile: vi.fn(async (_id: string, _path: string) => ({ pdf, diagnostics: [] as string[] })),
    };
  }
  const create = (source = SOURCE, active = () => true, options: Partial<TexServiceOptions> = {}) => {
    const cloud = cloudMock();
    const service = new TexPreviewService(source, cloud as unknown as OverleafCloudClient, active, { accountId: ACCOUNT, readState, withLock, readEnvironment, ...options });
    return { cloud, service };
  };
  return { create, remote, saveState, readState, acquisitions, quarantine, readEnvironment, get state() { return structuredClone(stored); }, setState: (state: SharedCloudState) => { stored = structuredClone(state); } };
}

describe('shared TeX preview orchestration', () => {
  let now: number, current: boolean, macros: string, extras: Array<{ path: string; content: string }>;
  let input: TexPreviewInput, h: ReturnType<typeof harness>, cloud: ReturnType<ReturnType<typeof harness>['create']>['cloud'], service: TexPreviewService;
  beforeEach(() => {
    vi.clearAllMocks();
    now = 100_000; current = true; macros = '\\def\\custom{C}'; extras = [];
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    h = harness(); ({ cloud, service } = h.create());
    input = { files: [], rootPath: 'main.tex', readFile: async () => '', settings: { ...DEFAULT_SETTINGS, previewEngine: 'tex', texBackend: 'overleaf' }, formula: 'x', display: true, isCurrent: () => current };
    vi.mocked(buildCloudDocument).mockImplementation(async options => ({ entryPath: 'opt-preview-1.tex', diagnostics: ['bundle note'], files: [
      { path: 'macros.sty', content: macros }, ...extras,
      { path: 'opt-preview-1.tex', content: 'preamble + ' + options.formula },
    ] }));
    vi.mocked(renderLocalTex).mockResolvedValue({ id: 'test', pdfBase64: btoa(new TextDecoder().decode(pdf)), diagnostics: ['local note'] });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('creates only on explicit preparation and reuses one account project from a second source', async () => {
    h = harness({}); const first = h.create(), second = h.create(SOURCE_B);
    const prepared = await first.service.prepareSharedProject();
    expect(first.cloud.createPreviewProject).toHaveBeenCalledOnce();
    expect(h.saveState.mock.calls[0][0]).toMatchObject({ creationPending: { name: 'Overleaf Personal Tools — Preview', startedAt: now } });
    expect(h.state.creationPending).toBeUndefined();
    expect(h.state.workspace?.files).toMatchObject([{ path: 'main.tex', digest: '' }]);
    expect(await second.service.prepareSharedProject()).toEqual(prepared);
    expect(second.cloud.createPreviewProject).not.toHaveBeenCalled();
    expect(second.cloud.restorePreviewProject).toHaveBeenCalledWith(prepared);
    expect(h.state.binding?.projectId).toBe(PROJECT);
  });

  it('never creates a cloud project during rendering and blocks duplicate creation after an unknown outcome', async () => {
    h = harness({}); ({ cloud, service } = h.create());
    await expect(service.render(input)).rejects.toThrow('先在 Extension');
    expect(cloud.createPreviewProject).not.toHaveBeenCalled();
    expect(cloud.uploadText).not.toHaveBeenCalled();
    cloud.createPreviewProject.mockRejectedValueOnce(new Error('creation timeout'));
    await expect(service.prepareSharedProject()).rejects.toThrow('creation timeout');
    expect(h.state.creationPending).toBeDefined();
    await expect(service.prepareSharedProject()).rejects.toThrow('不会自动重复创建');
    expect(cloud.createPreviewProject).toHaveBeenCalledOnce();
  });

  it('preserves a known newly created project when metadata initialization fails', async () => {
    h = harness({}); ({ cloud, service } = h.create());
    const create = cloud.createPreviewProject.getMockImplementation()!;
    cloud.createPreviewProject.mockImplementationOnce(async name => { await create(name); throw new Error('metadata connection failed'); });
    await expect(service.prepareSharedProject()).rejects.toThrow('metadata connection failed');
    expect(h.state.binding?.projectId).toBe(PROJECT);
    expect(h.state.creationPending).toBeUndefined();
    await expect(service.prepareSharedProject()).resolves.toMatchObject({ projectId: PROJECT });
    expect(cloud.createPreviewProject).toHaveBeenCalledOnce();
  });

  it.each(['rejected', 'not-started'] as const)('clears the creation journal after a definite %s outcome and permits retry', async outcome => {
    h = harness({}); ({ cloud, service } = h.create());
    cloud.creationOutcome = outcome;
    cloud.createPreviewProject.mockRejectedValueOnce(new Error(outcome));
    await expect(service.prepareSharedProject()).rejects.toThrow(outcome);
    expect(h.state.creationPending).toBeUndefined();
    expect(h.state.binding).toBeUndefined();
    await expect(service.prepareSharedProject()).resolves.toMatchObject({ projectId: PROJECT });
    expect(cloud.createPreviewProject).toHaveBeenCalledTimes(2);
  });

  it('loads an account binding without network mutations or preparation', async () => {
    await service.loadSharedBinding();
    expect(h.readState).toHaveBeenCalledWith(ACCOUNT);
    expect(cloud.restorePreviewProject).toHaveBeenCalledWith(binding);
    expect(cloud.createPreviewProject).not.toHaveBeenCalled();
    expect(cloud.refreshMetadata).not.toHaveBeenCalled();
    expect(h.acquisitions).not.toHaveBeenCalled();
  });

  it('uploads only changed dependencies and reuses the returned entry ID', async () => {
    await service.render(input);
    expect(cloud.uploadText.mock.calls.map(call => call[0])).toEqual(['macros.sty', 'opt-preview-1.tex']);
    expect(cloud.compile).toHaveBeenCalledWith(h.remote.get('opt-preview-1.tex')!.id, 'opt-preview-1.tex');
    cloud.uploadText.mockClear(); now += 3001; input.formula = 'y';
    await service.render(input);
    expect(cloud.uploadText.mock.calls.map(call => call[0])).toEqual(['opt-preview-1.tex']);
    cloud.uploadText.mockClear(); now += 3001; macros = '\\def\\custom{D}';
    await service.render(input);
    expect(cloud.uploadText.mock.calls.map(call => call[0])).toEqual(['macros.sty']);
    expect(h.state.workspace?.dirty).toBe(false);
  });

  it('removes obsolete files and overwrites a same-name dependency when switching source projects', async () => {
    extras = [{ path: 'old-only.sty', content: 'old source' }];
    await service.render(input); now += 3001;
    const oldId = h.remote.get('old-only.sty')!.id;
    const second = h.create(SOURCE_B); extras = []; macros = '\\def\\custom{different project}';
    await second.service.render(input);
    expect(second.cloud.removeManagedFiles).toHaveBeenCalledWith([expect.objectContaining({ path: 'old-only.sty', id: oldId })]);
    expect(second.cloud.uploadText).toHaveBeenCalledWith('macros.sty', macros);
    expect(h.remote.has('old-only.sty')).toBe(false);
    expect(h.state.workspace?.sourceProjectId).toBe(SOURCE_B);
  });

  it('refuses unregistered remote files or replaced owned identities before mutation', async () => {
    await service.render(input); now += 3001; input.formula = 'other';
    const mutations = cloud.uploadText.mock.calls.length;
    h.remote.set('physics.sty', { path: 'physics.sty', id: '999999999999999999999999', type: 'doc', content: 'unexpected' });
    await expect(service.render(input)).rejects.toThrow('未经扩展登记');
    expect(cloud.uploadText).toHaveBeenCalledTimes(mutations);
    expect(cloud.removeManagedFiles).not.toHaveBeenCalled();
    h.remote.delete('physics.sty');
    h.remote.set('macros.sty', { ...h.remote.get('macros.sty')!, id: '888888888888888888888888' });
    await expect(service.render(input)).rejects.toThrow('已被替换');
  });

  it('reconciles a journaled upload with an unknown response and overwrites it conservatively', async () => {
    h.remote.set('macros.sty', { path: 'macros.sty', id: '777777777777777777777777', type: 'doc', content: 'unknown prior upload' });
    h.setState({ binding, workspace: { sourceProjectId: SOURCE, files: [], pendingPaths: ['macros.sty'], dirty: true } });
    await service.render(input);
    expect(cloud.uploadText).toHaveBeenCalledWith('macros.sty', macros);
    expect(h.state.workspace?.pendingPaths).toBeUndefined();
    expect(h.state.workspace?.files.find(file => file.path === 'macros.sty')).toMatchObject({ id: '777777777777777777777777', digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it('journals a failed sync, keeps it dirty, and retries without assuming the previous upload succeeded', async () => {
    cloud.uploadText.mockRejectedValueOnce(new Error('upload failed'));
    await expect(service.render(input)).rejects.toThrow('upload failed');
    expect(h.state.workspace).toMatchObject({ dirty: true, pendingPaths: ['macros.sty'] });
    expect(h.state.nextCompileAt).toBe(now + 10_000);
    expect(cloud.compile).not.toHaveBeenCalled();
    now += 10_001;
    await service.render(input);
    expect(cloud.uploadText.mock.calls.map(call => call[0])).toEqual(['macros.sty', 'macros.sty', 'opt-preview-1.tex']);
    expect(h.state.workspace?.dirty).toBe(false);
  });

  it('synchronizes the original project compiler and TeX Live version for each context', async () => {
    h.readEnvironment.mockResolvedValueOnce({ compiler: 'xelatex', texLiveVersion: 'texlive-2025' });
    await service.render(input);
    expect(cloud.setCompiler).toHaveBeenCalledWith('xelatex', 'texlive-2025');
    expect(h.state.binding).toMatchObject({ compiler: 'xelatex', texLiveVersion: 'texlive-2025' });
    expect(h.state.workspace).toMatchObject({ compiler: 'xelatex', texLiveVersion: 'texlive-2025' });
    now += 3001;
    const second = h.create(SOURCE_B);
    await second.service.render(input);
    expect(second.cloud.setCompiler).toHaveBeenCalledWith('pdflatex', 'texlive-2026');
  });

  it('records a completed stale upload but starts no subsequent upload or compile', async () => {
    const upload = cloud.uploadText.getMockImplementation()!;
    cloud.uploadText.mockImplementationOnce(async (path, content) => { const result = await upload(path, content); current = false; return result; });
    await expect(service.render(input)).rejects.toMatchObject({ name: 'AbortError' });
    expect(cloud.uploadText).toHaveBeenCalledOnce();
    expect(cloud.compile).not.toHaveBeenCalled();
    expect(h.state.workspace).toMatchObject({ dirty: true, pendingPaths: [], files: [expect.objectContaining({ path: 'macros.sty', id: h.remote.get('macros.sty')!.id })] });
  });

  it('returns a matching PDF from memory without locking, synchronizing or recompiling', async () => {
    const first = await service.render(input), lockCount = h.acquisitions.mock.calls.length;
    cloud.refreshMetadata.mockClear(); cloud.uploadText.mockClear();
    const second = await service.render(input);
    expect(second).toBe(first);
    expect(h.acquisitions).toHaveBeenCalledTimes(lockCount);
    expect(cloud.refreshMetadata).not.toHaveBeenCalled(); expect(cloud.uploadText).not.toHaveBeenCalled();
    expect(cloud.compile).toHaveBeenCalledOnce();
    expect(service.cooldownRemainingMs).toBe(3000);
  });

  it('invalidates cached PDFs, environment and uploaded dependency reuse on explicit refresh', async () => {
    await service.render(input); cloud.uploadText.mockClear(); now += 3001;
    service.invalidate();
    await service.render(input);
    expect(cloud.uploadText).toHaveBeenCalledTimes(2);
    expect(h.readEnvironment).toHaveBeenCalledTimes(2);
    expect(cloud.compile).toHaveBeenCalledTimes(2);
  });

  it('waits for the persisted account-wide cooldown before another source can mutate files', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    h.setState({ binding, nextCompileAt: now + 1000 });
    const rendering = service.render(input);
    await vi.waitFor(() => expect(h.acquisitions).toHaveBeenCalled());
    expect(cloud.refreshMetadata).not.toHaveBeenCalled(); expect(cloud.uploadText).not.toHaveBeenCalled();
    now += 1001; await vi.advanceTimersByTimeAsync(250);
    await expect(rendering).resolves.toMatchObject({ pdf });
    expect(cloud.compile).toHaveBeenCalledOnce();
  });

  it('allows one operation per service and releases its busy state after a failed build', async () => {
    const building = deferred<CloudDocumentBundle>(); vi.mocked(buildCloudDocument).mockReturnValueOnce(building.promise);
    const first = service.render(input), rejected = expect(first).rejects.toThrow('synthetic build error');
    await expect(service.render(input)).rejects.toThrow('正在编译');
    building.reject(new Error('synthetic build error')); await rejected;
    await expect(service.render(input)).resolves.toMatchObject({ pdf });
  });

  it('discards an obsolete cloud PDF and does not cache it or apply failure cooldown', async () => {
    const compiling = deferred<{ pdf: typeof pdf; diagnostics: string[] }>(); cloud.compile.mockReturnValueOnce(compiling.promise);
    const rendering = service.render(input), cancelled = expect(rendering).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(cloud.compile).toHaveBeenCalled());
    current = false; compiling.resolve({ pdf, diagnostics: [] }); await cancelled;
    expect(h.state.nextCompileAt).toBe(now + 3000);
    current = true; now += 4000;
    await service.render(input);
    expect(cloud.compile).toHaveBeenCalledTimes(2);
  });

  it('rechecks selection after asynchronous hashing before acquiring the shared workspace', async () => {
    const hashing = deferred<ArrayBuffer>(), digest = vi.spyOn(crypto.subtle, 'digest').mockReturnValueOnce(hashing.promise);
    const rendering = service.render(input), cancelled = expect(rendering).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(digest).toHaveBeenCalled());
    current = false; hashing.resolve(new Uint8Array(32).buffer); await cancelled;
    expect(h.acquisitions).not.toHaveBeenCalled(); expect(cloud.uploadText).not.toHaveBeenCalled();
  });

  it('keeps local TeX independent of account lookup and cloud coordination', async () => {
    input.settings = { ...input.settings, texBackend: 'local', texCompiler: 'xelatex' };
    const result = await service.render(input);
    expect(renderLocalTex).toHaveBeenCalledWith(expect.objectContaining({ compiler: 'xelatex', document: expect.objectContaining({ entryPath: 'opt-preview-1.tex' }) }));
    expect(result).toEqual({ pdf, diagnostics: ['bundle note', 'local note'] });
    expect(h.readState).not.toHaveBeenCalled(); expect(h.acquisitions).not.toHaveBeenCalled(); expect(h.readEnvironment).not.toHaveBeenCalled();
    expect(cloud.getPreviewProject).not.toHaveBeenCalled(); expect(cloud.uploadText).not.toHaveBeenCalled(); expect(cloud.compile).not.toHaveBeenCalled();
  });

  it('discards a local PDF returned for an obsolete selection', async () => {
    input.settings = { ...input.settings, texBackend: 'local' };
    vi.mocked(renderLocalTex).mockImplementationOnce(async request => { current = false; return { id: request.id, pdfBase64: btoa('%PDF-old'), diagnostics: [] }; });
    await expect(service.render(input)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
