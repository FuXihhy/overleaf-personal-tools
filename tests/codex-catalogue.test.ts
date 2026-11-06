import { describe, expect, it, vi } from 'vitest';
import { CodexCatalogue, type CatalogueState } from '../src/codex/catalogue';
import type { CodexEvent } from '../src/codex/types';

const ready = (): CodexEvent => ({ id: 'status', type: 'status', available: true, authenticated: true,
  connectionKind:'standalone',projectReaderReady:true,
  models: [{ id: 'model-a', displayName: 'Model A', efforts: ['low', 'high'] }] });
describe('automatic model catalogue', () => {
  it('coalesces automatic openings while preserving supported efforts, then expires its cache', async () => {
    let finish!: (event: CodexEvent) => void, now = 0;
    const request = vi.fn(() => new Promise<CodexEvent>(resolve => { finish = resolve; }));
    const updates: CatalogueState[] = [];
    const catalogue = new CodexCatalogue(request, () => false, s => updates.push(s), () => now);
    const first = catalogue.refresh(); const second = catalogue.refresh();
    expect(first).toBe(second); await Promise.resolve(); expect(request).toHaveBeenCalledOnce();
    expect(updates.at(-1)?.loading).toBe(true);
    finish(ready()); await first;
    expect(updates.at(-1)?.models?.[0].efforts).toEqual(['low', 'high']);
    await catalogue.refresh(); expect(request).toHaveBeenCalledOnce();
    now = 300_001; const refreshed = catalogue.refresh(); await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2); finish(ready()); await refreshed;
  });
  it('runs a genuinely fresh manual check inside the cache lifetime and queues one after an older pending check',async()=>{
    const finish:Array<(value:CodexEvent)=>void>=[],updates:CatalogueState[]=[];
    const request=vi.fn(()=>new Promise<CodexEvent>(resolve=>finish.push(resolve)));
    const catalogue=new CodexCatalogue(request,()=>false,state=>updates.push(state),()=>1000);
    const first=catalogue.refresh();await Promise.resolve();
    const forced=catalogue.refresh(true);expect(catalogue.refresh(true)).toBe(forced);
    finish[0](ready());await first;await Promise.resolve();expect(request).toHaveBeenCalledTimes(2);
    finish[1](ready());await forced;expect(updates.at(-1)?.checkedAt).toBe(1000);
    await catalogue.refresh();expect(request).toHaveBeenCalledTimes(2);
    const manual=catalogue.refresh(true);await Promise.resolve();expect(request).toHaveBeenCalledTimes(3);finish[2](ready());await manual;catalogue.destroy();
  });
  it('keeps model discovery distinct from failed project-reader verification',async()=>{
    const updates:CatalogueState[]=[];const catalogue=new CodexCatalogue(async()=>({...ready(),projectReaderReady:false,readerError:'Missing manuscript tools'}),()=>false,state=>updates.push(state));
    await catalogue.refresh();expect(updates.at(-1)).toMatchObject({connection:'connected',models:ready().models,projectReaderReady:false,readerError:'Missing manuscript tools',connectionKind:'standalone'});catalogue.destroy();
  });
  it('does not classify an unregistered project page as an uninstalled native helper',async()=>{
    const updates:CatalogueState[]=[];const catalogue=new CodexCatalogue(async()=>ready(),()=>false,state=>updates.push(state));
    await catalogue.refresh();const healthy=updates.at(-1);
    catalogue.reportFailure(new Error('This project page is not registered. Reconnect and synchronize again.'));
    expect(updates.at(-1)).toBe(healthy);
    catalogue.reportFailure(new Error('Native messaging host is not registered.'));
    expect(updates.at(-1)?.connection).toBe('offline');catalogue.destroy();
  });
  it('defers status while an answer runs and refreshes once that answer ends', async () => {
    let busy = true; const request = vi.fn(async () => ready()); const updates: CatalogueState[] = [];
    const catalogue = new CodexCatalogue(request, () => busy, s => updates.push(s));
    await catalogue.refresh(); await catalogue.refresh(true); catalogue.resume();
    expect(request).not.toHaveBeenCalled(); expect(updates.at(-1)?.loading).toBe(true);
    busy = false; catalogue.resume(); await catalogue.whenIdle();
    expect(request).toHaveBeenCalledOnce(); expect(updates.at(-1)?.loading).toBe(false);
  });
  it('shows unauthenticated and failed discovery, and permits a retry after synchronous failures', async () => {
    const request = vi.fn<() => Promise<CodexEvent>>()
      .mockImplementationOnce(() => { throw new Error('Helper missing'); })
      .mockResolvedValueOnce({ id: 's', type: 'status', available: true, authenticated: false, message: 'Sign in first' })
      .mockResolvedValueOnce(ready());
    const updates: CatalogueState[] = []; const catalogue = new CodexCatalogue(request, () => false, s => updates.push(s));
    await catalogue.refresh(); expect(updates.at(-1)?.error).toBe('Helper missing');
    await catalogue.refresh(); expect(updates.at(-1)?.error).toBe('Sign in first');
    await catalogue.refresh(); expect(updates.at(-1)?.error).toBeUndefined();
    expect(updates.at(-1)?.models).toHaveLength(1);
  });
});

