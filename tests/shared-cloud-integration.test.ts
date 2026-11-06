import { afterEach, describe, expect, it, vi } from 'vitest';
import { allowedNativeSender } from '../src/background';
import { registerCloudCoordinator, type CoordinatorRuntime } from '../src/cloud-coordinator-background';
import { withSharedCloudLock, readSharedCloudState } from '../src/preview/cloud-coordinator';
import { TexPreviewService, type TexPreviewInput } from '../src/preview/tex-service';
import type { CloudProjectBinding, CloudProjectFile, OverleafCloudClient } from '../src/overleaf/cloud-client';
import { buildCloudDocument } from '../src/preview/cloud-document';
import { DEFAULT_SETTINGS } from '../src/core/types';

vi.mock('../src/preview/cloud-document', () => ({ buildCloudDocument: vi.fn() }));
const ACCOUNT = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const SOURCE_A = '111111111111111111111111', SOURCE_B = '222222222222222222222222';
const PROJECT = '333333333333333333333333';
const EXTENSION = 'synthetic-extension';
const BINDING: CloudProjectBinding = { kind: 'shared-v1', accountId: ACCOUNT, projectId: PROJECT, name: 'Shared preview', compiler: 'pdflatex', texLiveVersion: 'texlive-2026' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function area(values: Record<string, unknown> = {}) {
  return {
    values,
    get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(values[key])])),
    set: async (updates: Record<string, unknown>) => { for (const [key, value] of Object.entries(updates)) values[key] = structuredClone(value); },
  };
}
function harness() {
  let time = 100_000, nextId = 100;
  vi.spyOn(Date, 'now').mockImplementation(() => time);
  let listener!: Parameters<CoordinatorRuntime['onMessage']['addListener']>[0];
  const local = area({ ['shared-cloud:v1:' + ACCOUNT]: { binding: BINDING } });
  const runtime: CoordinatorRuntime = { id: EXTENSION, onMessage: { addListener: fn => { listener = fn; }, removeListener: vi.fn() } };
  const stop = registerCloudCoordinator(runtime, { local, session: area() }, allowedNativeSender, { now: () => time });
  const remote = new Map<string, CloudProjectFile & { content: string }>();
  const events: string[] = [];
  vi.mocked(buildCloudDocument).mockImplementation(async input => ({
    entryPath: 'preview.tex', diagnostics: [], files: [
      { path: 'macros.sty', content: 'macro:' + input.formula },
      { path: input.formula + '-only.sty', content: 'dependency:' + input.formula },
      { path: 'preview.tex', content: 'formula:' + input.formula },
    ],
  }));
  function client(label: string, source: string, tabId: number, language: string) {
    const from: chrome.runtime.MessageSender = { id: EXTENSION, frameId: 0, documentId: 'document-' + tabId, tab: { id: tabId } as chrome.tabs.Tab, url: `https://${language}.overleaf.com/project/${source}` };
    const send = vi.fn((message: Record<string, unknown>): Promise<any> => new Promise(resolve => { listener(message, from, resolve); }));
    let waiting = deferred<void>();
    const pause = vi.fn(async (_ms: number) => { await waiting.promise; waiting = deferred<void>(); });
    let binding: CloudProjectBinding | undefined;
    const cloud = {
      creationOutcome: 'not-started',
      restorePreviewProject: (value: CloudProjectBinding) => { binding = { ...value }; },
      getPreviewProject: () => binding && { ...binding },
      getFiles: () => [...remote.values()].map(({ content: _content, ...file }) => file),
      refreshMetadata: vi.fn(async () => { events.push(label + ':metadata'); }),
      createPreviewProject: vi.fn(),
      uploadText: vi.fn(async (path: string, content: string) => {
        events.push(label + ':upload:' + path);
        const file = { path, content, id: remote.get(path)?.id ?? (++nextId).toString(16).padStart(24, '0'), type: 'doc' as const };
        remote.set(path, file); return { id: file.id, type: file.type };
      }),
      removeManagedFiles: vi.fn(async (files: CloudProjectFile[]) => { for (const file of files) { events.push(label + ':remove:' + file.path); expect(remote.get(file.path)?.id).toBe(file.id); remote.delete(file.path); } }),
      setCompiler: vi.fn(async () => {}),
      compile: vi.fn(async (_id: string, _path: string) => {
        events.push(label + ':compile');
        expect(remote.get('macros.sty')?.content).toBe('macro:' + label);
        expect(remote.get('preview.tex')?.content).toBe('formula:' + label);
        expect([...remote.keys()].sort()).toEqual([label + '-only.sty', 'macros.sty', 'preview.tex'].sort());
        return { pdf: new TextEncoder().encode('%PDF-' + label), diagnostics: [] };
      }),
    };
    const service = new TexPreviewService(source, cloud as unknown as OverleafCloudClient, () => true, {
      accountId: ACCOUNT,
      readState: account => readSharedCloudState(account, { send }),
      withLock: (account, isCurrent, operation) => withSharedCloudLock(account, isCurrent, operation, { send, pause, now: () => time }),
      readEnvironment: async () => ({ compiler: 'pdflatex', texLiveVersion: 'texlive-2026' }),
    });
    let current = true;
    const input: TexPreviewInput = { files: [], rootPath: 'main.tex', readFile: async () => '', settings: { ...DEFAULT_SETTINGS, previewEngine: 'tex', texBackend: 'overleaf' }, formula: label, display: true, isCurrent: () => current };
    return { service, cloud, input, pause, send, wake: () => waiting.resolve(), cancel: () => { current = false; } };
  }
  return { client, remote, events, stop, advance: (ms: number) => { time += ms; }, local };
}
afterEach(() => { vi.restoreAllMocks(); });

