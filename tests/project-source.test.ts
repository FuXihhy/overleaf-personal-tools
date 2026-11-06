import { afterEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { decodeProjectArchive, findRootCandidates, normalizeProjectPath, OverleafProjectSource } from '../src/overleaf/project-source';

const PROJECT = '0123456789abcdef01234567';
const archive = (files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([path, text]) => [path, strToU8(text)])));
const response = (files: Record<string, string>) => new Response(archive(files) as Uint8Array<ArrayBuffer>, { headers: { 'content-type': 'application/zip' } });
afterEach(() => vi.unstubAllGlobals());

describe('project source export', () => {
  it('captures a fresh complete export without clearing preview caches or overwriting collaboration with stale live buffers', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ 'main.tex': '\\documentclass{article}\nOld main', 'chapter.tex': 'Old chapter' }))
      .mockResolvedValueOnce(response({ 'main.tex': '\\documentclass{article}\nSaved main', 'chapter.tex': 'New collaborative chapter' }))
      .mockResolvedValueOnce(response({ 'main.tex': '\\documentclass{article}\nSaved main 2', 'chapter.tex': 'Newest collaborative chapter' }));
    const source = new OverleafProjectSource(PROJECT, { fetch: fetcher, readMetadata: async () => undefined });
    const old = await source.discover(); source.setLiveDocument('chapter.tex', 'Stale previously visited buffer');
    const active = new Map([['main.tex', '\\documentclass{article}\nUnsaved current editor']]);
    const first = await source.captureFull({ liveDocuments: active });
    expect(first.files).toContainEqual({ path: 'main.tex', content: active.get('main.tex') });
    expect(first.files).toContainEqual({ path: 'chapter.tex', content: 'New collaborative chapter' });
    expect(await source.readFile(old.files.find(file => file.path === 'chapter.tex')!)).toBe('Stale previously visited buffer');
    const second = await source.captureFull({ liveDocuments: active });
    expect(second.files).toContainEqual({ path: 'chapter.tex', content: 'Newest collaborative chapter' }); expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('freezes the active buffer before asynchronous export and refuses a missing active file', async () => {
    let deliver!: (value: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { deliver = resolve; }));
    const source = new OverleafProjectSource(PROJECT, { fetch: fetcher, readMetadata: async () => undefined });
    const live = new Map([['main.tex', 'Captured buffer']]);
    const capture = source.captureFull({ liveDocuments: live }); live.set('main.tex', 'Later typing');
    deliver(response({ 'main.tex': '\\documentclass{article}' })); expect((await capture).files[0].content).toBe('Captured buffer');
    const missing = source.captureFull({ liveDocuments: new Map([['missing.tex', 'Unsaved']]) }); deliver(response({ 'main.tex': '\\documentclass{article}' }));
    await expect(missing).rejects.toThrow('active source file');
    const controller = new AbortController(); controller.abort(); await expect(source.captureFull({ signal: controller.signal })).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('retains project text paths and ignores images / PDFs', () => {
    const map = decodeProjectArchive(archive({ 'main.tex': '\\documentclass{article}', 'config/macros.sty': '\\def\\R{R}', 'large.pdf': 'not parsed' }));
    expect([...map.keys()]).toEqual(['main.tex', 'config/macros.sty']);
  });
  it('rejects traversal, binary source text, and source ZIP bombs', () => {
    expect(() => normalizeProjectPath('../macros.sty')).toThrow();
    expect(() => normalizeProjectPath('/etc/main.tex')).toThrow();
    expect(() => decodeProjectArchive(archive({ 'bad.tex': 'a\0b' }))).toThrow('二进制');
    expect(() => decodeProjectArchive(archive({ 'big.tex': 'a'.repeat(2 * 1024 * 1024 + 1) }))).toThrow('过大');
  });
  it('finds roots without mistaking commented documentclass for a root', () => {
    const map = new Map([['main.tex', '%\\documentclass{fake}\n\\documentclass{article}'], ['chapter.tex', '% \\documentclass{fake}'], ['package.sty', '\\documentclass{article}']]);
    expect(findRootCandidates(map)).toEqual(['main.tex']);
  });
  it('uses a single read-only GET for concurrent reads and a bounded memory snapshot', async () => {
    const fetcher = vi.fn(async () => response({ 'main.tex': '\\documentclass{article}', 'macros.sty': '\\def\\R{R}' }));
    const source = new OverleafProjectSource(PROJECT, { fetch: fetcher });
    const [a, b] = await Promise.all([source.discover(), source.discover()]);
    expect(a.rootPath).toBe('main.tex');
    expect(b.files).toHaveLength(2);
    expect(await source.readFile(a.files.find(f => f.path === 'macros.sty')!)).toBe('\\def\\R{R}');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(`/project/${PROJECT}/download/zip`, expect.objectContaining({ method: 'GET', credentials: 'same-origin', redirect: 'error' }));
  });
  it('requires an explicit choice for multiple main documents', async () => {
    const source = new OverleafProjectSource(PROJECT, { fetch: vi.fn(async () => response({ 'a.tex': '\\documentclass{article}', 'b.tex': '\\documentclass{book}' })) });
    expect((await source.discover()).rootPath).toBe('');
    source.setRootPath('b.tex');
    expect((await source.discover()).rootPath).toBe('b.tex');
    source.setRootPath('missing.tex');
    await expect(source.discover()).rejects.toThrow('不存在');
  });
  it('automatically follows authoritative Overleaf root metadata after loading the ZIP, without native settings', async () => {
    const order: string[] = [];
    const fetcher = vi.fn(async () => { order.push('zip'); return response({ 'main.tex': '\\documentclass{article}', 'thesis/source.tex': '\\input{preamble}' }); });
    const readMetadata = vi.fn(async () => { order.push('metadata'); return { rootDocId: '1123456789abcdef01234567', rootPath: 'thesis/source.tex' }; });
    const source = new OverleafProjectSource(PROJECT, { fetch: fetcher, readMetadata });
    const [first, second] = await Promise.all([source.discover(), source.discover()]);
    expect(first.rootPath).toBe('thesis/source.tex');
    expect(second.rootPath).toBe('thesis/source.tex');
    expect(order).toEqual(['zip', 'metadata']);
    expect(readMetadata).toHaveBeenCalledExactlyOnceWith(PROJECT, expect.any(AbortSignal));
    await source.discover();
    expect(readMetadata).toHaveBeenCalledOnce();
  });
  it('refreshes the authoritative root with its archive and keeps manual override explicit', async () => {
    const readMetadata = vi.fn().mockResolvedValueOnce({ rootPath: 'a.tex' }).mockResolvedValueOnce({ rootPath: 'b.tex' });
    const source = new OverleafProjectSource(PROJECT, { fetch: vi.fn(async () => response({ 'a.tex': '\\documentclass{article}', 'b.tex': '\\documentclass{book}' })), readMetadata });
    expect((await source.discover()).rootPath).toBe('a.tex');
    source.invalidate();
    expect((await source.discover()).rootPath).toBe('b.tex');
    source.setRootPath('a.tex');
    expect((await source.discover()).rootPath).toBe('a.tex');
    source.setRootPath();
    expect((await source.discover()).rootPath).toBe('b.tex');
    expect(readMetadata).toHaveBeenCalledTimes(2);
  });
  it('uses an already-mounted native selection and remembers it after the dialog closes', async () => {
    let selected: { selectedOptions: { textContent: string }[] } | null = { selectedOptions: [{ textContent: 'b.tex' }] };
    vi.stubGlobal('document', { querySelector: (query: string) => query === 'select#rootDocId' ? selected : null });
    const readMetadata = vi.fn(async () => ({ rootPath: 'a.tex' }));
    const source = new OverleafProjectSource(PROJECT, { fetch: vi.fn(async () => response({ 'a.tex': '\\documentclass{article}', 'b.tex': '\\documentclass{book}' })), readMetadata });
    expect((await source.discover()).rootPath).toBe('b.tex');
    selected = null;
    expect((await source.discover()).rootPath).toBe('b.tex');
    expect(readMetadata).not.toHaveBeenCalled();
  });
  it('synchronously remembers a native change before any asynchronous discover or mounted select', async () => {
    const readMetadata = vi.fn(async () => ({ rootPath: 'main.tex' }));
    const fetcher = vi.fn(async () => response({ 'main.tex': '\\documentclass{article}', 'paper/alternate.tex': '\\documentclass{book}' }));
    const source = new OverleafProjectSource(PROJECT, { fetch: fetcher, readMetadata });
    expect(source.observeNativeRoot('main.tex')).toBe(false);
    expect((await source.discover()).rootPath).toBe('main.tex');
    expect(source.observeNativeRoot('./paper/alternate.tex')).toBe(true);
    // React's controlled select can temporarily restore its old saved value.
    vi.stubGlobal('document', { querySelector: (query: string) => query === 'select#rootDocId' ? { selectedOptions: [{ textContent: 'main.tex' }] } : null });
    expect((await source.discover()).rootPath).toBe('paper/alternate.tex');
    // The change handler has captured the path; the native dialog is now gone.
    vi.stubGlobal('document', { querySelector: () => null });
    expect((await source.discover()).rootPath).toBe('paper/alternate.tex');
    expect(source.observeNativeRoot('../main.tex')).toBe(false);
    expect(source.observeNativeRoot('missing.tex')).toBe(false);
    expect((await source.discover()).rootPath).toBe('paper/alternate.tex');
    source.setRootPath('main.tex');
    expect((await source.discover()).rootPath).toBe('main.tex');
    source.setRootPath();
    expect((await source.discover()).rootPath).toBe('paper/alternate.tex');
    expect(source.observeNativeRoot('main.tex')).toBe(true);
    vi.stubGlobal('document', { querySelector: (query: string) => query === 'select#rootDocId' ? { selectedOptions: [{ textContent: 'paper/alternate.tex' }] } : null });
    expect((await source.discover()).rootPath).toBe('main.tex');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(readMetadata).toHaveBeenCalledOnce();
  });
  it('clears the captured native choice on explicit refresh', async () => {
    const readMetadata = vi.fn(async () => ({ rootPath: 'main.tex' }));
    const source = new OverleafProjectSource(PROJECT, { fetch: vi.fn(async () => response({ 'main.tex': '\\documentclass{article}', 'alternate.tex': '\\documentclass{book}' })), readMetadata });
    await source.discover();
    source.observeNativeRoot('alternate.tex');
    expect((await source.discover()).rootPath).toBe('alternate.tex');
    source.invalidate();
    expect((await source.discover()).rootPath).toBe('main.tex');
    expect(readMetadata).toHaveBeenCalledTimes(2);
  });
  it('keeps a changed native root after closing settings even when older metadata arrives late', async () => {
    let selected: { selectedOptions: { textContent: string }[] } | null = null;
    let resolve!: (value: { rootPath: string }) => void;
    let metadataSignal!: AbortSignal;
    vi.stubGlobal('document', { querySelector: (query: string) => query === 'select#rootDocId' ? selected : null });
    const fetcher = vi.fn(async () => response({ 'a.tex': '\\documentclass{article}', 'b.tex': '\\documentclass{book}' }));
    const readMetadata = vi.fn((_id: string, signal: AbortSignal) => {
      metadataSignal = signal;
      return new Promise<{ rootPath: string }>(done => { resolve = done; });
    });
    const source = new OverleafProjectSource(PROJECT, { fetch: fetcher, readMetadata });
    const initial = source.discover();
    await vi.waitFor(() => expect(readMetadata).toHaveBeenCalledOnce());
    selected = { selectedOptions: [{ textContent: 'a.tex' }] };
    expect((await source.discover()).rootPath).toBe('a.tex');
    selected = { selectedOptions: [{ textContent: 'b.tex' }] };
    expect(source.observeNativeRoot(selected.selectedOptions[0].textContent)).toBe(true);
    selected = null;
    resolve({ rootPath: 'a.tex' });
    expect((await initial).rootPath).toBe('b.tex');
    expect((await source.discover()).rootPath).toBe('b.tex');
    expect(metadataSignal.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(readMetadata).toHaveBeenCalledOnce();
  });
  it('falls back safely when metadata is unavailable or absent from the current archive', async () => {
    for (const readMetadata of [vi.fn(async () => { throw new Error('not connected'); }), vi.fn(async () => ({ rootPath: 'missing.tex' }))]) {
      const single = new OverleafProjectSource(PROJECT, { fetch: vi.fn(async () => response({ 'entry.tex': '\\documentclass{article}', 'main.tex': 'chapter' })), readMetadata });
      expect((await single.discover()).rootPath).toBe('entry.tex');
      const multiple = new OverleafProjectSource(PROJECT, { fetch: vi.fn(async () => response({ 'main.tex': '\\documentclass{article}', 'other.tex': '\\documentclass{article}' })), readMetadata });
      expect((await multiple.discover()).rootPath).toBe('');
    }
  });
  it('aborts stale metadata on refresh instead of accepting its later response', async () => {
    let resolve!: (value: { rootPath: string }) => void;
    let signal!: AbortSignal;
    const readMetadata = vi.fn((_id: string, inputSignal: AbortSignal) => {
      signal = inputSignal;
      return new Promise<{ rootPath: string }>(done => { resolve = done; });
    });
    const source = new OverleafProjectSource(PROJECT, { fetch: vi.fn(async () => response({ 'main.tex': '\\documentclass{article}' })), readMetadata });
    const pending = source.discover().catch(error => error);
    await vi.waitFor(() => expect(readMetadata).toHaveBeenCalledOnce());
    source.invalidate();
    expect(signal.aborted).toBe(true);
    resolve({ rootPath: 'main.tex' });
    expect(await pending).toEqual(expect.objectContaining({ message: expect.stringContaining('刷新') }));
  });
  it('live text overlays the archive and explicit refresh clears stale snapshots', async () => {
    const fetcher = vi.fn(async () => response({ 'main.tex': '\\documentclass{article}', 'macros.sty': 'old' }));
    const source = new OverleafProjectSource(PROJECT, { fetch: fetcher });
    const file = (await source.discover()).files.find(f => f.path === 'macros.sty')!;
    source.setLiveDocument('macros.sty', 'new');
    expect(await source.readFile(file)).toBe('new');
    expect(fetcher).toHaveBeenCalledTimes(1);
    source.invalidate();
    expect(await source.readFile(file)).toBe('old');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('surfaces authentication and archive limits rather than indexing HTML', async () => {
    const login = new OverleafProjectSource(PROJECT, { fetch: vi.fn(async () => new Response('<html/>', { headers: { 'content-type': 'text/html' } })) });
    await expect(login.discover()).rejects.toThrow('ZIP');
    const denied = new OverleafProjectSource(PROJECT, { fetch: vi.fn(async () => new Response('', { status: 403 })) });
    await expect(denied.discover()).rejects.toThrow('403');
    const large = new OverleafProjectSource(PROJECT, { maxArchiveBytes: 8, fetch: vi.fn(async () => response({ 'main.tex': 'long enough to overflow' })) });
    await expect(large.discover()).rejects.toThrow('上限');
  });
});
