import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexSourceGuard } from '../src/codex/source-guard';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
afterEach(() => vi.useRealTimers());

describe('immutable source snapshot guard', () => {
  it('does not repair a verified snapshot and checks again at the configured interval', async () => {
    vi.useFakeTimers();
    const check = vi.fn(async () => true), repair = vi.fn(), failed = vi.fn();
    const guard = new CodexSourceGuard({ check, repair, failed, current: () => true });
    await guard.ensure(); guard.start(); guard.start();
    await vi.advanceTimersByTimeAsync(4999); expect(check).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(check).toHaveBeenCalledTimes(2);
    expect(repair).not.toHaveBeenCalled(); expect(failed).not.toHaveBeenCalled();
    guard.stop(); expect(vi.getTimerCount()).toBe(0);
  });

  it('repairs missing bytes then verifies the original snapshot before continuing', async () => {
    const events: string[] = [];
    const check = vi.fn().mockImplementationOnce(async () => { events.push('missing'); return false; })
      .mockImplementationOnce(async () => { events.push('verified'); return true; });
    const repair = vi.fn(async () => { events.push('repair'); });
    const guard = new CodexSourceGuard({ check, repair, failed: vi.fn(), current: () => true });
    await guard.ensure();
    expect(events).toEqual(['missing', 'repair', 'verified']);
    expect(check).toHaveBeenCalledTimes(2); expect(repair).toHaveBeenCalledOnce();
  });

  it('does not interpret a network failure as source damage or attempt repair', async () => {
    vi.useFakeTimers();
    const error = new Error('Transport disconnected');
    const check = vi.fn(async (): Promise<boolean> => { throw error; }), repair = vi.fn(), failed = vi.fn();
    const guard = new CodexSourceGuard({ check, repair, failed, current: () => true });
    await expect(guard.ensure()).rejects.toBe(error);
    guard.start(); await vi.advanceTimersByTimeAsync(5000);
    expect(failed).toHaveBeenCalledExactlyOnceWith(error); expect(repair).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30000); guard.start(); await vi.advanceTimersByTimeAsync(10000);
    expect(check).toHaveBeenCalledTimes(2); expect(failed).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails after one unsuccessful repair instead of substituting a newer source version', async () => {
    vi.useFakeTimers();
    const check = vi.fn(async () => false), repair = vi.fn(async () => ({ snapshotId: 'different-version' })), failed = vi.fn();
    const guard = new CodexSourceGuard({ check, repair, failed, current: () => true });
    guard.start(); await vi.advanceTimersByTimeAsync(5000);
    expect(check).toHaveBeenCalledTimes(2); expect(repair).toHaveBeenCalledOnce();
    expect(failed.mock.calls[0][0].message).toContain('original source version cannot be restored');
    await vi.advanceTimersByTimeAsync(30000); expect(repair).toHaveBeenCalledOnce();
  });

  it('shares a single in-flight check and repair between manual preflight and polling', async () => {
    vi.useFakeTimers();
    const first = deferred<boolean>(), repairing = deferred<void>();
    const check = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(true);
    const repair = vi.fn(() => repairing.promise), failed = vi.fn();
    const guard = new CodexSourceGuard({ check, repair, failed, current: () => true });
    const a = guard.ensure(), b = guard.ensure(); expect(a).toBe(b);
    guard.start(); await vi.advanceTimersByTimeAsync(15000);
    expect(check).toHaveBeenCalledOnce(); expect(repair).not.toHaveBeenCalled();
    first.resolve(false); await Promise.resolve(); await Promise.resolve();
    expect(repair).toHaveBeenCalledOnce(); expect(guard.ensure()).toBe(a);
    repairing.resolve(); await a; await b;
    expect(check).toHaveBeenCalledTimes(2); expect(failed).not.toHaveBeenCalled();
    guard.stop();
  });

  it.each(['stop', 'current'] as const)('does not launch repair after %s invalidates a pending check', async mode => {
    const pending = deferred<boolean>(); let current = true;
    const check = vi.fn(() => pending.promise), repair = vi.fn(), failed = vi.fn();
    const guard = new CodexSourceGuard({ check, repair, failed, current: () => current });
    const result = guard.ensure(); const rejected = expect(result).rejects.toThrow('cancelled');
    await Promise.resolve();
    if (mode === 'stop') guard.stop(); else current = false;
    pending.resolve(false); await rejected;
    expect(repair).not.toHaveBeenCalled(); expect(failed).not.toHaveBeenCalled();
    await expect(guard.ensure()).rejects.toThrow('cancelled');
  });

  it('suppresses late rechecks and notifications when stopped during repair', async () => {
    vi.useFakeTimers();
    const repairing = deferred<void>(), check = vi.fn(async () => false), repair = vi.fn(() => repairing.promise), failed = vi.fn();
    const guard = new CodexSourceGuard({ check, repair, failed, current: () => true });
    guard.start(); await vi.advanceTimersByTimeAsync(5000);
    expect(repair).toHaveBeenCalledOnce(); guard.stop(); repairing.resolve();
    await vi.advanceTimersByTimeAsync(15000);
    expect(check).toHaveBeenCalledOnce(); expect(failed).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('reports cancellation to a waiting preflight when a stopped request rejects late', async () => {
    const pending = deferred<boolean>(), repair = vi.fn();
    const guard = new CodexSourceGuard({ check: () => pending.promise, repair, failed: vi.fn(), current: () => true });
    const result = guard.ensure(); const rejected = expect(result).rejects.toThrow('cancelled');
    await Promise.resolve(); guard.stop(); pending.reject(new Error('Late disconnect'));
    await rejected; expect(repair).not.toHaveBeenCalled();
  });

  it('allows at most two successful repair attempts over its lifetime', async () => {
    const check = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false).mockResolvedValueOnce(true).mockResolvedValue(false);
    const repair = vi.fn(async () => undefined);
    const guard = new CodexSourceGuard({ check, repair, failed: vi.fn(), current: () => true });
    await guard.ensure(); await guard.ensure();
    await expect(guard.ensure()).rejects.toThrow('original source version cannot be restored');
    expect(repair).toHaveBeenCalledTimes(2); expect(check).toHaveBeenCalledTimes(5);
  });
});
