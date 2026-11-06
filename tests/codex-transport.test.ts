import { afterEach, describe, expect, it, vi } from 'vitest';
import { allowedNativeSender } from '../src/background';
import { registerCodexHistory, registerCodexTransport } from '../src/codex/background';
import { CodexClient } from '../src/codex/client';
import { CODEX_NATIVE_HOST, CODEX_PORT } from '../src/codex/types';

const EXTENSION = 'pffppbkokpnfafpechmlambifflkmbbn';
const PROJECT = '0123456789abcdef01234567';
const ACCOUNT = 'abcdef0123456789abcdef01';
const sender = (): chrome.runtime.MessageSender => ({ id: EXTENSION, tab: { id: 1 } as chrome.tabs.Tab, frameId: 0, url: `https://www.overleaf.com/project/${PROJECT}` });
const request = (id = 'ask-1', op = 'ask') => ({ version: 1, id, op, projectId: PROJECT, ...(op === 'ask' ? { question: 'Explain this.' } : {}) });
class Port {
  name = CODEX_PORT;
  sender = sender();
  autoDisconnect = true;
  private messages = new Set<(message: unknown) => void>();
  private disconnections = new Set<() => void>();
  onMessage = { addListener: (fn: (message: unknown) => void) => this.messages.add(fn) };
  onDisconnect = { addListener: (fn: () => void) => this.disconnections.add(fn) };
  postMessage = vi.fn();
  disconnect = vi.fn(() => { if (this.autoDisconnect) this.disconnected(); });
  receive(value: unknown) { for (const fn of this.messages) fn(value); }
  disconnected() { for (const fn of this.disconnections) fn(); }
  chrome() { return this as unknown as chrome.runtime.Port; }
}
function broker() {
  let connect!: (port: chrome.runtime.Port) => void;
  const native: Port[] = [];
  const runtime = {
    id: EXTENSION,
    onConnect: { addListener: vi.fn((fn: typeof connect) => { connect = fn; }), removeListener: vi.fn() },
    connectNative: vi.fn(() => { const p = new Port(); native.push(p); return p.chrome(); }),
    lastError: undefined as chrome.runtime.LastError | undefined,
  };
  const stop = registerCodexTransport(runtime as unknown as typeof chrome.runtime, allowedNativeSender);
  const open = (origin = sender()) => { const port = new Port(); port.sender = origin; connect(port.chrome()); return port; };
  return { runtime, native, stop, open };
}
function clientHarness() {
  const ports: Port[] = [];
  const runtime = { connect: vi.fn(() => { const port = new Port(); ports.push(port); return port.chrome(); }), lastError: undefined as chrome.runtime.LastError | undefined };
  vi.stubGlobal('chrome', { runtime });
  return { ports, runtime, client: new CodexClient(PROJECT, ACCOUNT) };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Codex native broker', () => {
  it('uploads source chunks beside an active answer without holding or releasing its turn lock', () => {
    vi.useFakeTimers(); const h=broker(),port=h.open(),uploadId='12345678-1234-4234-8234-123456789abc';
    port.receive(request('answer'));
    for(let index=0;index<6;index++){
      const chunk={...request(`chunk-${index}`,'source-chunk'),uploadId,path:'main.tex',offset:index,content:'x'};
      port.receive(chunk);expect(h.native[0].postMessage).toHaveBeenLastCalledWith(chunk);
      h.native[0].receive({id:chunk.id,type:'source',uploadId});expect(port.postMessage).toHaveBeenLastCalledWith({id:chunk.id,type:'source',uploadId});
    }
    expect(vi.getTimerCount()).toBe(1);const second=h.open();second.receive(request('overlap'));expect(second.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({id:'overlap',type:'error'}));
    h.native[0].receive({id:'answer',type:'done',text:'Final'});expect(vi.getTimerCount()).toBe(0);h.stop();
  });
  it('keeps the active answer connected if a queued source upload times out', async () => {
    vi.useFakeTimers();const h=broker(),port=h.open();port.receive(request('answer'));
    port.receive({...request('upload','source-commit'),uploadId:'12345678-1234-4234-8234-123456789abc'});
    await vi.advanceTimersByTimeAsync(55_000);
    expect(port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({id:'upload',type:'error',message:expect.stringContaining('source synchronization timed out')}));
    expect(h.native[0].disconnect).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(1);
    const before=port.postMessage.mock.calls.length;h.native[0].receive({id:'upload',type:'source',snapshotId:'ab'.repeat(32)});expect(port.postMessage).toHaveBeenCalledTimes(before);
    h.native[0].receive({id:'answer',type:'delta',text:'Still answering'});expect(port.postMessage).toHaveBeenLastCalledWith({id:'answer',type:'delta',text:'Still answering'});h.stop();
  });
  it('settles history pages and holds the project lock during a conversation switch', async () => {
    vi.useFakeTimers();const h=broker(),first=h.open(),second=h.open();
    const conversationId='01a18cbd-8295-7070-8093-1902e8a20546';
    first.receive({...request('select','history-select'),conversationId});
    second.receive(request('overlap'));
    expect(second.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({id:'overlap',type:'error'}));
    h.native[0].receive({id:'select',type:'history',conversationId,messages:[]});
    expect(vi.getTimerCount()).toBe(0);
    second.receive(request('next'));
    expect(h.native[1].postMessage).toHaveBeenLastCalledWith(request('next'));
    h.stop();
  });
  it('rejects unrelated origins, frames and projects before native startup', () => {
    const h = broker();
    for (const origin of [{ ...sender(), id: 'other' }, { ...sender(), frameId: 1 }, { ...sender(), url: `https://www.overleaf.com.evil.test/project/${PROJECT}` }]) {
      expect(h.open(origin).disconnect).toHaveBeenCalledOnce();
    }
    const port = h.open(); port.receive({ ...request(), projectId: 'aaaaaaaaaaaaaaaaaaaaaaaa' });
    expect(port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'error' }));
    port.receive({ ...request(), files: [{ path: '../private.tex', content: 'data' }] });
    expect(h.runtime.connectNative).not.toHaveBeenCalled(); h.stop();
  });

  it('forwards bounded stream events only for pending requests and retains its native connection', () => {
    const h = broker(), port = h.open(); port.receive(request());
    expect(h.runtime.connectNative).toHaveBeenCalledWith(CODEX_NATIVE_HOST);
    expect(h.native[0].postMessage).toHaveBeenCalledWith(request());
    h.native[0].receive({ id: 'unrelated', type: 'delta', text: 'wrong answer' });
    h.native[0].receive({ id: 'ask-1', type: 'delta', text: 42 });
    expect(port.postMessage).not.toHaveBeenCalled();
    h.native[0].receive({ id: 'ask-1', type: 'delta', text: 'Answer', hiddenDebug: 'private' });
    expect(port.postMessage).toHaveBeenLastCalledWith({ id: 'ask-1', type: 'delta', text: 'Answer' });
    h.native[0].receive({ id: 'ask-1', type: 'done', text: 'Answer' });
    const count = port.postMessage.mock.calls.length;
    h.native[0].receive({ id: 'ask-1', type: 'delta', text: 'late' });
    expect(port.postMessage).toHaveBeenCalledTimes(count);
    expect(h.native[0].disconnect).not.toHaveBeenCalled();
    port.receive(request('ask-2')); expect(h.native).toHaveLength(1); h.stop();
  });

  it('blocks a duplicate turn but allows a cancel message alongside an active turn', () => {
    const h = broker(), port = h.open(); port.receive(request()); port.receive(request('ask-2'));
    expect(port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'ask-2', type: 'error' }));
    port.receive(request('cancel-1', 'cancel'));
    expect(h.native[0].postMessage).toHaveBeenLastCalledWith(request('cancel-1', 'cancel'));
    h.stop();
  });

  it('holds a project turn across tabs until the original ask ends, including after cancel acknowledgement', () => {
    const h = broker(), first = h.open(), second = h.open();
    first.receive(request('first'));
    second.receive(request('new', 'new-chat'));
    expect(second.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'new', type: 'error' }));
    expect(h.native).toHaveLength(1);
    second.receive(request('check', 'status'));
    expect(h.native).toHaveLength(2);
    h.native[1].receive({ id: 'check', type: 'status', available: true });
    first.receive(request('cancel', 'cancel'));
    h.native[0].receive({ id: 'cancel', type: 'done' });
    second.receive(request('still-busy'));
    expect(second.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'still-busy', type: 'error' }));
    h.native[0].receive({ id: 'first', type: 'done', text: 'Partial response' });
    second.receive(request('second'));
    expect(h.native[1].postMessage).toHaveBeenLastCalledWith(request('second'));
    second.disconnected();
    first.receive(request('fresh', 'new-chat'));
    expect(h.native[0].postMessage).toHaveBeenLastCalledWith(request('fresh', 'new-chat'));
    h.stop();
  });

  it('allows separate projects to answer concurrently', () => {
    const h = broker(), first = h.open(); first.receive(request('first'));
    const otherProject = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const second = h.open({ ...sender(), url: `https://www.overleaf.com/project/${otherProject}` });
    second.receive({ ...request('second'), projectId: otherProject });
    expect(h.native).toHaveLength(2);
    expect(h.native[1].postMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 'second', projectId: otherProject }));
    h.stop();
  });

  it('disconnects native work with the originating tab and reports bounded native failures', () => {
    const h = broker(), port = h.open(); port.receive(request()); port.disconnected();
    expect(h.native[0].disconnect).toHaveBeenCalledOnce();
    const other = h.open(); other.receive(request('status', 'status'));
    h.runtime.lastError = { message: 'Native host not installed' }; h.native[1].disconnected();
    expect(other.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'status', type: 'error', message: 'Native host not installed' }));
    expect(other.disconnect).toHaveBeenCalledOnce(); h.stop();
  });

  it('bounds requests that never complete and closes the stale process', async () => {
    vi.useFakeTimers(); const h = broker(), port = h.open(); port.receive(request('status', 'status'));
    await vi.advanceTimersByTimeAsync(55000);
    expect(port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'error', message: 'Codex request timed out.' }));
    expect(h.native[0].disconnect).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0); h.stop();
  });
});

