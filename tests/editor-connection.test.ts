// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEditorConnection } from '../src/overleaf/editor-connection';

const cleanups: Array<() => void> = [];
function connection(signal?: AbortSignal) {
  const result = createEditorConnection({ signal }); cleanups.push(result.dispose); return result;
}
function listen(type: string, listener: EventListener) {
  window.addEventListener(type, listener); cleanups.push(() => window.removeEventListener(type, listener));
}
function reply(requestId: string, state: string) {
  window.dispatchEvent(new CustomEvent('opt:connection-status', { detail: JSON.stringify({ requestId, state }) }));
}
function respond(state: () => string) {
  listen('opt:connection-request', ((event: CustomEvent<string>) => reply(JSON.parse(event.detail).requestId, state())) as EventListener);
}
function mountEditor() {
  const editor = document.createElement('div'); editor.className = 'cm-editor';
  const content = document.createElement('div'); content.tabIndex = 0; editor.append(content); document.body.append(editor); return content;
}
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup()); document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks();
});

describe('editor connection recovery', () => {
  it('performs one native handshake for concurrent requests and waits for a fresh status', async () => {
    const client = connection(); const handshakes = vi.fn(); listen('editor:extension-loaded', handshakes);
    let requestId = '';
    listen('opt:connection-request', ((event: CustomEvent<string>) => { requestId = JSON.parse(event.detail).requestId; }) as EventListener);
    const first = client.reconnect(), second = client.reconnect();
    expect(second).toBe(first); expect(handshakes).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    let done = false; void first.then(() => { done = true; });
    reply('stale-request', 'connected');
    window.dispatchEvent(new CustomEvent('opt:editor', { detail: JSON.stringify({ type: 'ready' }) }));
    await Promise.resolve(); expect(done).toBe(false);
    reply(requestId, 'connected'); await expect(first).resolves.toBeUndefined();
  });

  it('reports an unavailable current editor rather than accepting a ready event', async () => {
    const client = connection(); respond(() => 'unavailable');
    await expect(client.reconnect()).rejects.toMatchObject({ code: 'editor-unavailable' });
  });

  it('does not let a delayed automatic probe repeat an already completed manual reconnect', async () => {
    vi.useFakeTimers(); const content = mountEditor(), client = connection(), handshakes = vi.fn();
    listen('editor:extension-loaded', handshakes);
    let automaticRequest = '';
    listen('opt:connection-request', ((event: CustomEvent<string>) => {
      const id = JSON.parse(event.detail).requestId;
      if (!automaticRequest) automaticRequest = id; else reply(id, 'connected');
    }) as EventListener);
    content.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); await vi.advanceTimersByTimeAsync(50);
    await client.reconnect(); reply(automaticRequest, 'detached');
    await vi.advanceTimersByTimeAsync(300); expect(handshakes).toHaveBeenCalledTimes(1);
  });

  it.each(['detached', 'silent'])('bounds %s recovery to two seconds without repeated native handshakes', async state => {
    vi.useFakeTimers(); const client = connection(), handshakes = vi.fn(); listen('editor:extension-loaded', handshakes);
    if (state === 'detached') respond(() => state);
    const result = expect(client.reconnect()).rejects.toMatchObject({ code: 'editor-reconnect-timeout' });
    await vi.advanceTimersByTimeAsync(2000); await result;
    expect(handshakes).toHaveBeenCalledTimes(1);
  });

  it('cancels pending requests and stops automatic activity when its context aborts', async () => {
    vi.useFakeTimers(); const controller = new AbortController(), client = connection(controller.signal), handshakes = vi.fn();
    listen('editor:extension-loaded', handshakes);
    const pending = expect(client.reconnect()).rejects.toMatchObject({ code: 'editor-connection-disposed' });
    await Promise.resolve(); controller.abort(); await pending;
    mountEditor().dispatchEvent(new FocusEvent('focusin', { bubbles: true })); window.dispatchEvent(new Event('pageshow'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(handshakes).toHaveBeenCalledTimes(1);
    await expect(client.reconnect()).rejects.toMatchObject({ code: 'editor-connection-disposed' });
  });

  it('probes on focus but does not reconfigure a healthy editor or react to typing', async () => {
    vi.useFakeTimers(); const content = mountEditor(), client = connection(), handshakes = vi.fn(), probes = vi.fn();
    listen('editor:extension-loaded', handshakes); listen('opt:connection-request', probes); respond(() => 'connected');
    content.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); await vi.advanceTimersByTimeAsync(50);
    expect(probes).toHaveBeenCalledTimes(1); expect(handshakes).not.toHaveBeenCalled();
    for (let n = 0; n < 5; n++) content.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'x' }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(probes).toHaveBeenCalledTimes(1); client.dispose();
  });

  it('coalesces lifecycle events and automatically repairs a missing bridge once', async () => {
    vi.useFakeTimers(); const content = mountEditor(); connection(); let state = 'detached';
    const handshakes = vi.fn(() => { state = 'connected'; }); listen('editor:extension-loaded', handshakes); respond(() => state);
    content.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); window.dispatchEvent(new Event('pageshow'));
    content.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(60); expect(handshakes).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('pageshow'));
    await vi.advanceTimersByTimeAsync(5000); expect(handshakes).toHaveBeenCalledTimes(1);
  });

  it('checks a newly mounted editor after cooldown without a permanent polling loop', async () => {
    vi.useFakeTimers(); const initial = mountEditor(); connection(); let state = 'connected';
    const handshakes = vi.fn(() => { state = 'connected'; }); listen('editor:extension-loaded', handshakes); respond(() => state);
    initial.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); await vi.advanceTimersByTimeAsync(60);
    initial.parentElement!.remove(); mountEditor(); state = 'detached';
    await vi.advanceTimersByTimeAsync(2100); expect(handshakes).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000); expect(handshakes).toHaveBeenCalledTimes(1);
  });
});
