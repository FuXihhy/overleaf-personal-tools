import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelLocalTex, getLocalStatus, renderLocalTex } from '../src/preview/local-client';
import type { TexRenderRequest } from '../src/preview/tex-types';

const request: TexRenderRequest = { version: 1, op: 'render', id: 'test-id', compiler: 'xelatex', document: { entryPath: 'preview.tex', files: [{ path: 'preview.tex', content: 'test' }], diagnostics: [] } };
function runtime(response: unknown, error?: string) {
  const sendMessage = vi.fn((_message: unknown, callback: (value: unknown) => void) => callback(response));
  const api = { sendMessage, lastError: error ? { message: error } : undefined };
  vi.stubGlobal('chrome', { runtime: api });
  return api;
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('local TeX content client', () => {
  it('handles context invalidation while a native reply is pending', async () => {
    const api=runtime(undefined);
    let reply: (value:unknown)=>void = ()=>{};
    api.sendMessage.mockImplementation((_message,callback)=>{reply=callback;});
    const pending=getLocalStatus();
    Object.defineProperty(api,'lastError',{get(){throw new Error('Extension context invalidated.');}});
    expect(()=>reply(undefined)).not.toThrow();
    expect(await pending).toMatchObject({available:false,message:expect.stringContaining('刷新 Overleaf 页面')});
    expect(api.sendMessage).toHaveBeenCalledOnce();
  });
  it('sends status and render through the extension and preserves request contents', async () => {
    let api = runtime({ available: true, message: 'ready', sandbox: true });
    expect(await getLocalStatus()).toMatchObject({ available: true, sandbox: true });
    expect(api.sendMessage.mock.calls[0][0]).toEqual({ type: 'opt:local-status' });
    api = runtime({ id: 'test-id', diagnostics: ['warning'], pdfBase64: 'pdf' });
    expect(await renderLocalTex(request)).toMatchObject({ id: 'test-id', diagnostics: ['warning'] });
    expect(api.sendMessage.mock.calls[0][0]).toEqual({ type: 'opt:local-render', request });
  });
  it('returns readable results when runtime, worker, or response is unavailable', async () => {
    vi.stubGlobal('chrome', undefined);
    expect(await getLocalStatus()).toMatchObject({ available: false, message: expect.stringContaining('运行环境') });
    runtime(undefined, 'Extension context invalidated');
    expect(await renderLocalTex(request)).toMatchObject({ id: 'test-id', diagnostics: [expect.stringContaining('刷新 Overleaf 页面')] });
    runtime(undefined);
    expect(await getLocalStatus()).toMatchObject({ available: false });
    runtime({ id: 'another', diagnostics: [] });
    expect(await renderLocalTex(request)).toMatchObject({ diagnostics: [expect.stringContaining('有效')] });
  });
  it('does not throw on cancellation after a disconnected extension', async () => {
    const api = runtime(undefined, 'disconnected');
    await expect(cancelLocalTex()).resolves.toBeUndefined();
    expect(api.sendMessage.mock.calls[0][0]).toEqual({ type: 'opt:local-cancel' });
  });
  it('bounds a worker that never replies and catches synchronous messaging failures', async () => {
    vi.useFakeTimers();
    const api = runtime(undefined);
    api.sendMessage.mockImplementation(() => undefined);
    const result = getLocalStatus();
    await vi.advanceTimersByTimeAsync(96_650);
    expect(await result).toMatchObject({ available: false, message: expect.stringContaining('超时') });
    expect(api.sendMessage).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    api.sendMessage.mockImplementation(() => { throw new Error('gone'); });
    expect(await renderLocalTex(request)).toMatchObject({ diagnostics: [expect.stringContaining('gone')] });
  });

  it('recovers a read-only status when a worker connection closes', async () => {
    vi.useFakeTimers();
    const api = runtime(undefined, 'Could not establish connection. Receiving end does not exist.');
    const result = getLocalStatus();
    await vi.advanceTimersByTimeAsync(149);
    expect(api.sendMessage).toHaveBeenCalledOnce();
    api.lastError = undefined;
    api.sendMessage.mockImplementation((_message, callback) => callback({ available: true, message: 'ready' }));
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ available: true });
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not replay a render whose reply was lost or tell the user to reload the extension', async () => {
    const api = runtime(undefined, 'The message port closed before a response was received.');
    const result = await renderLocalTex(request);
    expect(api.sendMessage).toHaveBeenCalledOnce();
    expect(result.diagnostics[0]).toContain('连接暂时中断');
    expect(result.diagnostics[0]).not.toContain('重新加载');
  });

  it('notifies its owner only for true extension invalidation', async () => {
    const retired = vi.fn();
    let api = runtime(undefined, 'Specified native messaging host not found.');
    await getLocalStatus(retired); expect(retired).not.toHaveBeenCalled();
    api = runtime(undefined, 'Extension context invalidated.');
    await getLocalStatus(retired); expect(retired).toHaveBeenCalledOnce();
    expect(api.sendMessage).toHaveBeenCalledOnce();
    await renderLocalTex(request, retired); expect(retired).toHaveBeenCalledTimes(2);
  });
});