describe('Codex page client', () => {
  it('shares one port, matches replies, and delivers streamed deltas before completion', async () => {
    const h = clientHarness(), events = vi.fn();
    const answer = h.client.request('ask', { question: 'Why?' }, events);
    const status = h.client.request('status');
    const a = h.ports[0].postMessage.mock.calls[0][0], b = h.ports[0].postMessage.mock.calls[1][0];
    expect(a).toMatchObject({ op: 'ask', projectId: PROJECT, accountId: ACCOUNT });
    h.ports[0].receive({ id: a.id, type: 'delta', text: 'Because ' });
    expect(events).toHaveBeenCalledWith({ id: a.id, type: 'delta', text: 'Because ' });
    h.ports[0].receive({ id: b.id, type: 'status', available: true, authenticated: true });
    await expect(status).resolves.toMatchObject({ available: true });
    h.ports[0].receive({ id: a.id, type: 'done', text: 'Because it follows.' });
    await expect(answer).resolves.toMatchObject({ text: 'Because it follows.' });
    expect(h.runtime.connect).toHaveBeenCalledOnce(); h.client.close();
  });

  it('rejects an uncertain turn on disconnect and reconnects for the next request', async () => {
    const h = clientHarness(); const first = h.client.request('ask', { question: 'Why?' }).catch(error => error);
    h.runtime.lastError = { message: 'Host unavailable' }; h.ports[0].disconnected();
    expect(await first).toMatchObject({ message: 'Host unavailable' });
    const second = h.client.request('status'); expect(h.ports).toHaveLength(2);
    const id = h.ports[1].postMessage.mock.calls[0][0].id;
    h.ports[1].receive({ id, type: 'status', available: true }); await expect(second).resolves.toMatchObject({ available: true }); h.client.close();
  });

  it('cleans timeout timers and permits retry after explicit closure', async () => {
    vi.useFakeTimers(); const h = clientHarness(); const result = h.client.request('new-chat').catch(error => error);
    await vi.advanceTimersByTimeAsync(60000);
    expect(await result).toBeInstanceOf(Error); expect(vi.getTimerCount()).toBe(0);
    expect(h.ports[0].disconnect).toHaveBeenCalledOnce(); h.client.close();
  });

  it('does not let a delayed disconnect from an old port cancel a new connection', async () => {
    const h = clientHarness(); const first = h.client.request('status').catch(error => error);
    h.ports[0].autoDisconnect = false; h.client.close(); await first;
    const second = h.client.request('status'); const observed = second.catch(error => error);
    h.ports[0].disconnected();
    const id = h.ports[1].postMessage.mock.calls[0][0].id;
    h.ports[1].receive({ id, type: 'status', available: true });
    expect(await observed).toMatchObject({ type: 'status', available: true }); h.client.close();
  });

  it('recovers from an unusable port whose postMessage throws synchronously', async () => {
    vi.useFakeTimers(); const h = clientHarness(); const initial = h.client.request('status');
    const firstId = h.ports[0].postMessage.mock.calls[0][0].id;
    h.ports[0].receive({ id: firstId, type: 'status', available: true }); await initial;
    h.ports[0].postMessage.mockImplementation(() => { throw new Error('Disconnected port'); });
    const observed = h.client.request('history-read');
    await vi.advanceTimersByTimeAsync(150);
    expect(h.ports).toHaveLength(2);
    const id = h.ports[1].postMessage.mock.calls[0][0].id; h.ports[1].receive({ id, type: 'history', messages: [] });
    expect(await observed).toMatchObject({ type:'history', messages:[] }); h.client.close();
  });

  it('contains runtime invalidation while disconnecting rather than abandoning pending promises', async () => {
    const h = clientHarness(); const result = h.client.request('status').catch(error => error);
    Object.defineProperty(h.runtime, 'lastError', { get() { throw new Error('Extension context invalidated'); } });
    expect(() => h.ports[0].disconnected()).not.toThrow();
    expect(await result).toBeInstanceOf(Error); h.client.close();
  });

  it('settles and cleans a request even when its rendering callback throws', async () => {
    vi.useFakeTimers(); const h = clientHarness();
    const result = h.client.request('ask', { question: 'Why?' }, () => { throw new Error('View already removed'); });
    const id = h.ports[0].postMessage.mock.calls[0][0].id;
    expect(() => h.ports[0].receive({ id, type: 'done', text: 'Answer' })).not.toThrow();
    await expect(result).resolves.toMatchObject({ text: 'Answer' });
    expect(vi.getTimerCount()).toBe(0); h.client.close();
  });
});

