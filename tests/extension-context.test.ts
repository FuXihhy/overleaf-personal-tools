import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExtensionContext } from '../src/extension-context';

afterEach(() => vi.unstubAllGlobals());

describe('content extension context lifetime', () => {
  it('checks the runtime identity without waking or requiring a service worker', () => {
    const getURL=vi.fn((path:string)=>'chrome-extension://test/'+path);
    vi.stubGlobal('chrome',{runtime:{id:'test',getURL}});
    const context=createExtensionContext();
    expect(context.alive()).toBe(true);
    expect(context.signal.aborted).toBe(false);
    expect(context.reason).toBeUndefined();
    expect(context.assetURL('renderer.js')).toBe('chrome-extension://test/renderer.js');
    expect(getURL).toHaveBeenCalledTimes(1);
  });

  it.each([undefined,{}, {runtime:{}}, {runtime:{id:undefined}}])('retires once when the runtime identity disappears: %j', value => {
    vi.stubGlobal('chrome',value);
    const context=createExtensionContext();
    const cleanup=vi.fn();context.signal.addEventListener('abort',cleanup);
    expect(context.alive()).toBe(false);
    expect(context.signal.aborted).toBe(true);
    expect(context.reason).toBe('extension-updated');
    vi.stubGlobal('chrome',{runtime:{id:'replacement',getURL:vi.fn()}});
    expect(context.alive()).toBe(false);
    expect(context.assetURL('renderer.js')).toBeUndefined();
    context.invalidate();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(chrome.runtime.getURL).not.toHaveBeenCalled();
  });

  it('handles invalidated property getters and synchronous asset lookup failures', () => {
    vi.stubGlobal('chrome',{get runtime(){throw new Error('Extension context invalidated.');}});
    expect(createExtensionContext().alive()).toBe(false);
    const getURL=vi.fn(()=>{throw new Error('Extension context invalidated.');});
    vi.stubGlobal('chrome',{runtime:{id:'test',getURL}});
    const context=createExtensionContext();
    expect(context.assetURL('avatar.png')).toBeUndefined();
    expect(context.signal.aborted).toBe(true);
    expect(context.reason).toBe('extension-updated');
    expect(context.assetURL('avatar.png')).toBeUndefined();
    expect(getURL).toHaveBeenCalledTimes(1);
  });

  it('does not retire a valid content script for a transient resource lookup error', () => {
    const getURL = vi.fn().mockImplementationOnce(() => { throw new Error('Resource lookup failed'); }).mockReturnValue('chrome-extension://test/renderer.js');
    vi.stubGlobal('chrome', { runtime: { id: 'test', getURL } });
    const context = createExtensionContext();
    expect(context.assetURL('renderer.js')).toBeUndefined();
    expect(context.alive()).toBe(true);
    expect(context.signal.aborted).toBe(false);
    expect(context.assetURL('renderer.js')).toBe('chrome-extension://test/renderer.js');
  });

  it.each(['pagehide', 'manual'] as const)('records %s teardown without mislabelling it as an extension update', reason => {
    vi.stubGlobal('chrome', { runtime: { id: 'test' } });
    const context = createExtensionContext(), observed: string[] = [];
    context.signal.addEventListener('abort', () => { observed.push(context.reason!); context.invalidate('extension-updated'); });
    if (reason === 'manual') context.invalidate(); else context.invalidate(reason);
    expect(context.alive()).toBe(false);
    expect(context.reason).toBe(reason); expect(context.signal.reason).toBe(reason);
    expect(observed).toEqual([reason]);
  });
});
