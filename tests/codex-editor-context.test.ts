// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { captureEditorContext } from '../src/codex/editor-context';

const listeners: EventListener[] = [];
function respond(handler: (id: string, attempt: number) => unknown) {
  let attempt = 0;
  const listener: EventListener = event => {
    const { id } = JSON.parse((event as CustomEvent<string>).detail);
    const reply = handler(id, ++attempt);
    if (reply !== undefined) window.dispatchEvent(new CustomEvent('opt:document-context-result', { detail: JSON.stringify(reply) }));
  };
  window.addEventListener('opt:request-document-context', listener); listeners.push(listener);
  return () => attempt;
}
function capture(overrides: Partial<Parameters<typeof captureEditorContext>[0]> = {}) {
  return captureEditorContext({ path: 'main.tex', selectedPath: () => 'main.tex', current: () => true, signal: new AbortController().signal, ...overrides });
}
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('crypto', webcrypto); });
afterEach(() => {
  for (const listener of listeners.splice(0)) window.removeEventListener('opt:request-document-context', listener);
  vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('verified editor context capture', () => {
  it('returns exact source without waiting when native identity is already verified', async () => {
    const attempts = respond(id => ({ id, ok: true, name: 'main.tex', text: 'Full source including \\cN' }));
    await expect(capture()).resolves.toEqual({ path: 'main.tex', content: 'Full source including \\cN' });
    await vi.advanceTimersByTimeAsync(2000); expect(attempts()).toBe(1);
  });
  it('retries pending native transitions and takes the verified buffer once it loads', async () => {
    const attempts = respond((id, attempt) => attempt < 3 ? { id, ok: false, pending: true } : { id, ok: true, name: 'main.tex', text: 'Newly loaded source' });
    const result = capture();
    await vi.advanceTimersByTimeAsync(400);
    await expect(result).resolves.toEqual({ path: 'main.tex', content: 'Newly loaded source' });
    await vi.advanceTimersByTimeAsync(2000); expect(attempts()).toBe(3);
  });
  it('never treats a mismatched document as the selected file and bounds repeated pending replies', async () => {
    const attempts = respond(id => ({ id, ok: true, name: 'old.tex', text: 'Private old source' }));
    const result = capture(); await vi.advanceTimersByTimeAsync(1500);
    await expect(result).resolves.toBeUndefined();
    expect(attempts()).toBe(8);
    await vi.advanceTimersByTimeAsync(2000); expect(attempts()).toBe(8);
  });
  it('allows fresh server export when no bridge response arrives', async () => {
    const attempts = respond(() => undefined);
    const result = capture(); await vi.advanceTimersByTimeAsync(1500);
    await expect(result).resolves.toBeUndefined(); expect(attempts()).toBe(1);
  });
  it('discards a reply when the user switched files after the request', async () => {
    let selected = 'main.tex';
    respond(id => { selected = 'other.tex'; return { id, ok: true, name: 'main.tex', text: 'Previously active' }; });
    const result = capture({ selectedPath: () => selected }); await vi.advanceTimersByTimeAsync(200);
    await expect(result).resolves.toBeUndefined();
  });
  it('does not admit unrelated replies, unsafe paths or oversized text', async () => {
    respond((id, attempt) => ({ id: attempt === 1 ? 'unrelated' : id, ok: true, name: '../main.tex', text: 'ignored' }));
    const result = capture(); await vi.advanceTimersByTimeAsync(1500); await expect(result).resolves.toBeUndefined();
    listeners.forEach(listener => window.removeEventListener('opt:request-document-context', listener)); listeners.length = 0;
    respond(id => ({ id, ok: true, name: 'main.tex', text: 'x'.repeat(2_000_001) }));
    const oversized = capture(); await vi.advanceTimersByTimeAsync(1500); await expect(oversized).resolves.toBeUndefined();
  });
  it('cancels immediately on abort and leaves no retry running', async () => {
    const controller = new AbortController();
    const attempts = respond(id => ({ id, ok: false, pending: true }));
    const result = capture({ signal: controller.signal });
    const rejected = expect(result).rejects.toThrow('cancelled'); controller.abort(); await rejected;
    await vi.advanceTimersByTimeAsync(2000); expect(attempts()).toBe(1);
  });
  it('does not request source from an already cancelled page', async () => {
    const controller = new AbortController(); controller.abort();
    const attempts = respond(id => ({ id, ok: false, pending: true }));
    await expect(capture({ signal: controller.signal })).rejects.toThrow('cancelled'); expect(attempts()).toBe(0);
  });
  it('rejects rather than falling back if the conversation changes during the capture', async () => {
    let current = true; respond(id => ({ id, ok: false, pending: true }));
    const result = capture({ current: () => current }); const rejected = expect(result).rejects.toThrow('cancelled');
    current = false; await vi.advanceTimersByTimeAsync(200); await rejected;
  });
});
