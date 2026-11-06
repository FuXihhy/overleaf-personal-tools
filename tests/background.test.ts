import { afterEach, describe, expect, it, vi } from 'vitest';
import { allowedNativeSender, registerNativeTransport, TEX_NATIVE_HOST, validTexRequest, type NativePort, type NativeRuntime, type TabRemoval } from '../src/background';
import type { TexRenderRequest } from '../src/preview/tex-types';

const EXTENSION = 'pffppbkokpnfafpechmlambifflkmbbn';
const sender = (tabId = 1): chrome.runtime.MessageSender => ({ id: EXTENSION, tab: { id: tabId } as chrome.tabs.Tab, frameId: 0, url: 'https://www.overleaf.com/project/0123456789abcdef01234567' });
const request = (id = 'request-1'): TexRenderRequest => ({ version: 1, op: 'render', id, compiler: 'pdflatex', document: { entryPath: 'preview.tex', files: [{ path: 'preview.tex', content: '\\documentclass{article}' }], diagnostics: [] } });
const encodedPdf = btoa('%PDF-1.7\npreview');
class FakePort implements NativePort {
  messages = new Set<(message: unknown) => void>();
  disconnects = new Set<() => void>();
  onMessage = { addListener: (fn: (message: unknown) => void) => { this.messages.add(fn); } };
  onDisconnect = { addListener: (fn: () => void) => { this.disconnects.add(fn); } };
  postMessage = vi.fn();
  disconnect = vi.fn(() => { for (const fn of this.disconnects) fn(); });
  receive(message: unknown) { for (const fn of this.messages) fn(message); }
}
function harness() {
  let listener!: Parameters<NativeRuntime['onMessage']['addListener']>[0];
  const removals = new Set<(tabId: number) => void>();
  const ports: FakePort[] = [];
  const runtime: NativeRuntime = {
    id: EXTENSION,
    onMessage: { addListener: vi.fn(fn => { listener = fn; }), removeListener: vi.fn() },
    connectNative: vi.fn(() => { const port = new FakePort(); ports.push(port); return port; }),
  };
  const tabs: TabRemoval = { addListener: fn => { removals.add(fn); }, removeListener: fn => { removals.delete(fn); } };
  const stop = registerNativeTransport(runtime, tabs);
  const dispatch = (message: unknown, from = sender()) => {
    let respond!: (value: unknown) => void;
    const response = new Promise<unknown>(resolve => { respond = resolve; });
    const callback = vi.fn(respond);
    const async = listener(message, from, callback);
    return { response, callback, async };
  };
  return { runtime, ports, stop, dispatch, closeTab: (id: number) => { for (const fn of removals) fn(id); } };
}
afterEach(() => { vi.useRealTimers(); });