describe('bounded project-local display history', () => {
  it('roundtrips answer quotes with editor selections and rejects invalid or oversized answer quote histories',async()=>{
    let listener!: (raw:unknown,sender:chrome.runtime.MessageSender,respond:(value:unknown)=>void)=>boolean|undefined;
    const runtime={id:EXTENSION,onMessage:{addListener:(fn:typeof listener)=>{listener=fn;}}};
    const values:Record<string,unknown>={};
    const storage={get:async()=>values,set:vi.fn(async(next:Record<string,unknown>)=>{Object.assign(values,next);})};
    registerCodexHistory(runtime as unknown as typeof chrome.runtime,storage as unknown as chrome.storage.StorageArea,allowedNativeSender);
    const answerQuote={text:'A formula: \\(x^2\\)',messageId:'assistant-1'};
    const selection={path:'notes.tex',text:'x',from:0,to:1,startLine:1,endLine:1,before:'',after:''};
    const messages=[{role:'user',text:'Explain',selection,answerQuote},{role:'assistant',text:'Answer'}];
    const dispatch=(action:string,records:unknown=messages)=>new Promise(resolve=>listener({type:'opt:codex-history',projectId:PROJECT,accountId:ACCOUNT,action,messages:records},sender(),resolve));
    expect(await dispatch('write')).toEqual({ok:true});
    expect(await dispatch('read')).toEqual({messages});
    for(const quote of [{text:''},{text:'x'.repeat(64_001)},{text:'ok',extra:true},{text:'ok',messageId:'bad/id'}])expect(await dispatch('write',[{role:'user',text:'why',answerQuote:quote}])).toEqual({ok:false});
    expect(await dispatch('write',[{role:'assistant',text:'why',answerQuote}])).toEqual({ok:false});
    expect(await dispatch('write',Array.from({length:7},()=>({role:'user',text:'why',answerQuote:{text:'x'.repeat(64_000)}})))).toEqual({ok:false});
    expect(storage.set).toHaveBeenCalledOnce();
  });

  it('roundtrips the exact quoted selection while rejecting forged ranges and oversized quote histories', async () => {
    let listener!: (raw: unknown, sender: chrome.runtime.MessageSender, respond: (value: unknown) => void) => boolean | undefined;
    const runtime = { id: EXTENSION, onMessage: { addListener: (fn: typeof listener) => { listener = fn; } } };
    const values: Record<string, unknown> = {};
    const storage = { get: async () => values, set: vi.fn(async (next: Record<string, unknown>) => { Object.assign(values, next); }) };
    registerCodexHistory(runtime as unknown as typeof chrome.runtime, storage as unknown as chrome.storage.StorageArea, allowedNativeSender);
    const selection = { path: 'notes.tex', text: 'x=0', from: 12, to: 15, startLine: 2, endLine: 2, before: '', after: '' };
    const messages = [{ role: 'user', text: 'Why?', selection }, { role: 'assistant', text: 'Because.' }];
    const dispatch = (action: string, records = messages) => new Promise(resolve => listener({ type: 'opt:codex-history', projectId: PROJECT, accountId: ACCOUNT, action, messages: records }, sender(), resolve));
    expect(await dispatch('write')).toEqual({ ok: true });
    expect(await dispatch('read')).toEqual({ messages });
    expect(await dispatch('write', [{ ...messages[0], selection: { ...selection, to: 19 } }])).toEqual({ ok: false });
    const large = { ...selection, text: 'x'.repeat(64_000), from: 0, to: 64_000 };
    expect(await dispatch('write', Array.from({ length: 7 }, () => ({ role: 'user', text: '', selection: large })))).toEqual({ ok: false });
    expect(storage.set).toHaveBeenCalledOnce();
  });
  it('validates origin/project/account and does not write oversized or extra-field records', async () => {
    let listener!: (raw: unknown, sender: chrome.runtime.MessageSender, respond: (value: unknown) => void) => boolean | undefined;
    const runtime = { id: EXTENSION, onMessage: { addListener: (fn: typeof listener) => { listener = fn; } } };
    const storage = { get: vi.fn(async () => ({})), set: vi.fn(async (_items: Record<string, unknown>) => {}) };
    registerCodexHistory(runtime as unknown as typeof chrome.runtime, storage as unknown as chrome.storage.StorageArea, allowedNativeSender);
    const dispatch = (change: Record<string, unknown>, origin = sender()) => new Promise(resolve => listener({ type: 'opt:codex-history', projectId: PROJECT, accountId: ACCOUNT, action: 'write', messages: [{ role: 'user', text: 'Question' }], ...change }, origin, resolve));
    expect(await dispatch({})).toEqual({ ok: true }); expect(storage.set).toHaveBeenCalledOnce();
    expect(Object.keys(storage.set.mock.calls[0][0] as object)[0]).toContain(`codex:${ACCOUNT}:${PROJECT}`);
    await dispatch({ projectId: 'aaaaaaaaaaaaaaaaaaaaaaaa' }); await dispatch({ accountId: '' });
    await dispatch({ messages: [{ role: 'user', text: 'a'.repeat(400001) }] });
    await dispatch({ messages: [{ role: 'user', text: 'Question', hidden: 'extra' }] });
    await dispatch({}, { ...sender(), frameId: 1 });
    expect(storage.set).toHaveBeenCalledOnce();
  });
});

