import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexCacheFreshness } from '../src/codex/cache-freshness';

const files = [{ path: 'main.tex', content: 'Initial source' }, { path: 'defs/macros.tex', content: 'Macros' }];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => vi.useRealTimers());

describe('project cache freshness hints', () => {
  it('does not warn before a successful synchronization or merely because it ages', async () => {
    const changed = vi.fn(), tracker = new CodexCacheFreshness({ changed });
    tracker.observe('main.tex', 'Changed before synchronization');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(changed).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    tracker.synced(files, tracker.beginSync());
    await vi.advanceTimersByTimeAsync(600_000); tracker.refresh();
    expect(changed).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('warns once at five minutes when observed source differs', async () => {
    const changed = vi.fn(), tracker = new CodexCacheFreshness({ changed });
    tracker.synced(files, tracker.beginSync());
    tracker.observe('main.tex', 'Changed source');
    await vi.advanceTimersByTimeAsync(299_999); expect(changed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(changed).toHaveBeenCalledExactlyOnceWith(true);
    tracker.observe('main.tex', 'Another change'); tracker.refresh();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(changed).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it('does not interpret the first observation of an unchanged file as an edit', async () => {
    const changed = vi.fn(), tracker = new CodexCacheFreshness({ changed });
    tracker.synced(files, tracker.beginSync()); await vi.advanceTimersByTimeAsync(300_000);
    tracker.observe('defs/macros.tex', 'Macros'); tracker.observe('main.tex', 'Initial source');
    expect(changed).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    tracker.observe('defs/macros.tex', 'Different macros');
    expect(changed).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('clears a reminder when every edited file returns to the synchronized content', async () => {
    const changed = vi.fn(), tracker = new CodexCacheFreshness({ changed });
    tracker.synced(files, tracker.beginSync()); await vi.advanceTimersByTimeAsync(300_000);
    tracker.observe('main.tex', 'Changed'); tracker.observe('defs/macros.tex', 'Changed');
    tracker.observe('main.tex', 'Initial source'); expect(changed.mock.calls).toEqual([[true]]);
    tracker.observe('defs/macros.tex', 'Macros'); expect(changed.mock.calls).toEqual([[true], [false]]);
    tracker.refresh(); expect(changed).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps edits observed during capture dirty without warning until the new sync ages', async () => {
    const changed = vi.fn(), tracker = new CodexCacheFreshness({ changed });
    tracker.observe('main.tex', 'Initial source');
    const boundary = tracker.beginSync();
    tracker.observe('main.tex', 'Edited while downloading');
    tracker.synced(files, boundary);
    await vi.advanceTimersByTimeAsync(299_999); expect(changed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(changed).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('does not retain a capture-time observation that the final source already includes', async () => {
    const changed = vi.fn(), tracker = new CodexCacheFreshness({ changed });
    const boundary = tracker.beginSync(); tracker.observe('main.tex', 'Included latest text');
    tracker.synced([{ path: 'main.tex', content: 'Included latest text' }], boundary);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(changed).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('discards stale visited buffers when a newer collaborative export completes', async () => {
    const changed = vi.fn(), tracker = new CodexCacheFreshness({ changed });
    tracker.observe('main.tex', 'Old visited buffer');
    tracker.observe('defs/macros.tex', 'Old visited macros');
    tracker.synced(files, tracker.beginSync());
    await vi.advanceTimersByTimeAsync(600_000); tracker.refresh();
    expect(changed).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    tracker.observe('main.tex', 'Initial source'); expect(changed).not.toHaveBeenCalled();
  });

  it('successful synchronization clears a current reminder and resets its age', async () => {
    const changed = vi.fn(), tracker = new CodexCacheFreshness({ changed });
    tracker.synced(files, tracker.beginSync()); tracker.observe('main.tex', 'New text');
    await vi.advanceTimersByTimeAsync(300_000); expect(changed.mock.calls).toEqual([[true]]);
    tracker.synced([{ path: 'main.tex', content: 'New text' }], tracker.beginSync());
    expect(changed.mock.calls).toEqual([[true], [false]]);
    tracker.observe('main.tex', 'Newer text');
    await vi.advanceTimersByTimeAsync(299_999); expect(changed).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(changed.mock.calls).toEqual([[true], [false], [true]]);
  });

  it('refresh evaluates current time after timer throttling and respects a custom clock', () => {
    let now = 1000;
    const changed = vi.fn(), tracker = new CodexCacheFreshness({ changed, now: () => now, staleAfterMs: 100 });
    tracker.synced(files, tracker.beginSync()); tracker.observe('main.tex', 'Changed');
    now = 1099; tracker.refresh(); expect(changed).not.toHaveBeenCalled();
    now = 1100; tracker.refresh(); expect(changed).toHaveBeenCalledExactlyOnceWith(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retirement cancels scheduled reminders and ignores late updates', async () => {
    const changed = vi.fn(), tracker = new CodexCacheFreshness({ changed });
    tracker.synced(files, tracker.beginSync()); tracker.observe('main.tex', 'Changed');
    expect(vi.getTimerCount()).toBe(1); tracker.destroy(); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(600_000);
    tracker.observe('main.tex', 'Later'); tracker.synced(files, 0); tracker.refresh();
    expect(changed).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels its age timer when text is reverted before the threshold', async () => {
    const changed = vi.fn(), tracker = new CodexCacheFreshness({ changed });
    tracker.synced(files, tracker.beginSync()); tracker.observe('main.tex', 'Changed');
    await vi.advanceTimersByTimeAsync(10_000); tracker.observe('main.tex', 'Initial source');
    expect(vi.getTimerCount()).toBe(0); await vi.advanceTimersByTimeAsync(600_000);
    expect(changed).not.toHaveBeenCalled();
  });
});
