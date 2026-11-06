import {afterEach,describe,it,expect,vi} from 'vitest';
import {CodexHistorySync} from '../src/codex/history-sync';
afterEach(()=>vi.useRealTimers());
describe('visible conversation synchronization',()=>{
  it('releases the busy flag before resuming deferred native work',async()=>{
    const events:string[]=[];
    const sync=new CodexHistorySync({enabled:()=>true,available:()=>true,read:async()=>{events.push('read');},failed:vi.fn(),settled:()=>{expect(sync.busy).toBe(false);events.push('settled');}});
    sync.trigger();await sync.whenIdle();expect(events).toEqual(['read','settled']);sync.destroy();
  });
  it('does not overlap reads and stops polling when the panel is hidden',async()=>{
    vi.useFakeTimers();let enabled=true,finish!:()=>void;
    const read=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));
    const sync=new CodexHistorySync({enabled:()=>enabled,available:()=>true,read,failed:vi.fn()});
    sync.trigger();await Promise.resolve();sync.trigger();await vi.advanceTimersByTimeAsync(15000);
    expect(read).toHaveBeenCalledOnce();finish();await sync.whenIdle();
    await vi.advanceTimersByTimeAsync(5000);expect(read).toHaveBeenCalledTimes(2);
    enabled=false;finish();await sync.whenIdle();await vi.advanceTimersByTimeAsync(30000);expect(read).toHaveBeenCalledTimes(2);
    sync.destroy();expect(vi.getTimerCount()).toBe(0);
  });
  it('defers behind native work, recovers after failure, and retires without further callbacks',async()=>{
    vi.useFakeTimers();let available=false;
    const read=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined),failed=vi.fn();
    const sync=new CodexHistorySync({enabled:()=>true,available:()=>available,read,failed});
    sync.trigger();await vi.advanceTimersByTimeAsync(5000);expect(read).not.toHaveBeenCalled();
    available=true;sync.trigger();await sync.whenIdle();expect(failed).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5000);expect(read).toHaveBeenCalledTimes(2);
    sync.destroy();await vi.advanceTimersByTimeAsync(10000);expect(read).toHaveBeenCalledTimes(2);
  });
});