describe('durable cross-window prompt queue',()=>{
  it('uses atomic revisions so two windows cannot both mark the same queued item as sending',async()=>{
    let listener!:(raw:any,sender:chrome.runtime.MessageSender,respond:(value:any)=>void)=>boolean|undefined;
    const runtime={id:EXTENSION,onMessage:{addListener:(fn:typeof listener)=>{listener=fn;}}};
    const values:Record<string,unknown>={};const storage={get:vi.fn(async()=>({...values})),set:vi.fn(async(next:Record<string,unknown>)=>{await Promise.resolve();Object.assign(values,next);})};
    registerCodexHistory(runtime as unknown as typeof chrome.runtime,storage as unknown as chrome.storage.StorageArea,allowedNativeSender);
    const dispatch=(data:Record<string,unknown>)=>new Promise<any>(resolve=>listener({type:'opt:codex-queue',projectId:PROJECT,accountId:ACCOUNT,...data},sender(),resolve));
    const item={id:'pending-1',state:'queued',prompt:{question:'Follow up',settings:{enabled:true,model:'',effort:'',instructions:'',contextMode:'project'},files:[{path:'main.tex',content:'Captured source'}],note:'',conversationId:'11111111-2222-3333-4444-555555555555'}};
    const saved=await dispatch({action:'write',expectedRevision:'',items:[item]});expect(saved.ok).toBe(true);
    const snapshotA=await dispatch({action:'read'}),snapshotB=await dispatch({action:'read'});expect(snapshotA.revision).toBe(snapshotB.revision);
    const results=await Promise.all([dispatch({action:'write',expectedRevision:snapshotA.revision,items:[{...item,state:'sending'}]}),dispatch({action:'write',expectedRevision:snapshotB.revision,items:[{...item,state:'sending'}]})]);
    expect(results.filter(r=>r.ok)).toHaveLength(1);expect(results.find(r=>!r.ok)?.message).toContain('another window');
    expect((await dispatch({action:'read'})).items[0].state).toBe('sending');expect(storage.set).toHaveBeenCalledTimes(2);
  });
  it('rejects malformed queue snapshots without writing selected manuscript text',async()=>{
    let listener!:(raw:any,sender:chrome.runtime.MessageSender,respond:(value:any)=>void)=>boolean|undefined;
    const runtime={id:EXTENSION,onMessage:{addListener:(fn:typeof listener)=>{listener=fn;}}},storage={get:vi.fn(async()=>({})),set:vi.fn(async()=>{})};
    registerCodexHistory(runtime as unknown as typeof chrome.runtime,storage as unknown as chrome.storage.StorageArea,allowedNativeSender);
    const result=await new Promise(resolve=>listener({type:'opt:codex-queue',projectId:PROJECT,accountId:ACCOUNT,action:'write',expectedRevision:'',items:[{id:'bad',state:'queued',prompt:{question:'x',files:[{path:'../escape',content:'private'}]}}]},sender(),resolve));
    expect(result).toEqual({ok:false,message:'Invalid queued messages.'});expect(storage.set).not.toHaveBeenCalled();
  });
});