describe('native messaging service worker', () => {
  it('limits callers to this extension and top-level Overleaf project tabs', () => {
    expect(allowedNativeSender(sender(), EXTENSION)).toBe(true);
    expect(allowedNativeSender({ ...sender(), url: 'https://cn.overleaf.com/project/0123456789abcdef01234567' }, EXTENSION)).toBe(true);
    expect(allowedNativeSender({ ...sender(), url: sender().url + '?x=1#top' }, EXTENSION)).toBe(true);
    for (const from of [
      { ...sender(), id: 'other' }, { ...sender(), tab: undefined }, { ...sender(), frameId: 1 },
      { ...sender(), url: 'https://www.overleaf.com.attacker.test/project/0123456789abcdef01234567' },
      { ...sender(), url: 'https://www.overleaf.com/project/0123456789abcdef01234567/settings' },
      { ...sender(), url: 'http://www.overleaf.com/project/0123456789abcdef01234567' },
      { ...sender(), url: 'https://fr.overleaf.com/project/0123456789abcdef01234567' },
      { ...sender(), url: 'https://overleaf.com/project/0123456789abcdef01234567' },
      { ...sender(), url: 'https://cn.overleaf.com:8443/project/0123456789abcdef01234567' },
      { ...sender(), url: 'https://cn.overleaf.com.attacker.test/project/0123456789abcdef01234567' },
      { ...sender(), url: 'https://www.overleaf.com@cn.overleaf.com/project/0123456789abcdef01234567' },
    ]) expect(allowedNativeSender(from, EXTENSION)).toBe(false);
  });

  it('does not connect for denied senders or malformed source requests', async () => {
    const h = harness();
    const denied = h.dispatch({ type: 'opt:local-status' }, { ...sender(), id: 'other' });
    expect(await denied.response).toMatchObject({ available: false });
    const invalid = request(); invalid.document.files[0].path = '../preview.tex';
    expect(await h.dispatch({ type: 'opt:local-render', request: invalid }).response).toMatchObject({ diagnostics: [expect.stringContaining('无效')] });
    expect(h.runtime.connectNative).not.toHaveBeenCalled();
    h.stop();
  });

  it('validates source bounds and rejects duplicate / missing entry paths', () => {
    expect(validTexRequest(request())).toBe(true);
    const duplicate = request(); duplicate.document.files.push(duplicate.document.files[0]);
    expect(validTexRequest(duplicate)).toBe(false);
    expect(validTexRequest({ ...request(), compiler: 'sh' })).toBe(false);
    expect(validTexRequest({ ...request(), arbitraryPayload: 'unbounded extras are not forwarded' })).toBe(false);
    const missing = request(); missing.document.entryPath = 'missing.tex';
    expect(validTexRequest(missing)).toBe(false);
    const huge = request(); huge.document.files[0].content = 'a'.repeat(8 * 1024 * 1024 + 1);
    expect(validTexRequest(huge)).toBe(false);
  });

  it('forwards render unchanged, returns matching PDF once, and closes the native port', async () => {
    const h = harness(); const req = request();
    const call = h.dispatch({ type: 'opt:local-render', request: req });
    expect(call.async).toBe(true);
    expect(h.runtime.connectNative).toHaveBeenCalledWith(TEX_NATIVE_HOST);
    expect(h.ports[0].postMessage).toHaveBeenCalledWith(req);
    h.ports[0].receive({ id: req.id, pdfBase64: encodedPdf, diagnostics: [], elapsedMs: 10 });
    expect(await call.response).toEqual({ id: req.id, pdfBase64: encodedPdf, diagnostics: [], elapsedMs: 10 });
    expect(h.ports[0].disconnect).toHaveBeenCalledOnce();
    expect(call.callback).toHaveBeenCalledOnce();
    h.stop();
  });

  it('keeps status independent from rendering and coalesces concurrent status checks', async () => {
    const h = harness(); const render = h.dispatch({ type: 'opt:local-render', request: request() });
    const first = h.dispatch({ type: 'opt:local-status' });
    const second = h.dispatch({ type: 'opt:local-status' });
    expect(h.ports).toHaveLength(2);
    expect(h.ports[0].disconnect).not.toHaveBeenCalled();
    const status = h.ports[1].postMessage.mock.calls[0][0];
    expect(status).toMatchObject({ op: 'status', version: 1 });
    h.ports[1].receive({ id: status.id, available: true, compilers: ['pdflatex'], sandbox: true, version: '1', message: 'ready' });
    expect(await first.response).toEqual(await second.response);
    expect(h.ports[1].disconnect).toHaveBeenCalledOnce();
    expect(h.ports[0].disconnect).not.toHaveBeenCalled();
    h.stop();
    await render.response;
  });

  it('cancels only the previous render in the same tab when a newer request arrives', async () => {
    const h = harness();
    const a = h.dispatch({ type: 'opt:local-render', request: request('a') });
    const other = h.dispatch({ type: 'opt:local-render', request: request('other') }, sender(2));
    const b = h.dispatch({ type: 'opt:local-render', request: request('b') });
    expect(await a.response).toMatchObject({ id: 'a', diagnostics: [expect.stringContaining('取消')] });
    expect(h.ports[0].disconnect).toHaveBeenCalledOnce();
    expect(h.ports[1].disconnect).not.toHaveBeenCalled();
    h.ports[0].receive({ id: 'a', diagnostics: [], pdfBase64: encodedPdf });
    expect(a.callback).toHaveBeenCalledOnce();
    h.ports[2].receive({ id: 'b', diagnostics: [], pdfBase64: encodedPdf });
    expect(await b.response).toMatchObject({ id: 'b', pdfBase64: encodedPdf });
    h.stop(); await other.response;
  });

  it('cancels native processes on explicit cancellation and tab removal', async () => {
    const h = harness();
    const first = h.dispatch({ type: 'opt:local-render', request: request() });
    expect(await h.dispatch({ type: 'opt:local-cancel' }).response).toEqual({ diagnostics: [] });
    expect(await first.response).toMatchObject({ diagnostics: [expect.stringContaining('取消')] });
    const second = h.dispatch({ type: 'opt:local-render', request: request('second') });
    h.closeTab(1);
    expect(await second.response).toMatchObject({ diagnostics: [expect.stringContaining('关闭')] });
    expect(h.ports.every(port => port.disconnect.mock.calls.length === 1)).toBe(true);
    h.stop();
  });

  it('times out after 30 seconds and disconnects, allowing a subsequent request', async () => {
    vi.useFakeTimers();
    const h = harness(); const call = h.dispatch({ type: 'opt:local-render', request: request() });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await call.response).toMatchObject({ diagnostics: [expect.stringContaining('30 秒')] });
    expect(h.ports[0].disconnect).toHaveBeenCalledOnce();
    const next = h.dispatch({ type: 'opt:local-render', request: request('next') });
    expect(h.ports).toHaveLength(2);
    h.stop(); await next.response;
  });

  it('consumes native disconnect errors and rejects mismatched or invalid output', async () => {
    const h = harness(); const call = h.dispatch({ type: 'opt:local-status' });
    Object.defineProperty(h.runtime, 'lastError', { configurable: true, get: vi.fn(() => ({ message: 'Native messaging host not found' })) });
    h.ports[0].disconnect();
    expect(await call.response).toMatchObject({ available: false, message: expect.stringContaining('not found') });
    const mismatched = h.dispatch({ type: 'opt:local-render', request: request() });
    h.ports[1].receive({ id: 'other', diagnostics: [], pdfBase64: encodedPdf });
    expect(await mismatched.response).toMatchObject({ diagnostics: [expect.stringContaining('不匹配')] });
    const invalidPdf = h.dispatch({ type: 'opt:local-render', request: request() });
    h.ports[2].receive({ id: 'request-1', diagnostics: [], pdfBase64: btoa('<html>') });
    expect(await invalidPdf.response).toMatchObject({ diagnostics: [expect.stringContaining('无效')] });
    h.stop();
  });

  it('turns synchronous native connection failures into readable results', async () => {
    const h = harness(); vi.mocked(h.runtime.connectNative).mockImplementation(() => { throw new Error('not installed'); });
    expect(await h.dispatch({ type: 'opt:local-status' }).response).toMatchObject({ available: false, message: expect.stringContaining('not installed') });
    h.stop();
    expect(h.runtime.onMessage.removeListener).toHaveBeenCalledOnce();
  });

  it('preserves the native host’s bounded compiler error detail', async () => {
    const h = harness();
    const call = h.dispatch({ type: 'opt:local-render', request: request() });
    const detail = 'TeX compile failed: ' + 'x'.repeat(6980);
    h.ports[0].receive({ id: 'request-1', diagnostics: [detail] });
    expect(await call.response).toEqual({ id: 'request-1', diagnostics: [detail] });
    h.stop();
  });
});
