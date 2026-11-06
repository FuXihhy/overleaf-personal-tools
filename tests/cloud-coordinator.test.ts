import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSharedCloudState, withSharedCloudLock, type SharedCloudSession } from '../src/preview/cloud-coordinator';

const ACCOUNT = 'aaaaaaaaaaaaaaaaaaaaaaaa';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const granted = () => ({ ok: true, granted: true, token: 'owner-token', activeUntil: Date.now() + 30_000, state: {} });

describe('shared cloud coordinator client', () => {
  it('reads metadata without acquiring a lock or creating a project', async () => {
    const send = vi.fn(async () => ({ ok: true, state: { nextCompileAt: 42 } }));
    expect(await readSharedCloudState(ACCOUNT, { send })).toEqual({ nextCompileAt: 42 });
    expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ op: 'read', accountId: ACCOUNT }));
  });

  it('cancels a queued stale formula without running it', async () => {
    let current = true;
    const send = vi.fn(async (message: Record<string, unknown>) => message.op === 'acquire' ? { ok: true, granted: false } : { ok: true });
    const operation = vi.fn();
    await expect(withSharedCloudLock(ACCOUNT, () => current, operation, { send, pause: async () => { current = false; } })).rejects.toMatchObject({ name: 'AbortError' });
    expect(operation).not.toHaveBeenCalled();
    expect(send.mock.calls.map(([message]) => message.op)).toEqual(['acquire', 'cancel']);
  });

  it('does not release while an in-flight operation remains pending after selection changes', async () => {
    vi.useFakeTimers();
    let current = true, finish!: () => void;
    const send = vi.fn(async (message: Record<string, unknown>) => message.op === 'acquire' ? granted() : { ok: true, activeUntil: Date.now() + 30_000 });
    let session!: SharedCloudSession;
    const result = withSharedCloudLock(ACCOUNT, () => current, async value => { session = value; await new Promise<void>(resolve => { finish = resolve; }); return 7; }, { send });
    await vi.advanceTimersByTimeAsync(0);
    current = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(session.alive()).toBe(true);
    expect(send.mock.calls.map(([message]) => message.op)).toEqual(['acquire', 'renew']);
    // Ownership checks and journal saves remain possible for completed uploads.
    await session.checkpoint(); await session.saveState({ nextCompileAt: 17 });
    finish(); expect(await result).toBe(7);
    expect(send.mock.calls.at(-1)?.[0]).toMatchObject({ op: 'release', uncertain: false });
    const count = send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100_000);
    expect(send).toHaveBeenCalledTimes(count);
  });

  it('loses its token permanently after renewal denial and leaves persisted quarantine intact', async () => {
    const send = vi.fn(async (message: Record<string, unknown>) => message.op === 'acquire' ? granted() : { ok: false, error: 'stale token' });
    await expect(withSharedCloudLock(ACCOUNT, () => true, async session => {
      await expect(session.checkpoint()).rejects.toThrow('stale token');
      expect(session.alive()).toBe(false);
      await session.saveState({});
    }, { send })).rejects.toMatchObject({ name: 'AbortError' });
    expect(send.mock.calls.map(([message]) => message.op)).toEqual(['acquire', 'renew', 'release']);
  });

  it('reports uncertain network outcome when releasing and propagates the original failure', async () => {
    const send = vi.fn(async (message: Record<string, unknown>) => message.op === 'acquire' ? granted() : { ok: true });
    await expect(withSharedCloudLock(ACCOUNT, () => true, async session => { session.quarantine(); throw new Error('fetch timed out'); }, { send })).rejects.toThrow('fetch timed out');
    expect(send.mock.calls.at(-1)?.[0]).toMatchObject({ op: 'release', uncertain: true });
  });

  it('stops synchronous work after a local lease deadline even if heartbeat was throttled', async () => {
    let time = 1000;
    const send = vi.fn(async (message: Record<string, unknown>) => message.op === 'acquire' ? { ...granted(), activeUntil: 31_000 } : { ok: true });
    await withSharedCloudLock(ACCOUNT, () => true, async session => {
      time = 31_001;
      expect(session.alive()).toBe(false);
      await expect(session.checkpoint()).rejects.toMatchObject({ name: 'AbortError' });
    }, { send, now: () => time });
    expect(send.mock.calls.map(([message]) => message.op)).toEqual(['acquire', 'release']);
  });

  it('handles an asynchronous invalidated Chrome runtime without an uncaught callback error', async () => {
    let callback!: (value: unknown) => void;
    const runtime = { sendMessage: vi.fn((_message, handler) => { callback = handler; }), get lastError(): never { throw new Error('Extension context invalidated'); } };
    vi.stubGlobal('chrome', { runtime });
    const result = readSharedCloudState(ACCOUNT);
    const rejected = expect(result).rejects.toThrow('Extension context invalidated');
    callback({}); await rejected;
  });
});