describe('real shared coordinator with two preview services', () => {
  it('locks synchronization through PDF delivery across English and Chinese projects without mixing dependency files', async () => {
    const h = harness(), a = h.client('A', SOURCE_A, 1, 'www'), b = h.client('B', SOURCE_B, 2, 'cn');
    const firstPdf = deferred<void>();
    const compileA = a.cloud.compile.getMockImplementation()!;
    a.cloud.compile.mockImplementationOnce(async (id, path) => {
      const result = await compileA(id, path);
      await firstPdf.promise;
      // No other source may replace files even while output is still being fetched.
      expect(h.remote.get('macros.sty')?.content).toBe('macro:A');
      h.events.push('A:pdf-delivered');
      return result;
    });
    try {
      const first = a.service.render(a.input);
      await vi.waitFor(() => expect(a.cloud.compile).toHaveBeenCalledOnce());
      const second = b.service.render(b.input);
      await vi.waitFor(() => expect(b.pause).toHaveBeenCalledOnce());
      expect(b.cloud.refreshMetadata).not.toHaveBeenCalled();
      expect(b.cloud.uploadText).not.toHaveBeenCalled();
      firstPdf.resolve(); await first;
      h.advance(3001); b.wake();
      const result = await second;
      expect(new TextDecoder().decode(result.pdf)).toBe('%PDF-B');
      expect(h.events.indexOf('A:pdf-delivered')).toBeLessThan(h.events.indexOf('B:metadata'));
      expect(b.cloud.removeManagedFiles).toHaveBeenCalledWith([expect.objectContaining({ path: 'A-only.sty' })]);
      expect(h.remote.has('A-only.sty')).toBe(false);
      const stored = h.local.values['shared-cloud:v1:' + ACCOUNT] as any;
      expect(stored.workspace.sourceProjectId).toBe(SOURCE_B);
      expect(stored.workspace.dirty).toBe(false);
    } finally { firstPdf.resolve(); h.stop(); }
  });

  it('drops an obsolete queued formula before its service reads or mutates the shared project', async () => {
    const h = harness(), a = h.client('A', SOURCE_A, 1, 'www'), b = h.client('B', SOURCE_B, 2, 'cn');
    const firstPdf = deferred<void>();
    const compileA = a.cloud.compile.getMockImplementation()!;
    a.cloud.compile.mockImplementationOnce(async (id, path) => { const result = await compileA(id, path); await firstPdf.promise; return result; });
    try {
      const first = a.service.render(a.input);
      await vi.waitFor(() => expect(a.cloud.compile).toHaveBeenCalledOnce());
      const second = b.service.render(b.input);
      const canceled = expect(second).rejects.toMatchObject({ name: 'AbortError' });
      await vi.waitFor(() => expect(b.pause).toHaveBeenCalledOnce());
      b.cancel(); b.wake(); await canceled;
      expect(b.cloud.refreshMetadata).not.toHaveBeenCalled(); expect(b.cloud.uploadText).not.toHaveBeenCalled(); expect(b.cloud.compile).not.toHaveBeenCalled();
      expect(b.send.mock.calls.at(-1)?.[0]).toMatchObject({ op: 'cancel' });
      firstPdf.resolve(); await first;
      expect(h.remote.get('macros.sty')?.content).toBe('macro:A');
    } finally { firstPdf.resolve(); h.stop(); }
  });
});