describe('bounded connection recovery', () => {
  it('does not let an older successful status overwrite a newer operation failure',async()=>{
    vi.useFakeTimers();
    try{
      const finish:Array<(value:CodexEvent)=>void>=[],updates:CatalogueState[]=[];
      const request=vi.fn(()=>new Promise<CodexEvent>(resolve=>finish.push(resolve)));
      const catalogue=new CodexCatalogue(request,()=>false,state=>updates.push(state));
      const old=catalogue.refresh();await Promise.resolve();
      catalogue.reportFailure(new Error('Project cache connection lost; source is retained.'));
      expect(updates.at(-1)?.connection).toBe('reconnecting');
      finish[0](ready());await old;expect(updates.at(-1)?.connection).toBe('reconnecting');expect(updates.some(s=>s.connection==='connected')).toBe(false);
      const current=catalogue.refresh();await Promise.resolve();expect(request).toHaveBeenCalledTimes(2);finish[1](ready());await current;
      expect(updates.at(-1)?.connection).toBe('connected');catalogue.destroy();
    }finally{vi.useRealTimers();}
  });
  it('does not start an old queued manual check after a provider reset',async()=>{
    let finish!:(value:CodexEvent)=>void;const request=vi.fn(()=>new Promise<CodexEvent>(resolve=>{finish=resolve;}));
    const catalogue=new CodexCatalogue(request,()=>false,()=>{});const old=catalogue.refresh();await Promise.resolve();const queued=catalogue.refresh(true);
    catalogue.reset();finish(ready());await old;await queued;expect(request).toHaveBeenCalledOnce();catalogue.destroy();
  });
  it('reconnects transient account routing failures and restores Astra without user message replay', async () => {
    vi.useFakeTimers();
    try {
      const updates: CatalogueState[] = [];
      const request = vi.fn().mockResolvedValueOnce({id:'s',type:'status',available:false,authenticated:false,errorCode:'routing_timeout',retryable:true,message:'Account connection timed out'})
        .mockResolvedValue({...ready(),models:[{id:'gpt-6-astra',displayName:'GPT-6-Astra',efforts:['low','medium','high','xhigh','max','ultra']}]});
      const catalogue=new CodexCatalogue(request,()=>false,s=>updates.push(s));
      await catalogue.refresh();expect(updates.at(-1)?.connection).toBe('reconnecting');
      await vi.advanceTimersByTimeAsync(5000);
      expect(request).toHaveBeenCalledTimes(2);expect(updates.at(-1)?.connection).toBe('connected');
      expect(updates.at(-1)?.models?.[0].efforts).toContain('ultra');catalogue.destroy();
    }finally{vi.useRealTimers();}
  });
  it('stops after two automatic attempts and drops stale models on authentication failure', async () => {
    vi.useFakeTimers();
    try {
      const updates:CatalogueState[]=[];const request=vi.fn().mockResolvedValue(ready());
      const catalogue=new CodexCatalogue(request,()=>false,s=>updates.push(s));await catalogue.refresh();
      request.mockResolvedValue({id:'s',type:'status',available:false,authenticated:false,message:'workspace routing discovery timed out',retryable:true});
      await catalogue.refresh(true);expect(updates.at(-1)?.models).toBeUndefined();
      await vi.advanceTimersByTimeAsync(120000);expect(request).toHaveBeenCalledTimes(4);expect(updates.at(-1)?.connection).toBe('offline');
      request.mockResolvedValue({id:'s',type:'status',available:true,authenticated:false,errorCode:'auth_required',retryable:false,message:'Sign in'});
      await catalogue.refresh(true);await vi.advanceTimersByTimeAsync(120000);expect(request).toHaveBeenCalledTimes(5);expect(updates.at(-1)?.connection).toBe('auth-required');catalogue.destroy();
    }finally{vi.useRealTimers();}
  });
  it('defers recovery during generation or hidden pages and cancels on reset/dispose', async () => {
    vi.useFakeTimers();
    try {
      let active=true,busy=false;const updates:CatalogueState[]=[];
      const request=vi.fn().mockRejectedValue(new Error('workspace routing discovery timed out'));
      const catalogue=new CodexCatalogue(request,()=>busy,s=>updates.push(s),Date.now,()=>active);
      await catalogue.refresh();active=false;await vi.advanceTimersByTimeAsync(5000);expect(request).toHaveBeenCalledOnce();
      active=true;busy=true;catalogue.resume();expect(request).toHaveBeenCalledOnce();
      busy=false;catalogue.resume();await catalogue.whenIdle();expect(request).toHaveBeenCalledTimes(2);
      catalogue.reset();await vi.advanceTimersByTimeAsync(60000);expect(request).toHaveBeenCalledTimes(2);
      catalogue.destroy();await catalogue.refresh(true);expect(request).toHaveBeenCalledTimes(2);
    }finally{vi.useRealTimers();}
  });
  it('ignores a previous provider response after reset',async()=>{
    let finish!:(event:CodexEvent)=>void;const updates:CatalogueState[]=[];
    const catalogue=new CodexCatalogue(()=>new Promise(resolve=>{finish=resolve;}),()=>false,s=>updates.push(s));
    const old=catalogue.refresh();await Promise.resolve();catalogue.reset();finish(ready());await old;
    expect(updates.at(-1)).toEqual({loading:false,connection:'unknown'});
  });
});
