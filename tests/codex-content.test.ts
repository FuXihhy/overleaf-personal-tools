// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { DEFAULT_SETTINGS, emptyIndex, type ProjectIndex } from '../src/core/types';
import { DEFAULT_CODEX_SETTINGS, type CodexEvent, type CodexMessage } from '../src/codex/types';
import type { CodexPanelOptions } from '../src/codex/panel';
import type { PanelActions, PanelModel } from '../src/settings/native-panel';

const mocks = vi.hoisted(() => ({
  actions: undefined as PanelActions | undefined,
  model: undefined as (() => PanelModel) | undefined,
  panelOptions: undefined as CodexPanelOptions | undefined,
  discover: vi.fn(), readFile: vi.fn(), captureFull: vi.fn(), sourceRequest: vi.fn(), buildIndex: vi.fn(), request: vi.fn(), close: vi.fn(),
  loadMessages: vi.fn(), saveMessages: vi.fn(), saveDefaults: vi.fn(), saveCodexSettings: vi.fn(),
  revealSource: vi.fn(), sourceCheck: vi.fn(), acquireCachePage: vi.fn(),
  renderedMacros: [] as string[][],
  panel: { setCacheNotice:vi.fn(), setConnection:vi.fn(), appendMessage: vi.fn(), setMessages: vi.fn(), syncMessages:vi.fn(), isOpen:vi.fn(), setRemoteState:vi.fn(), setAssistantText: vi.fn(), setSelection: vi.fn(), clearSelection: vi.fn(), clearAnswerQuote: vi.fn(), setStatus: vi.fn(), setBusy: vi.fn(), update: vi.fn(), destroy: vi.fn(), setHistoryPaging:vi.fn(), prependMessages:vi.fn(),setPosition:vi.fn(),setQueue:vi.fn(),setSteering:vi.fn(),insertSteeringMessage:vi.fn() },
  ui: { update: vi.fn(), refreshForm: vi.fn(), destroy: vi.fn() },
}));
vi.mock('../src/overleaf/project-source', () => ({ OverleafProjectSource: class {
  discover = mocks.discover; readFile = mocks.readFile; captureFull = mocks.captureFull; setRootPath = vi.fn(); setLiveDocument = vi.fn(); observeNativeRoot = vi.fn(); invalidate = vi.fn();
} }));
vi.mock('../src/core/project-index', () => ({ buildProjectIndex: mocks.buildIndex }));
vi.mock('../src/overleaf/source-navigation', () => ({ revealSource: mocks.revealSource }));
vi.mock('../src/packages', () => ({ enrichIndex: (value: ProjectIndex) => value }));
vi.mock('../src/core/preview-sources', () => ({ applyPreviewSources: (value: ProjectIndex) => value }));
vi.mock('../src/settings/storage', () => ({ loadSettings: async () => ({ ...DEFAULT_SETTINGS, preview: false }), saveSettings: vi.fn(), saveDefaults: vi.fn(), validateSettings: (value: unknown) => value }));
vi.mock('../src/settings/native-panel', () => ({ mountNativeSettings: (model: () => PanelModel, actions: PanelActions) => { mocks.model = model; mocks.actions = actions; return mocks.ui; } }));
vi.mock('../src/codex/panel', () => ({ mountCodexAssistant: (options: CodexPanelOptions) => { mocks.panelOptions = options; return mocks.panel; } }));
vi.mock('../src/codex/client', () => ({ CodexClient: class { request = (op: string, ...args: unknown[]) => op==='source-check' ? mocks.sourceCheck(...args) : op.startsWith('source-') ? mocks.sourceRequest(op, ...args) : mocks.request(op, ...args); close = mocks.close; } }));
// Chrome document identity/lease behavior is exercised with the real module in
// codex-cache-lifecycle.test.ts. Content tests isolate orchestration from Chrome.
vi.mock('../src/codex/cache-lifecycle', () => ({ createProjectCachePage: () => ({ acquire: mocks.acquireCachePage }) }));
vi.mock('../src/codex/storage', () => ({
  codexStorageKey: (project: string, account?: string) => `codex:${account}:${project}`,
  loadCodexSettings: async () => ({ ...DEFAULT_CODEX_SETTINGS }), saveCodexSettings: mocks.saveCodexSettings, saveCodexDefaults: mocks.saveDefaults,
  loadCodexPanelPosition:async()=> 'left',saveCodexPanelPosition:vi.fn(),
  loadCodexClickToCopy:async()=>false,saveCodexClickToCopy:vi.fn(),loadCodexCopyToast:async()=>false,saveCodexCopyToast:vi.fn(),
  loadCodexBusyMessageBehavior:async()=> 'queue',saveCodexBusyMessageBehavior:vi.fn(),
  loadCodexMessages: mocks.loadMessages, saveCodexMessages: mocks.saveMessages,
}));
vi.mock('../src/preview/tex-service', () => ({ TexPreviewService: class {
  render = vi.fn(); invalidate = vi.fn(); invalidateEnvironment = vi.fn(); loadSharedBinding = vi.fn(); prepareSharedProject = vi.fn();
  cloud = { getPreviewProject: () => undefined };
} }));
vi.mock('../src/preview/local-client', () => ({ cancelLocalTex: vi.fn(), getLocalStatus: vi.fn() }));
vi.mock('../src/i18n', () => ({ getLocale: () => 'en', observeLocale: () => () => {}, translateRuntimeText: (value: string) => value }));

const project = { files: [{ id: 'main', path: 'main.tex', kind: 'doc' as const }], rootPath: 'main.tex', rootCandidates: ['main.tex'], name: 'Synthetic' };
const selection = { path: 'main.tex', text: '\\RR', from: 10, to: 13, startLine: 2, endLine: 2, before: 'Macro context before', after: ' after' };
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); await vi.dynamicImportSettled(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function boot() { await import('../src/content'); await flush(); }
function withAccount() {
  const account=document.createElement('meta');account.name='ol-user_id';account.content='abcdef0123456789abcdef01';document.head.append(account);
  return account;
}
const conversationId='01a18cbd-8295-7070-8093-1902e8a20546';
const initialMessages:CodexMessage[]=[{messageId:'m1',role:'user',text:'Earlier question'},{messageId:'m2',role:'assistant',text:'Earlier answer'}];
const historyPage=(messages=initialMessages,overrides:Partial<CodexEvent>={}):CodexEvent=>({id:'read',type:'history',conversationId,messages,remoteState:'idle',syncRevision:'a'.repeat(64),...overrides});
function openForSynchronization() { mocks.panel.isOpen.mockReturnValue(true);mocks.panelOptions!.onVisibilityChange!(true); }

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  document.body.replaceChildren(); history.replaceState(null, '', '/project/0123456789abcdef01234567');
  document.head.querySelector('meta[name="ol-user_id"]')?.remove();
  mocks.actions = undefined; mocks.model = undefined; mocks.panelOptions = undefined; mocks.renderedMacros = [];
  mocks.discover.mockReset().mockResolvedValue(project); mocks.readFile.mockReset().mockResolvedValue('Synthetic source');
  mocks.captureFull.mockReset().mockImplementation(async (options: { liveDocuments: Map<string, string> }) => { const current = await mocks.discover(); return { rootPath: current.rootPath, files: await Promise.all(current.files.map(async (file: { path: string }) => ({ path: file.path, content: options.liveDocuments.get(file.path) ?? await mocks.readFile(file) }))) }; });
  mocks.sourceRequest.mockReset().mockImplementation(async (op: string) => ({ id: 'source', type: 'source', ...(op === 'source-commit' ? { snapshotId: 'ab'.repeat(32) } : { uploadId: '12345678-1234-4234-8234-123456789abc' }) }));
  mocks.sourceCheck.mockReset().mockImplementation(async(data:{snapshotId:string})=>({id:'check',type:'source',snapshotId:data.snapshotId}));
  mocks.acquireCachePage.mockReset().mockResolvedValue({documentId:'1:12345678-1234-4234-8234-123456789abc',leaseToken:'12345678-1234-4234-8234-123456789abc'});
  mocks.buildIndex.mockReset().mockResolvedValue(emptyIndex()); mocks.request.mockReset().mockResolvedValue({ id: 'test', type: 'done', text: '' });
  mocks.loadMessages.mockReset().mockResolvedValue([]); mocks.saveMessages.mockReset().mockResolvedValue(undefined);
  mocks.saveCodexSettings.mockReset().mockResolvedValue(undefined);
  mocks.revealSource.mockReset().mockResolvedValue(undefined);
  mocks.panel.isOpen.mockReset().mockReturnValue(false);
  mocks.panel.setMessages.mockImplementation(() => mocks.renderedMacros.push(mocks.panelOptions?.getIndex?.().macros.map(macro => macro.name) ?? []));
  vi.stubGlobal('chrome', { runtime: { id: 'synthetic-extension', getURL: (path: string) => path }, storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() } } });
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
});
afterEach(() => {
  mocks.panelOptions?.context?.invalidate();
  vi.useRealTimers();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren();
  document.head.querySelectorAll('style').forEach(style => style.remove()); document.documentElement.removeAttribute('data-opt-preview-enabled');
});

describe('Codex content integration', () => {
  it('sends normal context without downloading or leasing complete project source',async()=>{
    await boot();await mocks.actions!.saveCodex!({...DEFAULT_CODEX_SETTINGS,contextMode:'selection',cacheMode:'normal'});
    await mocks.panelOptions!.onSend('Explain this selection',selection);
    expect(mocks.captureFull).not.toHaveBeenCalled();expect(mocks.acquireCachePage).not.toHaveBeenCalled();expect(mocks.sourceRequest).not.toHaveBeenCalled();
    expect(mocks.request).toHaveBeenLastCalledWith('ask',expect.objectContaining({selection,settings:expect.objectContaining({cacheMode:'normal',contextMode:'selection'})}),expect.any(Function));
    await expect(mocks.actions!.onSyncProjectCache!()).rejects.toThrow('Enable complete project context');
  });
  it.each(['on-demand','persistent'] as const)('registers a verified page before capture and passes %s only on source-begin',async cacheMode=>{
    await boot();await mocks.actions!.saveCodex!({...DEFAULT_CODEX_SETTINGS,cacheMode});
    await mocks.actions!.onSyncProjectCache!();
    expect(mocks.acquireCachePage.mock.invocationCallOrder[0]).toBeLessThan(mocks.captureFull.mock.invocationCallOrder[0]);
    expect(mocks.sourceRequest).toHaveBeenCalledWith('source-begin',expect.objectContaining({cacheMode,leaseToken:'12345678-1234-4234-8234-123456789abc'}));
    expect(mocks.sourceRequest.mock.calls.filter(([op])=>op!=='source-begin').every(([,data])=>!('cacheMode' in data)&&!('leaseToken' in data))).toBe(true);
  });
  it('requires a reviewed exact cache revision before explicit cleanup and leaves chat history independent',async()=>{
    await boot();const cacheInfo={folder:'C:\\Synthetic\\managed-source',snapshotCount:2,totalBytes:400,lastSyncedAt:1800000000,temporaryCount:0,persistentCount:2,legacyCount:0,pageCount:1,pinCount:0,cleanupPending:false,cacheRevision:'ab'.repeat(32)};
    mocks.sourceRequest.mockResolvedValue({id:'source',type:'source',cacheInfo});
    await expect(mocks.actions!.clearProjectCache!()).rejects.toThrow('Inspect local versions');
    const description=await mocks.actions!.inspectProjectCache!();expect(description).toContain('2 versions');expect(description).toContain(cacheInfo.folder);
    await mocks.actions!.clearProjectCache!();expect(mocks.sourceRequest).toHaveBeenLastCalledWith('source-cache-clear',{cacheRevision:cacheInfo.cacheRevision});
    await expect(mocks.actions!.clearProjectCache!()).rejects.toThrow('Inspect local versions');
    expect(mocks.saveMessages).not.toHaveBeenCalled();expect(mocks.captureFull).not.toHaveBeenCalled();
  });
  it('keeps a cache failure reminder through connection status updates and clears it only after a successful sync',async()=>{
    await boot();
    mocks.captureFull.mockRejectedValueOnce(new Error('Project export unavailable'));
    await expect(mocks.actions!.onSyncProjectCache!()).rejects.toThrow('Project export unavailable');
    expect(mocks.panel.setCacheNotice).toHaveBeenLastCalledWith('error');
    mocks.request.mockResolvedValue({id:'status',type:'status',available:true,authenticated:true,connectionKind:'standalone',projectReaderReady:true,models:[{id:'synthetic-model',displayName:'Synthetic'}]});
    await mocks.actions!.checkCodex!();
    expect(mocks.panel.setConnection).toHaveBeenLastCalledWith(expect.objectContaining({state:'connected'}));
    expect(mocks.panel.setCacheNotice).toHaveBeenLastCalledWith('error');
    expect(mocks.model!().codexStatus).toContain('Project synchronization failed');
    await mocks.actions!.onSyncProjectCache!();
    expect(mocks.panel.setCacheNotice).toHaveBeenLastCalledWith(null);
    expect(mocks.request.mock.calls.some(([op])=>['ask','steer','new-chat'].includes(op))).toBe(false);
  });
  it('reports lease-connection failures before capture and never sends a question or replaces that failure with cached readiness',async()=>{
    vi.useFakeTimers();await boot();
    mocks.request.mockResolvedValue({id:'status',type:'status',available:true,authenticated:true,connectionKind:'standalone',projectReaderReady:true,models:[{id:'synthetic',displayName:'Synthetic'}]});
    await mocks.actions!.checkCodex!();
    mocks.acquireCachePage.mockRejectedValue(new Error('Project cache connection lost; source is retained.'));
    await expect(mocks.panelOptions!.onSend('Keep the original question',selection)).rejects.toThrow('The question was not sent');
    expect(mocks.captureFull).not.toHaveBeenCalled();expect(mocks.request.mock.calls.some(([op])=>op==='ask')).toBe(false);
    expect(mocks.panel.setConnection).toHaveBeenLastCalledWith(expect.objectContaining({state:'reconnecting'}));
    expect(mocks.panel.setCacheNotice).toHaveBeenLastCalledWith('error');
    await mocks.actions!.checkCodex!();expect(mocks.model!().codexStatus).toContain('Project synchronization failed');
    expect(mocks.panel.setMessages).toHaveBeenLastCalledWith([]);
  });
  it('propagates source-check transport errors to connection state without sending or retrying the question',async()=>{
    vi.useFakeTimers();await boot();mocks.sourceCheck.mockRejectedValue(new Error('Codex request timed out. Try again.'));
    await expect(mocks.panelOptions!.onSend('Retain this draft',selection)).rejects.toThrow('The question was not sent');
    expect(mocks.panel.setConnection).toHaveBeenLastCalledWith(expect.objectContaining({state:'reconnecting'}));
    expect(mocks.panel.setCacheNotice).toHaveBeenLastCalledWith('error');expect(mocks.request.mock.calls.some(([op])=>op==='ask')).toBe(false);
  });
  it.each([false,undefined])('retains model choices but refuses project sends when reader verification is %s; Normal context can continue',async projectReaderReady=>{
    await boot();mocks.request.mockImplementation(async(op:string)=>op==='status'?{id:'status',type:'status',available:true,authenticated:true,connectionKind:'standalone',projectReaderReady,readerError:projectReaderReady===false?'Missing manuscript tools':undefined,models:[{id:'synthetic',displayName:'Synthetic'}]}:{id:'done',type:'done',text:'Synthetic response'});
    await mocks.actions!.checkCodex!();expect(mocks.model!().codexModels).toHaveLength(1);
    await expect(mocks.panelOptions!.onSend('Read the project',selection)).rejects.toThrow('The question was not sent');
    expect(mocks.captureFull).toHaveBeenCalledOnce();expect(mocks.request.mock.calls.some(([op])=>op==='ask')).toBe(false);
    await mocks.actions!.saveCodex!({...DEFAULT_CODEX_SETTINGS,contextMode:'selection',cacheMode:'normal'});
    await mocks.panelOptions!.onSend('Explain only the selection',selection);
    expect(mocks.request.mock.calls.filter(([op])=>op==='ask')).toHaveLength(1);expect(mocks.captureFull).toHaveBeenCalledOnce();
  });
  it('always performs a new status request for each completed manual check within five minutes',async()=>{
    await boot();mocks.request.mockResolvedValue({id:'status',type:'status',available:true,authenticated:true,connectionKind:'standalone',projectReaderReady:true,models:[{id:'synthetic',displayName:'Synthetic'}]});
    await mocks.actions!.checkCodex!();await mocks.actions!.checkCodex!();expect(mocks.request.mock.calls.filter(([op])=>op==='status')).toHaveLength(2);
    expect(mocks.request.mock.calls.some(([op])=>['ask','steer'].includes(op))).toBe(false);
  });
  it.each(['normal','persistent'] as const)('retires a pending manual capture after switching its mode to %s without uploading under the old mode',async cacheMode=>{
    await boot();mocks.captureFull.mockRejectedValueOnce(new Error('Original source failure'));
    await expect(mocks.actions!.onSyncProjectCache!()).rejects.toThrow('Original source failure');
    const full=deferred<{rootPath:string;files:Array<{path:string;content:string}>}>();mocks.captureFull.mockReturnValueOnce(full.promise);
    const syncing=mocks.actions!.onSyncProjectCache!();const rejected=expect(syncing).rejects.toThrow('cancelled');await flush();
    await mocks.actions!.saveCodex!({...DEFAULT_CODEX_SETTINGS,cacheMode,contextMode:cacheMode==='normal'?'selection':'project'});
    full.resolve({rootPath:'main.tex',files:[{path:'main.tex',content:'Synthetic manuscript'}]});await rejected;
    expect(mocks.sourceRequest).not.toHaveBeenCalled();expect(mocks.panel.setCacheNotice).toHaveBeenLastCalledWith(cacheMode==='normal'?null:'error');
  });
  it('does not mislabel an unrelated model request failure as a project cache error',async()=>{
    await boot();
    mocks.request.mockImplementation(async(op:string)=>{if(op==='ask')throw new Error('Model connection timed out');return {id:'status',type:'status',available:true,authenticated:true};});
    await expect(mocks.panelOptions!.onSend('Use this project',selection)).rejects.toThrow('Model connection timed out');
    expect(mocks.sourceCheck).toHaveBeenCalledOnce();
    expect(mocks.panel.setCacheNotice.mock.calls.some(([notice])=>notice==='error')).toBe(false);
  });
  it('warns only for observed edits after a known aged sync, and clears the stale reminder after manual sync',async()=>{
    vi.useFakeTimers();vi.setSystemTime(1_800_000_000_000);await boot();
    const publish=(text:string)=>window.dispatchEvent(new CustomEvent('opt:editor',{detail:JSON.stringify({type:'document',name:'main.tex',text})}));
    publish('Before first sync');
    await vi.advanceTimersByTimeAsync(300_000);
    expect(mocks.panel.setCacheNotice.mock.calls.some(([notice])=>notice==='stale')).toBe(false);
    mocks.readFile.mockResolvedValue('Before first sync');await mocks.actions!.onSyncProjectCache!();
    expect(mocks.panel.setCacheNotice).toHaveBeenLastCalledWith(null);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(mocks.panel.setCacheNotice.mock.calls.some(([notice])=>notice==='stale')).toBe(false);
    publish('Changed after verified sync');
    expect(mocks.panel.setCacheNotice).toHaveBeenLastCalledWith('stale');
    // A local fingerprint matches the fresh full-source result after sync.
    mocks.readFile.mockResolvedValue('Changed after verified sync');await mocks.actions!.onSyncProjectCache!();
    expect(mocks.panel.setCacheNotice).toHaveBeenLastCalledWith(null);
    expect(mocks.request.mock.calls.some(([op])=>op==='ask')).toBe(false);
  });
  it('manually synchronizes complete source without asking, resetting a chat or saving settings',async()=>{
    await boot();
    const status=await mocks.actions!.onSyncProjectCache!();
    expect(status).toContain('Project cache synced: 1 files; 1 uploaded');
    expect(mocks.captureFull).toHaveBeenCalledTimes(1);
    expect(mocks.request.mock.calls.some(([op])=>['ask','steer','new-chat'].includes(op))).toBe(false);
    expect(mocks.saveCodexSettings).not.toHaveBeenCalled();
    expect(mocks.panel.appendMessage).not.toHaveBeenCalled();
  });
  it('re-downloads a missing snapshot before submission and checks the original identity',async()=>{
    await boot();let checks=0;
    mocks.sourceCheck.mockImplementation(async(data:{snapshotId:string},event:(value:CodexEvent)=>void)=>{
      if(++checks===1){event({id:'check',type:'error',errorCode:'source_unavailable'});throw new Error('Missing source');}
      return {id:'check',type:'source',snapshotId:data.snapshotId};
    });
    await mocks.panelOptions!.onSend('Read complete project',selection);
    expect(mocks.captureFull).toHaveBeenCalledTimes(2);
    expect(mocks.sourceCheck.mock.calls.map(([data])=>data.snapshotId)).toEqual(['ab'.repeat(32),'ab'.repeat(32)]);
    expect(mocks.request.mock.calls.filter(([op])=>op==='ask')).toHaveLength(1);
  });
  it('preserves the question and never sends when the original snapshot remains unavailable',async()=>{
    await boot();
    mocks.sourceCheck.mockImplementation(async(_data:unknown,event:(value:CodexEvent)=>void)=>{event({id:'check',type:'error',errorCode:'source_unavailable'});throw new Error('Missing source');});
    await expect(mocks.panelOptions!.onSend('Keep original version',selection)).rejects.toThrow();
    expect(mocks.captureFull).toHaveBeenCalledTimes(2);
    expect(mocks.request.mock.calls.some(([op])=>op==='ask')).toBe(false);
    expect(mocks.panel.setMessages).toHaveBeenLastCalledWith([]);
    expect(mocks.panel.setCacheNotice).toHaveBeenLastCalledWith('error');
  });
  it('repairs a damaged cache during an active reply without replaying the question and stops checking after completion',async()=>{
    await boot();
    vi.useFakeTimers();
    const answer=deferred<CodexEvent>(),started=deferred<void>(),recovered=deferred<void>();
    let checks=0;
    mocks.sourceCheck.mockImplementation(async(data:{snapshotId:string},event:(value:CodexEvent)=>void)=>{
      checks++;
      if(checks===2){event({id:'check',type:'error',errorCode:'source_unavailable'});throw new Error('Snapshot was damaged during this reply');}
      if(checks===3)recovered.resolve();
      return {id:'check',type:'source',snapshotId:data.snapshotId};
    });
    mocks.request.mockImplementation((op,data,onEvent)=>{
      if(op==='ask'){
        onEvent?.({id:'ask',type:'started',threadId:conversationId,turnId:'active-source-turn',canSteer:true});
        started.resolve();return answer.promise;
      }
      return Promise.resolve({id:'other',type:'done'});
    });
    const sending=mocks.panelOptions!.onSend('Use the original complete project',selection);
    // Source capture uses real asynchronous crypto; synchronize on protocol
    // signals rather than assuming a fixed number of event-loop flushes.
    await started.promise;
    expect(mocks.sourceCheck).toHaveBeenCalledOnce();expect(mocks.captureFull).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5000);await recovered.promise;
    expect(mocks.captureFull).toHaveBeenCalledTimes(2);
    expect(mocks.sourceCheck.mock.calls.map(([data])=>data.snapshotId)).toEqual(Array(3).fill('ab'.repeat(32)));
    expect(mocks.request.mock.calls.filter(([op])=>op==='ask')).toHaveLength(1);
    expect(mocks.request.mock.calls.some(([op])=>op==='new-chat')).toBe(false);
    answer.resolve({id:'ask',type:'done',text:'Answer based on the original project'});await sending;
    expect(mocks.panel.setAssistantText).toHaveBeenLastCalledWith('Answer based on the original project');
    await vi.advanceTimersByTimeAsync(10000);
    expect(mocks.sourceCheck).toHaveBeenCalledTimes(3);
    expect(mocks.captureFull).toHaveBeenCalledTimes(2);
  });
  it('checks the connection on panel open and reconnects without sending a question',async()=>{
    await boot();
    mocks.request.mockResolvedValue({id:'status',type:'status',available:true,authenticated:true,models:[{id:'gpt-6-astra',displayName:'GPT-6-Astra',efforts:['max','ultra']}]});
    openForSynchronization();await flush();
    expect(mocks.request.mock.calls.map(([op])=>op)).toEqual(['status']);
    expect(mocks.panel.setConnection).toHaveBeenLastCalledWith(expect.objectContaining({state:'connected'}));
    expect(mocks.model!().codexModels?.[0].id).toBe('gpt-6-astra');
    await mocks.panelOptions!.onReconnect!();await flush();
    expect(mocks.request.mock.calls.map(([op])=>op)).toEqual(['status','status']);
    expect(mocks.panel.appendMessage).not.toHaveBeenCalled();expect(mocks.sourceRequest).not.toHaveBeenCalled();
  });

  it('autosaves model and instruction changes during an answer for the next turn without disturbing the active request',async()=>{
    await boot();await mocks.actions!.saveCodex!({...DEFAULT_CODEX_SETTINGS,contextMode:'selection'});
    const first=deferred<CodexEvent>();let asks=0;
    mocks.request.mockImplementation((op:string)=>op==='ask' && ++asks===1?first.promise:Promise.resolve({id:'ask',type:'done',text:'Next answer'}));
    const sending=mocks.panelOptions!.onSend('First question',selection);await flush();
    const firstSettings=mocks.request.mock.calls.find(([op])=>op==='ask')![1].settings;
    expect(mocks.model!().codexBusy).toBe(true);mocks.close.mockClear();
    const updated={...DEFAULT_CODEX_SETTINGS,contextMode:'selection' as const,model:'gpt-6-astra',effort:'high',instructions:'Use the paper notation'};
    await mocks.actions!.saveCodex!(updated);
    expect(mocks.model!().codex).toEqual(updated);expect(mocks.model!().codexBusy).toBe(true);
    expect(firstSettings).toEqual({...DEFAULT_CODEX_SETTINGS,contextMode:'selection'});
    expect(mocks.close).not.toHaveBeenCalled();expect(mocks.request.mock.calls.map(([op])=>op)).toEqual(['ask']);
    first.resolve({id:'first',type:'done',text:'First answer'});await sending;
    await mocks.panelOptions!.onSend('Next question',selection);
    const requests=mocks.request.mock.calls.filter(([op])=>op==='ask');
    expect(requests).toHaveLength(2);expect(requests[1][1].settings).toEqual(updated);
    expect(mocks.panel.setAssistantText).toHaveBeenCalledWith('First answer');
  });

  it('sets account defaults from current assistant preferences without including chat history or starting a connection',async()=>{
    const account=withAccount();mocks.request.mockResolvedValue(historyPage());await boot();
    const updated={...DEFAULT_CODEX_SETTINGS,model:'gpt-6-astra',effort:'high',instructions:'Project-only notation'};
    await mocks.actions!.saveCodex!(updated);
    await mocks.actions!.setCodexPosition!('right');await mocks.actions!.setCodexBusyMessageBehavior!('steer');
    await mocks.actions!.setCodexClickToCopy!(true);await mocks.actions!.setCodexCopyToast!(true);
    mocks.request.mockClear();mocks.saveMessages.mockClear();mocks.panel.setMessages.mockClear();
    await mocks.actions!.defaultsCodex!();
    expect(mocks.saveDefaults).toHaveBeenCalledExactlyOnceWith(account.content,{
      settings:updated,panelPosition:'right',busyMessageBehavior:'steer',clickToCopy:true,copyToast:true,
    });
    expect(mocks.request).not.toHaveBeenCalled();expect(mocks.saveMessages).not.toHaveBeenCalled();expect(mocks.panel.setMessages).not.toHaveBeenCalled();
    expect(mocks.model!().codex?.instructions).toBe('Project-only notation');
  });

  it('uploads a complete fresh project with the active buffer before asking and sends only its snapshot reference', async () => {
    await boot();
    const content = 'Earlier source\n'.repeat(8000) + '\\section{Actual required derivation}\nESSENTIAL_ANSWER_BODY';
    document.body.innerHTML = '<button role="treeitem" aria-selected="true">main.tex</button>';
    const publish = (event:Event) => window.dispatchEvent(new CustomEvent('opt:document-context-result', { detail: JSON.stringify({ id:JSON.parse((event as CustomEvent<string>).detail).id,ok:true,name:'main.tex',text:content }) }));
    window.addEventListener('opt:request-document-context', publish);
    mocks.captureFull.mockImplementation(async (options: { liveDocuments: Map<string,string> }) => ({ rootPath: 'main.tex', files: [{ path: 'main.tex', content: options.liveDocuments.get('main.tex')! }, ...Array.from({ length: 80 }, (_, i) => ({ path: `chapter-${i}.tex`, content: `Complete file ${i}` }))] }));
    const commit = deferred<CodexEvent>();
    mocks.sourceRequest.mockImplementation(async (op:string) => op === 'source-commit' ? commit.promise : { id:'source',type:'source',uploadId:'12345678-1234-4234-8234-123456789abc' });
    try {
      const sending = mocks.panelOptions!.onSend('Explain the final section', selection);
      await vi.waitFor(() => expect(mocks.sourceRequest.mock.calls.some(([op])=>op==='source-commit')).toBe(true));
      expect(mocks.request.mock.calls.some(([op])=>op==='ask')).toBe(false);
      const chunks = mocks.sourceRequest.mock.calls.filter(([op,data])=>op==='source-chunk' && data.path==='main.tex').map(([,data])=>data.content).join('');
      expect(chunks).toBe(content); expect(chunks).toContain('ESSENTIAL_ANSWER_BODY');
      expect(mocks.sourceRequest.mock.calls.find(([op])=>op==='source-begin')![1].sourceManifest).toHaveLength(81);
      commit.resolve({id:'source',type:'source',snapshotId:'cd'.repeat(32)});await sending;
      expect(mocks.request).toHaveBeenLastCalledWith('ask',expect.objectContaining({snapshotId:'cd'.repeat(32),files:[],selection}),expect.any(Function));
      expect(JSON.stringify(mocks.request.mock.lastCall)).not.toContain('ESSENTIAL_ANSWER_BODY');
    } finally { window.removeEventListener('opt:request-document-context',publish); }
  });

  it('uses only a fresh server export when live editor identity is unavailable, without overlaying the old file', async () => {
    await boot(); vi.useFakeTimers(); document.body.innerHTML='<button role="treeitem" aria-selected="true">main.tex</button>';
    const publish=(event:Event)=>window.dispatchEvent(new CustomEvent('opt:document-context-result',{detail:JSON.stringify({id:JSON.parse((event as CustomEvent<string>).detail).id,ok:true,name:'old.tex',text:'Previous document'})}));
    window.addEventListener('opt:request-document-context',publish);
    try {
      const sending=mocks.panelOptions!.onSend('Explain the current project'); await vi.advanceTimersByTimeAsync(1500); await sending;
      expect(mocks.captureFull).toHaveBeenCalledOnce();
      expect(mocks.captureFull.mock.calls[0][0].liveDocuments.size).toBe(0);
      expect(mocks.sourceRequest).toHaveBeenCalledWith('source-chunk',expect.objectContaining({path:'main.tex',content:'Synthetic source'}));
      expect(JSON.stringify(mocks.sourceRequest.mock.calls)).not.toContain('Previous document');
      expect(mocks.request.mock.calls.filter(([op])=>op==='ask')).toHaveLength(1);
      expect(mocks.panel.setCacheNotice).toHaveBeenLastCalledWith('saved');
      expect(mocks.panel.setCacheNotice.mock.calls.some(([notice])=>notice==='error')).toBe(false);
    } finally { window.removeEventListener('opt:request-document-context',publish); }
  });

  it('waits through a pending editor identity and overlays only the verified current buffer', async () => {
    await boot(); vi.useFakeTimers(); document.body.innerHTML='<button role="treeitem" aria-selected="true">main.tex</button>';
    let attempts=0;
    const publish=(event:Event)=>window.dispatchEvent(new CustomEvent('opt:document-context-result',{detail:JSON.stringify({id:JSON.parse((event as CustomEvent<string>).detail).id,...(++attempts<3 ? {ok:false,pending:true} : {ok:true,name:'main.tex',text:'Verified unsaved source'})})}));
    window.addEventListener('opt:request-document-context',publish);
    try {
      const sending=mocks.panelOptions!.onSend('Use my latest changes'); await vi.advanceTimersByTimeAsync(400); await sending;
      expect(attempts).toBe(3);
      expect(mocks.captureFull.mock.calls[0][0].liveDocuments.get('main.tex')).toBe('Verified unsaved source');
      expect(mocks.sourceRequest).toHaveBeenCalledWith('source-chunk',expect.objectContaining({path:'main.tex',content:'Verified unsaved source'}));
      expect(mocks.request.mock.calls.filter(([op])=>op==='ask')).toHaveLength(1);
      expect(mocks.panel.setCacheNotice).toHaveBeenLastCalledWith(null);
    } finally { window.removeEventListener('opt:request-document-context',publish); }
  });

  it('still blocks the question with a cache error when the fallback source export fails', async () => {
    await boot(); vi.useFakeTimers(); document.body.innerHTML='<button role="treeitem" aria-selected="true">main.tex</button>';
    mocks.captureFull.mockRejectedValueOnce(new Error('Fresh project export unavailable'));
    const sending=mocks.panelOptions!.onSend('Keep this question'); const rejected=expect(sending).rejects.toThrow('Fresh project export unavailable');
    await vi.advanceTimersByTimeAsync(1500); await rejected;
    expect(mocks.captureFull.mock.calls[0][0].liveDocuments.size).toBe(0);
    expect(mocks.sourceRequest).not.toHaveBeenCalled();
    expect(mocks.request.mock.calls.some(([op])=>op==='ask')).toBe(false);
    expect(mocks.panel.setCacheNotice).toHaveBeenLastCalledWith('error');
    expect(mocks.panel.setMessages).toHaveBeenLastCalledWith([]);
  });

  it('does not download or ask after cancelling a pending editor capture', async () => {
    await boot(); vi.useFakeTimers(); document.body.innerHTML='<button role="treeitem" aria-selected="true">main.tex</button>';
    const sending=mocks.panelOptions!.onSend('Stop before sending'); await flush();
    mocks.panelOptions!.onCancel(); await vi.advanceTimersByTimeAsync(1500); await sending;
    expect(mocks.captureFull).not.toHaveBeenCalled(); expect(mocks.sourceRequest).not.toHaveBeenCalled();
    expect(mocks.request.mock.calls.some(([op])=>op==='ask')).toBe(false);
    expect(mocks.saveMessages).not.toHaveBeenCalled();
    expect(mocks.panel.setStatus).toHaveBeenLastCalledWith('Stopped.');
  });

  it('honors selection-only scope without reading or uploading the project', async () => {
    await boot(); await mocks.actions!.saveCodex!({...DEFAULT_CODEX_SETTINGS,contextMode:'selection'});
    await mocks.panelOptions!.onSend('Only this passage',selection);
    expect(mocks.captureFull).not.toHaveBeenCalled();expect(mocks.sourceRequest).not.toHaveBeenCalled();
    const ask=mocks.request.mock.calls.find(([op])=>op==='ask')![1];expect(ask.selection).toEqual(selection);expect(ask).not.toHaveProperty('snapshotId');
  });

  it('fails clearly before model admission when the complete snapshot cannot be committed', async () => {
    await boot();mocks.sourceRequest.mockImplementation(async(op:string)=>{if(op==='source-commit')throw new Error('Source digest mismatch');return {id:'source',type:'source',uploadId:'12345678-1234-4234-8234-123456789abc'};});
    await expect(mocks.panelOptions!.onSend('Retain my question',selection)).rejects.toThrow('Complete project synchronization failed');
    expect(mocks.request.mock.calls.some(([op])=>op==='ask')).toBe(false);expect(mocks.saveMessages).not.toHaveBeenCalled();
    expect(mocks.panel.setMessages).toHaveBeenLastCalledWith([]);expect(mocks.model!().codexBusy).toBe(false);
  });
  it('preserves prepared references while opening a quoted file, then accepts deliberate selections again', async () => {
    await boot();
    const navigation = deferred<void>(); mocks.revealSource.mockReturnValue(navigation.promise);
    const publish = (message: object) => window.dispatchEvent(new CustomEvent('opt:editor', { detail: JSON.stringify({ type: 'selection', ...message }) }));
    mocks.panel.setSelection.mockClear(); mocks.panel.clearSelection.mockClear();
    const returning = mocks.panelOptions!.onRevealSource!(selection);
    expect(mocks.revealSource).toHaveBeenCalledWith(selection, { signal: mocks.panelOptions!.context!.signal, files: ['main.tex'] });
    publish({ selection: null, name: 'main.tex', clear: true });
    publish({ selection });
    expect(mocks.panel.setSelection).not.toHaveBeenCalled();
    expect(mocks.panel.clearSelection).not.toHaveBeenCalled();
    expect(mocks.panel.clearAnswerQuote).not.toHaveBeenCalled();
    navigation.resolve(); await returning;
    publish({ selection }); expect(mocks.panel.setSelection).toHaveBeenCalledExactlyOnceWith(selection);
    publish({ selection: null, name: 'main.tex', clear: true }); expect(mocks.panel.clearSelection).toHaveBeenCalledOnce();
  });
  it('releases selection suppression after navigation fails and refuses stale extension navigation', async () => {
    await boot(); mocks.revealSource.mockRejectedValue(new Error('Source changed'));
    await expect(mocks.panelOptions!.onRevealSource!(selection)).rejects.toThrow('Source changed');
    mocks.panel.clearSelection.mockClear();
    window.dispatchEvent(new CustomEvent('opt:editor', { detail: JSON.stringify({ type: 'selection', selection: null, name: 'main.tex', clear: true }) }));
    expect(mocks.panel.clearSelection).toHaveBeenCalledOnce();
    mocks.panelOptions!.context!.invalidate('pagehide');
    await expect(mocks.panelOptions!.onRevealSource!(selection)).rejects.toThrow('Refresh this page');
    expect(mocks.revealSource).toHaveBeenCalledOnce();
  });
  it('clears a source quote on deliberate deselection but retains it across a passive empty snapshot', async () => {
    await boot(); mocks.panel.clearSelection.mockClear();
    const publish = (message: object) => window.dispatchEvent(new CustomEvent('opt:editor', { detail: JSON.stringify({ type: 'selection', ...message }) }));
    publish({ selection }); expect(mocks.panel.setSelection).toHaveBeenLastCalledWith(selection);
    publish({ selection: null, name: 'main.tex' });
    expect(mocks.panel.clearSelection).not.toHaveBeenCalled();
    publish({ selection: null, name: 'main.tex', clear: true });
    expect(mocks.panel.clearSelection).toHaveBeenCalledOnce();
    expect(mocks.panel.clearAnswerQuote).not.toHaveBeenCalled();
  });
  it('transmits an exact answer quote alongside an editor selection and keeps both in display history',async()=>{
    withAccount();mocks.request.mockResolvedValue(historyPage());await boot();
    const answerQuote={text:'The result is \\(x^2\\).',messageId:'m2'};
    mocks.request.mockImplementation(async(op:string)=>op==='ask'?{id:'ask',type:'done',text:'Quoted answer explained'}:historyPage());
    await mocks.panelOptions!.onSend('Why this step?',selection,answerQuote);
    expect(mocks.panel.appendMessage).toHaveBeenCalledWith('user','Why this step?',{...selection,before:'',after:''},answerQuote);
    expect(mocks.request).toHaveBeenLastCalledWith('ask',expect.objectContaining({question:'Why this step?',selection,answerQuote}),expect.any(Function));
    expect(mocks.saveMessages).toHaveBeenLastCalledWith(expect.any(String),expect.any(String),[...initialMessages,{role:'user',text:'Why this step?',selection:{...selection,before:'',after:''},answerQuote},{role:'assistant',text:'Quoted answer explained'}]);
  });

  it('clears a prepared answer quote on explicit conversation change',async()=>{
    withAccount();mocks.request.mockResolvedValue(historyPage());await boot();
    await mocks.panelOptions!.onSelectConversation!(conversationId);
    expect(mocks.panel.clearAnswerQuote).toHaveBeenCalledOnce();
    mocks.panel.clearAnswerQuote.mockClear();
    await mocks.panelOptions!.onNewChat();
    expect(mocks.panel.clearAnswerQuote).toHaveBeenCalledOnce();
  });

  it('updates visible remote history through reconciliation without clearing selection or rebuilding the transcript',async()=>{
    withAccount();mocks.request.mockResolvedValue(historyPage());await boot();
    mocks.panel.setMessages.mockClear();mocks.panel.clearSelection.mockClear();
    const next=[...initialMessages,{messageId:'m3',role:'user' as const,text:'Desktop question'},{messageId:'m4',role:'assistant' as const,text:'Desktop partial'}];
    mocks.request.mockResolvedValue(historyPage(next,{remoteState:'active',syncRevision:'b'.repeat(64)}));
    openForSynchronization();await flush();
    expect(mocks.request.mock.calls.filter(([op])=>op==='history-read').at(-1)).toEqual(['history-read',{conversationId}]);
    expect(mocks.panel.syncMessages).toHaveBeenCalledExactlyOnceWith(next);
    expect(mocks.panel.setRemoteState).toHaveBeenLastCalledWith('active');
    expect(mocks.panel.setMessages).not.toHaveBeenCalled();expect(mocks.panel.clearSelection).not.toHaveBeenCalled();
    expect(mocks.panel.setBusy).toHaveBeenLastCalledWith(false);
    mocks.panel.syncMessages.mockClear();mocks.panelOptions!.onVisibilityChange!(true);await flush();
    expect(mocks.panel.syncMessages).not.toHaveBeenCalled();
  });

  it('waits for an outstanding poll before send, discards its stale display update, and asks against a fresh revision',async()=>{
    withAccount();mocks.request.mockResolvedValue(historyPage());await boot();
    const polling=deferred<CodexEvent>();let reads=0;
    const fresh=[...initialMessages,{messageId:'m3',role:'user' as const,text:'Desktop follow-up'},{messageId:'m4',role:'assistant' as const,text:'Desktop final answer'}];
    mocks.request.mockImplementation(async(op:string)=>{
      if(op==='history-read')return ++reads===1?polling.promise:historyPage(fresh,{syncRevision:'b'.repeat(64)});
      if(op==='ask'){mocks.panel.isOpen.mockReturnValue(false);return {id:'ask',type:'done',text:'Answer to this selection'};}
      throw new Error('Unexpected request '+op);
    });
    openForSynchronization();await flush();
    const sending=mocks.panelOptions!.onSend('Explain this',selection);await flush();
    expect(reads).toBe(1);expect(mocks.request.mock.calls.some(call=>call[0]==='ask')).toBe(false);
    polling.resolve(historyPage([...initialMessages,{messageId:'m3',role:'user',text:'Stale snapshot'}]));
    await sending;
    expect(mocks.panel.syncMessages).not.toHaveBeenCalled();
    expect(mocks.request.mock.calls.filter(([op])=>op==='ask').at(-1)).toEqual(['ask',expect.objectContaining({question:'Explain this',selection,expectedConversationId:conversationId,expectedSyncRevision:'b'.repeat(64)}),expect.any(Function)]);
    expect(mocks.saveMessages).toHaveBeenLastCalledWith(expect.any(String),expect.any(String),[...fresh,{role:'user',text:'Explain this',selection:{...selection,before:'',after:''}},{role:'assistant',text:'Answer to this selection'}]);
  });

  it('resumes model discovery deferred behind a poll and keeps later synchronization available',async()=>{
    withAccount();mocks.request.mockResolvedValue(historyPage());await boot();
    const polling=deferred<CodexEvent>();let reads=0;
    mocks.request.mockImplementation(async(op:string)=>{
      if(op==='history-read')return ++reads===1?polling.promise:historyPage();
      return {id:'models',type:'status',available:true,authenticated:true,models:[{id:'test-model',displayName:'Test model'}]};
    });
    openForSynchronization();await flush();await mocks.actions!.checkCodex!();
    expect(mocks.model!().codexModelsLoading).toBe(true);
    expect(mocks.request.mock.calls.some(call=>call[0]==='status')).toBe(false);
    polling.resolve(historyPage());await flush();
    expect(mocks.request.mock.calls.filter(call=>call[0]==='status')).toHaveLength(1);
    expect(mocks.model!().codexModelsLoading).toBe(false);
    mocks.panelOptions!.onVisibilityChange!(true);await flush();expect(reads).toBe(2);
  });

  it('recovers a failed poll without replacing the transcript or clearing the quoted selection',async()=>{
    withAccount();mocks.request.mockResolvedValue(historyPage());await boot();
    mocks.panel.setMessages.mockClear();mocks.panel.clearSelection.mockClear();
    mocks.request.mockRejectedValueOnce(new Error('Native connection temporarily unavailable'));
    openForSynchronization();await flush();expect(mocks.panel.setRemoteState).toHaveBeenLastCalledWith('unknown');
    expect(mocks.panel.setMessages).not.toHaveBeenCalled();expect(mocks.panel.clearSelection).not.toHaveBeenCalled();
    mocks.request.mockResolvedValue(historyPage());mocks.panelOptions!.onVisibilityChange!(true);await flush();
    expect(mocks.panel.setRemoteState).toHaveBeenLastCalledWith('idle');expect(mocks.panel.syncMessages).not.toHaveBeenCalled();
  });

  it('recovers startup history while visible even before an active conversation ID is known',async()=>{
    withAccount();mocks.request.mockRejectedValueOnce(new Error('Temporary helper failure')).mockResolvedValue(historyPage());
    await boot();expect(mocks.panel.setRemoteState).toHaveBeenLastCalledWith('unknown');
    mocks.panel.setMessages.mockClear();openForSynchronization();await flush();
    expect(mocks.request.mock.calls.filter(([op])=>op==='history-read').at(-1)).toEqual(['history-read',{}]);
    expect(mocks.panel.syncMessages).toHaveBeenCalledExactlyOnceWith(initialMessages);
    expect(mocks.panel.setRemoteState).toHaveBeenLastCalledWith('idle');expect(mocks.panel.setStatus).toHaveBeenLastCalledWith('');
    expect(mocks.panel.setMessages).not.toHaveBeenCalled();
    mocks.panelOptions!.onVisibilityChange!(true);await flush();expect(mocks.request.mock.calls.filter(([op])=>op==='history-read').at(-1)).toEqual(['history-read',{conversationId}]);
  });

  it('automatically recovers empty cached history after another page releases the project',async()=>{
    withAccount();
    const pending:CodexEvent={id:'pending',type:'history',messages:[],remoteState:'unknown',syncPending:true};
    mocks.request.mockResolvedValue(pending);await boot();
    expect(mocks.panel.setRemoteState).toHaveBeenLastCalledWith('unknown',true);
    mocks.panel.setMessages.mockClear();mocks.panel.clearSelection.mockClear();mocks.panel.clearAnswerQuote.mockClear();
    vi.useFakeTimers();openForSynchronization();await vi.advanceTimersByTimeAsync(0);
    expect(mocks.request.mock.calls.filter(([op])=>op==='history-read').at(-1)).toEqual(['history-read',{}]);
    expect(mocks.panel.setRemoteState).toHaveBeenLastCalledWith('unknown',true);
    mocks.request.mockResolvedValue(historyPage());await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.panel.setRemoteState).toHaveBeenLastCalledWith('idle');
    expect(mocks.panel.syncMessages).toHaveBeenCalledExactlyOnceWith(initialMessages);
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.request.mock.calls.filter(([op])=>op==='history-read').at(-1)).toEqual(['history-read',{conversationId}]);
    expect(mocks.request.mock.calls.some(([op])=>['ask','new-chat','history-select'].includes(op))).toBe(false);
    expect(mocks.panel.setMessages).not.toHaveBeenCalled();expect(mocks.panel.clearSelection).not.toHaveBeenCalled();expect(mocks.panel.clearAnswerQuote).not.toHaveBeenCalled();
    expect(mocks.sourceRequest).not.toHaveBeenCalled();
  });

  it('keeps this page pinned to its conversation while another page has selected a different chat',async()=>{
    withAccount();mocks.request.mockResolvedValue(historyPage());await boot();
    const otherConversationId='01a18cbd-8295-7070-8093-1902e8a20547';
    mocks.request.mockResolvedValue(historyPage(initialMessages,{activeConversationId:otherConversationId,remoteState:'unknown',syncPending:true,syncRevision:undefined}));
    mocks.panel.setMessages.mockClear();openForSynchronization();await flush();
    expect(mocks.panel.setRemoteState).toHaveBeenLastCalledWith('unknown',true);
    expect(mocks.panel.syncMessages).not.toHaveBeenCalled();
    mocks.request.mockResolvedValue(historyPage(initialMessages,{activeConversationId:otherConversationId}));
    mocks.panelOptions!.onVisibilityChange!(true);await flush();
    expect(mocks.request.mock.calls.filter(([op])=>op==='history-read').slice(1)).toEqual([
      ['history-read',{conversationId}],['history-read',{conversationId}],
    ]);
    expect(mocks.panel.setRemoteState).toHaveBeenLastCalledWith('idle');
    expect(mocks.panel.syncMessages).not.toHaveBeenCalled();expect(mocks.panel.setMessages).not.toHaveBeenCalled();
    expect(mocks.request.mock.calls.some(([op])=>['ask','new-chat','history-select'].includes(op))).toBe(false);
  });

  it.each(['select','new'] as const)('does not send a delayed %s mutation after the page context has retired',async(operation)=>{
    await boot();const status=deferred<CodexEvent>();
    mocks.request.mockImplementation(async(op:string)=>op==='status'?status.promise:{id:'changed',type:'done'});
    const catalogue=mocks.actions!.openCodex!();await flush();
    const changing=Promise.resolve(operation==='select'?mocks.panelOptions!.onSelectConversation!(conversationId):mocks.panelOptions!.onNewChat()).catch(()=>{});
    await flush();expect(mocks.request.mock.calls.map(call=>call[0])).toEqual(['provider-list','status']);
    mocks.panelOptions!.context!.invalidate('pagehide');
    status.resolve({id:'models',type:'status',available:true,authenticated:true,models:[{id:'test-model',displayName:'Test model'}]});
    await catalogue;await changing;
    expect(mocks.request.mock.calls.map(call=>call[0])).toEqual(['provider-list','status']);
  });

  it('refuses a turn if preflight discovers the desktop began replying after the last displayed snapshot',async()=>{
    withAccount();mocks.request.mockResolvedValue(historyPage());await boot();
    const discoveries=mocks.discover.mock.calls.length;
    mocks.request.mockResolvedValue(historyPage(initialMessages,{remoteState:'active',syncRevision:'b'.repeat(64)}));
    await expect(mocks.panelOptions!.onSend('Continue',selection)).rejects.toThrow('desktop');
    expect(mocks.request.mock.calls.some(call=>call[0]==='ask')).toBe(false);
    expect(mocks.discover).toHaveBeenCalledTimes(discoveries);expect(mocks.panel.setRemoteState).toHaveBeenLastCalledWith('active');
    expect(mocks.model!().codexBusy).toBe(false);
    expect(mocks.panel.setMessages).toHaveBeenLastCalledWith(initialMessages);
  });

  it('removes an explicitly rejected optimistic question while retaining fresh synchronized history',async()=>{
    withAccount();mocks.request.mockResolvedValue(historyPage());await boot();
    const fresh=[...initialMessages,{messageId:'m3',role:'user' as const,text:'New desktop question'},{messageId:'m4',role:'assistant' as const,text:'New desktop answer'}];
    mocks.request.mockImplementation(async(op,data,onEvent)=>{
      if(op==='ask') { onEvent?.({id:'ask',type:'error',notAccepted:true,message:'Invalid context name'});throw new Error('Invalid context name'); }
      return historyPage(fresh);
    });
    await expect(mocks.panelOptions!.onSend('Rejected question',selection)).rejects.toThrow('Invalid context name');
    expect(mocks.panel.appendMessage).toHaveBeenCalledWith('user','Rejected question',expect.any(Object));
    expect(mocks.panel.setMessages).toHaveBeenLastCalledWith(fresh);
    expect(mocks.request.mock.calls.filter(call=>call[0]==='ask')).toHaveLength(1);
  });

  it.each(['uncertain','acknowledged','partial'])('keeps uncertain or acknowledged questions after an error (%s)',async(state)=>{
    withAccount();mocks.request.mockResolvedValue(historyPage());await boot();
    mocks.panel.setMessages.mockClear();
    mocks.request.mockImplementation(async(op,data,onEvent)=>{
      if(op==='ask') {
        if(state!=='uncertain'){
          onEvent?.({id:'ask',type:'started',threadId:conversationId,turnId:'active'});
          if(state==='partial')onEvent?.({id:'ask',type:'delta',text:'Partial answer'});
          onEvent?.({id:'ask',type:'error',notAccepted:true,message:'Contradictory rejection after acceptance'});
        }
        throw new Error('Disconnected after sending');
      }
      return historyPage();
    });
    await expect(mocks.panelOptions!.onSend('Possibly received',selection)).rejects.toThrow('Disconnected');
    expect(mocks.panel.setMessages).not.toHaveBeenCalled();
    if(state==='partial')expect(mocks.panel.setAssistantText).toHaveBeenLastCalledWith('Partial answer');
    expect(mocks.request.mock.calls.filter(call=>call[0]==='ask')).toHaveLength(1);
  });

  it('does not let a delayed browser cache refresh overwrite a newly selected native conversation',async()=>{
    withAccount();mocks.request.mockRejectedValue(new Error('History temporarily unavailable'));await boot();
    const cache=deferred<CodexMessage[]>();mocks.loadMessages.mockReturnValueOnce(cache.promise);
    const changed=vi.mocked(chrome.storage.onChanged.addListener).mock.calls[0][0];
    changed({'codex:abcdef0123456789abcdef01:0123456789abcdef01234567:messages':{newValue:[]}},'local');
    const selected=[{messageId:'m9',role:'user' as const,text:'Selected native conversation'}];
    mocks.request.mockResolvedValue(historyPage(selected));await mocks.panelOptions!.onSelectConversation!(conversationId);
    mocks.panel.setMessages.mockClear();cache.resolve([{role:'user',text:'Stale browser cache'}]);await flush();
    expect(mocks.panel.setMessages).not.toHaveBeenCalled();
  });

  it('recovers startup history failure before asking and pins the expected active conversation', async () => {
    const account=document.createElement('meta');account.name='ol-user_id';account.content='abcdef0123456789abcdef01';document.head.append(account);
    const id='01a18cbd-8295-7070-8093-1902e8a20546';let reads=0;
    const messages:CodexMessage[]=[{role:'user',text:'Previous question'},{role:'assistant',text:'Previous answer'}];
    mocks.request.mockImplementation(async(op:string)=>{
      if(op==='history-read'){
        if(++reads===1)throw new Error('Temporary helper failure');
        return {id:'read',type:'history',conversationId:id,messages};
      }
      return {id:'ask',type:'done',text:'Continued answer'};
    });
    await boot();expect(mocks.panel.setStatus).toHaveBeenLastCalledWith(expect.stringContaining('Local history is unavailable'));
    await mocks.panelOptions!.onSend('Continue');
    expect(reads).toBe(2);
    expect(mocks.request).toHaveBeenLastCalledWith('ask',expect.objectContaining({expectedConversationId:id}),expect.any(Function));
    expect(mocks.saveMessages).toHaveBeenLastCalledWith(expect.any(String),account.content,[...messages,{role:'user',text:'Continue'},{role:'assistant',text:'Continued answer'}]);
    account.remove();
  });
  it('switches scoped local history, prepends older pages, and keeps them when sending again', async () => {
    await boot();mocks.request.mockClear();mocks.panel.setMessages.mockClear();mocks.loadMessages.mockClear();
    const id='01a18cbd-8295-7070-8093-1902e8a20546';
    const current:CodexMessage[]=[{role:'user',text:'Recent question'},{role:'assistant',text:'Recent answer'}];
    const older:CodexMessage[]=[{role:'user',text:'First question'},{role:'assistant',text:'First answer'}];
    mocks.request.mockImplementation(async(op:string,data:{cursor?:string}={})=>{
      if(op==='history-list')return {id:'list',type:'history',conversations:[{id,title:'Saved conversation',updatedAt:1000,current:true}]};
      if(op==='history-select')return {id:'select',type:'history',conversationId:id,messages:current,nextCursor:'older'};
      if(op==='history-read' && data.cursor==='older')return {id:'read',type:'history',conversationId:id,messages:older};
      return {id:'ask',type:'done',text:'New answer'};
    });
    expect((await mocks.panelOptions!.onListConversations!()).conversations).toHaveLength(1);
    await mocks.panelOptions!.onSelectConversation!(id);
    expect(mocks.panel.setMessages).toHaveBeenLastCalledWith(current);
    expect(mocks.panel.setHistoryPaging).toHaveBeenLastCalledWith({hasOlder:true});
    await mocks.panelOptions!.onLoadOlderMessages!();
    expect(mocks.panel.prependMessages).toHaveBeenLastCalledWith(older);
    expect(mocks.panel.setHistoryPaging).toHaveBeenLastCalledWith({hasOlder:false});
    await mocks.panelOptions!.onSend('Continue');
    expect(mocks.loadMessages).not.toHaveBeenCalled();
    expect(mocks.saveMessages).toHaveBeenLastCalledWith(expect.any(String),undefined,[...older,...current,{role:'user',text:'Continue'},{role:'assistant',text:'New answer'}]);
  });

  it('retains the current messages on failed history selection and clears only after successful New conversation', async () => {
    await boot();mocks.panel.setMessages.mockClear();
    mocks.request.mockRejectedValueOnce(new Error('Local helper unavailable'));
    await expect(mocks.panelOptions!.onSelectConversation!('01a18cbd-8295-7070-8093-1902e8a20546')).rejects.toThrow('unavailable');
    expect(mocks.panel.setMessages).not.toHaveBeenCalled();expect(mocks.model!().codexBusy).toBe(false);
    mocks.request.mockResolvedValueOnce({id:'new',type:'done'});
    await mocks.panelOptions!.onNewChat();
    expect(mocks.panel.setMessages).toHaveBeenLastCalledWith([]);expect(mocks.panel.setHistoryPaging).toHaveBeenLastCalledWith({hasOlder:false});
    expect(mocks.request).toHaveBeenLastCalledWith('new-chat');
  });
  it('shows the question and exact quote immediately while catalogue discovery is pending, then cancels without reading project context or asking', async () => {
    await boot(); expect(mocks.model!().busy).toBe(false);
    const status = deferred<CodexEvent>(); mocks.request.mockImplementation((op: string) => op === 'status' ? status.promise : Promise.resolve({ id: 'test', type: 'done', text: '' }));
    const loading = mocks.actions!.openCodex!(); await flush();
    expect(mocks.request.mock.calls.map(call=>call[0])).toEqual(['provider-list','status']);
    expect(mocks.model!().codexModelsLoading).toBe(true);
    const discoveries = mocks.discover.mock.calls.length;
    const sending = mocks.panelOptions!.onSend('Explain this selection', selection);
    // No awaited catalogue/history operation can hide the submitted question.
    expect(mocks.panel.appendMessage).toHaveBeenNthCalledWith(1, 'user', 'Explain this selection', { ...selection, before: '', after: '' });
    expect(mocks.panel.appendMessage).toHaveBeenNthCalledWith(2, 'assistant', '');
    expect(mocks.panel.setBusy).toHaveBeenLastCalledWith(true);
    expect(mocks.panel.setStatus).toHaveBeenLastCalledWith('Connecting to local Codex…');
    await flush(); mocks.panelOptions!.onCancel();
    status.resolve({ id: 'catalogue', type: 'status', available: true, authenticated: true, models: [{ id: 'test-model', displayName: 'Test model' }] });
    await loading; await sending;
    expect(mocks.request.mock.calls.map(call => call[0])).toEqual(['provider-list','status']);
    expect(mocks.discover).toHaveBeenCalledTimes(discoveries); expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.saveMessages).not.toHaveBeenCalled(); expect(mocks.model!().codexBusy).toBe(false);
    expect(mocks.panel.setBusy).toHaveBeenLastCalledWith(false); expect(mocks.panel.setStatus).toHaveBeenLastCalledWith('Stopped.');
  });

  it('restores historical answers only after project macros are available to the panel renderer', async () => {
    const history: CodexMessage[] = [{ role: 'user', text: 'Explain the notation', selection: { ...selection, before: '', after: '' } }, { role: 'assistant', text: 'The notation is \\(\\RR\\).' }];
    mocks.loadMessages.mockResolvedValue(history);
    const built = deferred<ProjectIndex>(); mocks.buildIndex.mockReturnValue(built.promise);
    await boot();
    expect(mocks.buildIndex).toHaveBeenCalledOnce(); expect(mocks.model!().busy).toBe(true);
    expect(mocks.panel.setMessages).not.toHaveBeenCalled();
    built.resolve({ ...emptyIndex(), macros: [{ name: 'RR', body: '\\mathbb{R}', args: 0, raw: '\\newcommand{\\RR}{\\mathbb{R}}', kind: 'newcommand', source: 'main.tex', offset: 0, supported: true }] });
    await flush();
    expect(mocks.panel.setMessages).toHaveBeenCalledExactlyOnceWith(history);
    expect(mocks.renderedMacros).toEqual([['RR']]); expect(mocks.model!().busy).toBe(false);
  });

  it('stops after a pending complete-project capture without uploading source or starting an ask', async () => {
    await boot();
    const discovered = deferred<typeof project>();
    mocks.discover.mockReturnValueOnce(discovered.promise);
    const discoveries = mocks.discover.mock.calls.length;
    const sending = mocks.panelOptions!.onSend('Explain this selection', selection);
    await flush();
    expect(mocks.discover).toHaveBeenCalledTimes(discoveries + 1);
    expect(mocks.sourceRequest).not.toHaveBeenCalled();
    expect(mocks.model!().codexBusy).toBe(true);
    mocks.panelOptions!.onCancel();
    discovered.resolve(project);
    await sending;
    expect(mocks.sourceRequest).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.saveMessages).not.toHaveBeenCalled();
    expect(mocks.model!().codexBusy).toBe(false);
    expect(mocks.panel.setBusy).toHaveBeenLastCalledWith(false);
    expect(mocks.panel.setStatus).toHaveBeenLastCalledWith('Stopped.');
  });
});

describe('optional API source integration', () => {
  const api='11111111-2222-3333-4444-555555555555';
  const apiConversation='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const apiMessages:CodexMessage[]=[{role:'user',text:'API-only question'},{role:'assistant',text:'API-only answer'}];
  function route() {
    mocks.request.mockImplementation(async(op,data,onEvent)=>{
      if(op==='status')return{id:'status',type:'status',available:true,authenticated:true,models:[{id:data?.providerId?'synthetic-api-model':'gpt-6-astra',displayName:data?.providerId?'Synthetic API model':'GPT-6-Astra'}]};
      if(op==='provider-list')return{id:'profiles',type:'profiles',profiles:[{id:api,name:'Synthetic API',baseUrl:'http://127.0.0.1:7777',model:'synthetic',hasKey:false}]};
      if(op==='history-read')return historyPage(data?.providerId?apiMessages:initialMessages,{conversationId:data?.providerId?apiConversation:conversationId});
      if(op==='ask'){onEvent?.({id:'ask',type:'delta',text:'Answer with source'});return{id:'ask',type:'done',text:'Answer with source'};}
      return{id:'other',type:'done'};
    });
  }
  it('keeps Codex as default, restores independent API history and routes fresh project context only to the selected provider',async()=>{
    withAccount();route();await boot();
    expect(mocks.model!().codex?.providerId).toBeUndefined();
    await mocks.actions!.refreshCodexProviders!();
    await mocks.actions!.saveCodex!({...DEFAULT_CODEX_SETTINGS,providerId:api});
    expect(mocks.panel.setMessages).toHaveBeenLastCalledWith(apiMessages);
    expect(mocks.panel.clearAnswerQuote).toHaveBeenCalled();
    expect(mocks.panelOptions!.getSettings()).toEqual(expect.objectContaining({providerId:api,providerName:'Synthetic API'}));
    await flush();expect(mocks.request).toHaveBeenCalledWith('status',{providerId:api});
    expect(mocks.panel.setConnection).toHaveBeenLastCalledWith(expect.objectContaining({state:'connected'}));
    expect(mocks.model!().codexModels?.[0].id).toBe('synthetic-api-model');
    await mocks.panelOptions!.onSend('Explain this selection',selection);
    const ask=mocks.request.mock.calls.find(([op])=>op==='ask')![1];
    expect(ask).toEqual(expect.objectContaining({providerId:api,selection,expectedConversationId:apiConversation,files:[],snapshotId:'ab'.repeat(32)}));
    expect(mocks.sourceRequest).toHaveBeenCalledWith('source-chunk',expect.objectContaining({path:'main.tex',content:'Synthetic source'}));
    for(const [,data] of mocks.sourceRequest.mock.calls)expect(data).not.toHaveProperty('providerId');
    expect(ask).not.toHaveProperty('apiKey');
    expect(JSON.stringify(ask)).not.toContain('Earlier question');
    expect(mocks.saveMessages).toHaveBeenLastCalledWith(expect.any(String),expect.any(String),expect.any(Array),api);
    await mocks.actions!.saveCodex!({...DEFAULT_CODEX_SETTINGS});
    expect(mocks.panel.setMessages).toHaveBeenLastCalledWith(initialMessages);
    expect(mocks.model!().codex?.providerId).toBeUndefined();
  });
  it('reserves the connection across source persistence and history loading so a new send cannot race the switch',async()=>{
    withAccount();route();await boot();mocks.close.mockClear();mocks.request.mockClear();
    const storage=deferred<void>(),historyRead=deferred<CodexEvent>();
    mocks.saveCodexSettings.mockReturnValueOnce(storage.promise);
    const normal=mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation((op,data,onEvent)=>op==='history-read' && data?.providerId===api?historyRead.promise:normal(op,data,onEvent));
    const saving=mocks.actions!.saveCodex!({...DEFAULT_CODEX_SETTINGS,providerId:api});await flush();
    expect(mocks.saveCodexSettings).toHaveBeenCalledTimes(1);expect(mocks.model!().codexBusy).toBe(true);
    expect(mocks.model!().codex?.providerId).toBeUndefined();expect(mocks.close).not.toHaveBeenCalled();
    await expect(mocks.panelOptions!.onSend('Do not race storage',selection)).rejects.toThrow('Wait for the current operation');
    expect(mocks.request.mock.calls.some(([op])=>op==='ask')).toBe(false);
    storage.resolve();await flush();
    expect(mocks.model!().codex?.providerId).toBe(api);expect(mocks.model!().codexBusy).toBe(true);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.request).toHaveBeenCalledWith('history-read',{providerId:api});
    await expect(mocks.panelOptions!.onSend('Do not race history',selection)).rejects.toThrow('Wait for the current operation');
    expect(mocks.request.mock.calls.some(([op])=>op==='ask')).toBe(false);
    historyRead.resolve(historyPage(apiMessages,{conversationId:apiConversation}));await saving;await flush();
    expect(mocks.model!().codexBusy).toBe(false);expect(mocks.panel.setMessages).toHaveBeenLastCalledWith(apiMessages);
    expect(mocks.request.mock.calls.some(([op])=>op==='ask')).toBe(false);
  });

  it('waits for a previous-provider poll before switching and never applies it after the new history',async()=>{
    withAccount();route();await boot();openForSynchronization();await flush();
    const pending=deferred<CodexEvent>();let delayed=true;
    const normal=mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation((op,data,onEvent)=>op==='history-read'&&!data?.providerId&&delayed?(delayed=false,pending.promise):normal(op,data,onEvent));
    mocks.panelOptions!.onVisibilityChange!(true);await flush();
    const saved=mocks.actions!.saveCodex!({...DEFAULT_CODEX_SETTINGS,providerId:api});await flush();
    expect(mocks.model!().codex?.providerId).toBeUndefined();
    pending.resolve(historyPage([{role:'assistant',text:'Old provider late reply'}]));
    await saved;await flush();
    expect(mocks.panel.setMessages).toHaveBeenLastCalledWith(apiMessages);
    expect(mocks.model!().codex?.providerId).toBe(api);
  });
});

describe('captured follow-up queue and active-turn steering',()=>{
  it('retains legacy project queue entries for editing but never sends their partial context as a complete snapshot', async () => {
    withAccount();mocks.request.mockResolvedValue(historyPage());
    const legacy={id:'legacy',state:'queued',prompt:{question:'Old excerpt question',settings:{...DEFAULT_CODEX_SETTINGS},files:[{path:'main.tex',content:'% CONTEXT EXCERPT'}],note:'',conversationId}};
    chrome.runtime.sendMessage=vi.fn(async(value)=>value.action==='read'?{ok:true,revision:'',items:[legacy]}:{ok:true,revision:crypto.randomUUID()}) as any;
    await boot();expect(mocks.panel.setQueue.mock.lastCall![0][0].prompt.question).toBe('Old excerpt question');
    mocks.panelOptions!.onResumeQueue!();await flush();
    expect(mocks.request.mock.calls.some(([op])=>op==='ask')).toBe(false);expect(mocks.sourceRequest).not.toHaveBeenCalled();
    expect(mocks.panel.setQueue.mock.lastCall![0][0]).toMatchObject({state:'failed',error:expect.stringContaining('only excerpts')});
  });
  it('updates the busy-message preference without changing the model request settings',async()=>{
    await boot();expect(mocks.panelOptions!.getSettings().busyMessageBehavior).toBe('queue');
    await mocks.actions!.setCodexBusyMessageBehavior!('steer');
    expect(mocks.panelOptions!.getSettings().busyMessageBehavior).toBe('steer');
    expect(mocks.model!().codex).not.toHaveProperty('busyMessageBehavior');
  });
  it('promotes a queued item with its original files and quotes exactly once',async()=>{
    await boot();const first=deferred<CodexEvent>(),ack=deferred<CodexEvent>();
    mocks.readFile.mockResolvedValue('At enqueue');
    mocks.request.mockImplementation((op,data,onEvent)=>{
      if(op==='ask'){onEvent?.({id:'ask',type:'started',threadId:conversationId,turnId:'active',canSteer:true});return first.promise;}
      if(op==='steer')return ack.promise;return Promise.resolve({id:'other',type:'done'});
    });
    const sending=mocks.panelOptions!.onSend('First');await flush();
    await mocks.panelOptions!.onQueue!('Promote me',selection,{text:'Original quoted answer'});
    mocks.readFile.mockResolvedValue('Changed since queueing');
    const id=mocks.panel.setQueue.mock.lastCall![0][0].id;
    const promoting=mocks.panelOptions!.onSteerQueued!(id);await flush();
    await expect(mocks.panelOptions!.onSteerQueued!(id)).rejects.toThrow('cannot be sent again');
    expect(mocks.request.mock.calls.filter(([op])=>op==='steer')).toHaveLength(1);
    expect(mocks.request.mock.calls.find(([op])=>op==='steer')![1]).toEqual(expect.objectContaining({question:'Promote me',selection,answerQuote:{text:'Original quoted answer'},files:[],snapshotId:'ab'.repeat(32)}));
    expect(mocks.sourceRequest).toHaveBeenCalledWith('source-chunk',expect.objectContaining({path:'main.tex',content:'At enqueue'}));
    expect(mocks.sourceRequest.mock.calls.filter(([op])=>op==='source-commit')).toHaveLength(2);
    ack.resolve({id:'steer',type:'steered',threadId:conversationId,userMessageId:'promoted'});await promoting;
    expect(mocks.panel.setQueue.mock.lastCall![0]).toEqual([]);
    first.resolve({id:'ask',type:'done',text:'Completed'});await sending;await flush();
    expect(mocks.request.mock.calls.filter(([op])=>op==='ask')).toHaveLength(1);
  });
  it('keeps uncertain queued steering for review without replay on completion or resume',async()=>{
    await boot();const first=deferred<CodexEvent>();
    mocks.request.mockImplementation((op,data,onEvent)=>{
      if(op==='ask'){onEvent?.({id:'ask',type:'started',threadId:conversationId,turnId:'active',canSteer:true});return first.promise;}
      if(op==='steer')return Promise.reject(new Error('Uncertain delivery'));return Promise.resolve({id:'other',type:'done'});
    });
    const sending=mocks.panelOptions!.onSend('First');await flush();await mocks.panelOptions!.onQueue!('Promote me');
    const id=mocks.panel.setQueue.mock.lastCall![0][0].id;
    await expect(mocks.panelOptions!.onSteerQueued!(id)).rejects.toThrow('Uncertain delivery');
    expect(mocks.panel.setQueue.mock.lastCall![0][0].state).toBe('failed');
    first.resolve({id:'ask',type:'done',text:'Completed'});await sending;await flush();mocks.panelOptions!.onResumeQueue!();await flush();
    expect(mocks.request.mock.calls.filter(([op])=>op==='ask')).toHaveLength(1);
    expect(mocks.request.mock.calls.filter(([op])=>op==='steer')).toHaveLength(1);
  });
  it('holds a promotion until persisted and returns it to the paused queue if the turn ended first',async()=>{
    withAccount();mocks.request.mockResolvedValue(historyPage());const durable=deferred<void>();
    chrome.runtime.sendMessage=vi.fn(async(value)=>{if(value.action==='read')return {ok:true,revision:'',items:[]};if(value.items.some((x:any)=>x.state==='sending'))await durable.promise;return {ok:true,revision:crypto.randomUUID()};}) as any;
    await boot();const first=deferred<CodexEvent>();
    mocks.request.mockImplementation((op,data,onEvent)=>{if(op==='history-read')return Promise.resolve(historyPage());if(op==='ask'){onEvent?.({id:'ask',type:'started',threadId:conversationId,turnId:'active',canSteer:true});return first.promise;}return Promise.resolve({id:'other',type:'done'});});
    const sending=mocks.panelOptions!.onSend('First');await flush();await mocks.panelOptions!.onQueue!('Promote me');
    const promoting=mocks.panelOptions!.onSteerQueued!(mocks.panel.setQueue.mock.lastCall![0][0].id);
    const rejected=expect(promoting).rejects.toThrow('remains queued');await flush();
    expect(mocks.request.mock.calls.some(([op])=>op==='steer')).toBe(false);
    first.resolve({id:'ask',type:'done',text:'Completed'});await sending;durable.resolve();await rejected;
    expect(mocks.panel.setQueue.mock.lastCall![0][0].state).toBe('queued');expect(mocks.panel.setQueue.mock.lastCall![1]).toBe(true);
    expect(mocks.request.mock.calls.some(([op])=>op==='steer')).toBe(false);
  });
  it('sends FIFO after completion using captured context and exact quotations',async()=>{
    await boot();const first=deferred<CodexEvent>();const requests:any[]=[];
    let commits=0;mocks.sourceRequest.mockImplementation(async(op:string)=>({id:'source',type:'source',...(op==='source-commit'?{snapshotId:String(++commits).padStart(64,'0')}:{uploadId:'12345678-1234-4234-8234-123456789abc'})}));
    mocks.readFile.mockResolvedValue('At enqueue');
    mocks.request.mockImplementation((op,data,onEvent)=>{
      if(op==='ask'){requests.push(data);onEvent?.({id:'ask',type:'started',threadId:conversationId,turnId:'turn-'+requests.length,canSteer:true});return requests.length===1?first.promise:Promise.resolve({id:'ask',type:'done',text:'Answer '+requests.length});}
      return Promise.resolve({id:'other',type:'done'});
    });
    const sending=mocks.panelOptions!.onSend('First');await flush();
    await mocks.panelOptions!.onQueue!('Second',selection,{text:'Quoted formula \\(x\\)'});
    await mocks.panelOptions!.onQueue!('Third');expect(requests).toHaveLength(1);
    mocks.readFile.mockResolvedValue('Edited after enqueue');first.resolve({id:'ask',type:'done',text:'First answer'});await sending;await flush();
    expect(requests.map(r=>r.question)).toEqual(['First','Second','Third']);
    expect(requests[1]).toEqual(expect.objectContaining({selection,answerQuote:{text:'Quoted formula \\(x\\)'},files:[],snapshotId:'2'.padStart(64,'0')}));
    expect(requests.map(request=>request.snapshotId)).toEqual(['1','2','3'].map(id=>id.padStart(64,'0')));
    expect(mocks.sourceRequest).toHaveBeenCalledWith('source-chunk',expect.objectContaining({path:'main.tex',content:'At enqueue'}));
    expect(mocks.sourceRequest.mock.calls.filter(([op])=>op==='source-commit')).toHaveLength(3);
    expect(mocks.panel.setQueue).toHaveBeenLastCalledWith([],false);
  });
  it('pauses queued messages when stopped and only sends them after explicit resume',async()=>{
    await boot();const first=deferred<CodexEvent>();let asks=0;
    mocks.request.mockImplementation((op,data,onEvent)=>{
      if(op==='ask'){asks++;onEvent?.({id:'ask',type:'started',threadId:conversationId,turnId:'turn-'+asks,canSteer:true});return asks===1?first.promise:Promise.resolve({id:'ask',type:'done',text:'Next'});}
      return Promise.resolve({id:'other',type:'done'});
    });
    const sending=mocks.panelOptions!.onSend('First');await flush();await mocks.panelOptions!.onQueue!('After this');
    mocks.panelOptions!.onCancel();first.resolve({id:'ask',type:'done',text:'Partial'});await sending;await flush();
    expect(asks).toBe(1);expect(mocks.panel.setQueue.mock.lastCall?.[1]).toBe(true);
    mocks.panelOptions!.onResumeQueue!();await flush();expect(asks).toBe(2);
  });
  it('holds failed queued submissions for review and never retries them on Resume',async()=>{
    await boot();const first=deferred<CodexEvent>();let asks=0;
    mocks.request.mockImplementation((op,data,onEvent)=>{
      if(op==='ask'){asks++;onEvent?.({id:'ask',type:'started',threadId:conversationId,turnId:'turn-'+asks,canSteer:true});return asks===1?first.promise:Promise.reject(new Error('Uncertain delivery'));}
      return Promise.resolve({id:'other',type:'done'});
    });
    const sending=mocks.panelOptions!.onSend('First');await flush();await mocks.panelOptions!.onQueue!('Second');await mocks.panelOptions!.onQueue!('Third');
    first.resolve({id:'ask',type:'done',text:'First'});await sending;await flush();
    expect(asks).toBe(2);const items=mocks.panel.setQueue.mock.lastCall![0];expect(items.map((x:any)=>x.state)).toEqual(['failed','queued']);
    mocks.panelOptions!.onResumeQueue!();await flush();expect(asks).toBe(2);
  });
  it('steers only a confirmed active turn, preserving its answer and queue',async()=>{
    await boot();const first=deferred<CodexEvent>(),started=deferred<void>();let stream:((event:CodexEvent)=>void)|undefined;
    mocks.request.mockImplementation((op,data,onEvent)=>{
      if(op==='ask'){stream=onEvent;onEvent?.({id:'ask',type:'started',threadId:conversationId,turnId:'turn-active',canSteer:true});onEvent?.({id:'ask',type:'delta',text:'Original partial'});started.resolve();return first.promise;}
      if(op==='steer')return Promise.resolve({id:'steer',type:'steered',threadId:conversationId,turnId:'turn-active',userMessageId:'m3'});
      return Promise.resolve({id:'other',type:'done'});
    });
    const sending=mocks.panelOptions!.onSend('First');await started.promise;await mocks.panelOptions!.onSteer!('Use chirality',selection);
    const call=mocks.request.mock.calls.find(([op])=>op==='steer')!;expect(call[1]).toEqual(expect.objectContaining({expectedTurnId:'turn-active',expectedConversationId:conversationId,question:'Use chirality',selection}));
    expect(mocks.panel.insertSteeringMessage).toHaveBeenCalledWith(expect.objectContaining({messageId:'m3',role:'user',text:'Use chirality'}));
    expect(mocks.request.mock.calls.some(([op])=>op==='cancel')).toBe(false);stream?.({id:'ask',type:'delta',text:' continued'});
    expect(mocks.panel.setAssistantText).toHaveBeenLastCalledWith('Original partial continued');first.resolve({id:'ask',type:'done',text:'Complete original answer'});await sending;
  });
  it('keeps an accepted steering snapshot recovery warning after the main answer finishes',async()=>{
    await boot();vi.useFakeTimers();
    const first=deferred<CodexEvent>(),started=deferred<void>(),failedRecheck=deferred<void>();
    const mainSnapshot='a'.repeat(64),steerSnapshot='b'.repeat(64),newSnapshot='c'.repeat(64);
    let commits=0,steeringChecks=0;
    mocks.sourceRequest.mockImplementation(async(op:string)=>({id:'source',type:'source',...(op==='source-commit'
      ? {snapshotId:[mainSnapshot,steerSnapshot,newSnapshot][commits++]}
      : {uploadId:'12345678-1234-4234-8234-123456789abc'})}));
    mocks.sourceCheck.mockImplementation(async(data:{snapshotId:string},event:(value:CodexEvent)=>void)=>{
      if(data.snapshotId===steerSnapshot && ++steeringChecks>1){
        event({id:'check',type:'error',errorCode:'source_unavailable'});
        if(steeringChecks===3)failedRecheck.resolve();
        throw new Error('Original steering source is unavailable');
      }
      return {id:'check',type:'source',snapshotId:data.snapshotId};
    });
    mocks.request.mockImplementation((op,data,onEvent)=>{
      if(op==='ask'){onEvent?.({id:'ask',type:'started',threadId:conversationId,turnId:'active-turn',canSteer:true});started.resolve();return first.promise;}
      if(op==='steer')return Promise.resolve({id:'steer',type:'steered',threadId:conversationId,turnId:'active-turn',userMessageId:'steering-message'});
      return Promise.resolve({id:'other',type:'done'});
    });
    const sending=mocks.panelOptions!.onSend('Main question');await started.promise;
    await mocks.panelOptions!.onSteer!('Accepted addition');
    await vi.advanceTimersByTimeAsync(5000);await failedRecheck.promise;
    await vi.advanceTimersByTimeAsync(0);
    const warning=mocks.panel.setStatus.mock.lastCall?.[0];
    expect(warning).toContain('The steering message cache could not be restored:');
    expect(warning).toContain('original source version cannot be restored');
    expect(mocks.captureFull).toHaveBeenCalledTimes(3);
    expect(mocks.sourceCheck.mock.calls.filter(([data])=>data.snapshotId===steerSnapshot)).toHaveLength(3);
    first.resolve({id:'ask',type:'done',text:'Completed original answer'});await sending;
    expect(mocks.panel.setStatus).toHaveBeenLastCalledWith(warning);
    expect(mocks.request.mock.calls.filter(([op])=>op==='ask')).toHaveLength(1);
    expect(mocks.request.mock.calls.filter(([op])=>op==='steer')).toHaveLength(1);
  });
  it('shows an accepted steering message even when the old turn ends before its acknowledgement',async()=>{
    await boot();const first=deferred<CodexEvent>(),ack=deferred<CodexEvent>(),started=deferred<void>(),steerRequested=deferred<void>();
    mocks.request.mockImplementation((op,data,onEvent)=>{
      if(op==='ask'){onEvent?.({id:'ask',type:'started',threadId:conversationId,turnId:'old-turn',canSteer:true});started.resolve();return first.promise;}
      if(op==='steer'){steerRequested.resolve();return ack.promise;}return Promise.resolve({id:'other',type:'done'});
    });
    // Source capture hashes files asynchronously; wait for actual protocol phases,
    // then finish the old turn only after the follow-up has been dispatched.
    const sending=mocks.panelOptions!.onSend('First');await started.promise;
    const steering=mocks.panelOptions!.onSteer!('Accepted follow-up');await steerRequested.promise;
    first.resolve({id:'ask',type:'done',text:'Original completed answer'});await sending;
    ack.resolve({id:'steer',type:'steered',threadId:conversationId,turnId:'new-desktop-turn',userMessageId:'m-accepted'});await steering;
    expect(mocks.panel.insertSteeringMessage).toHaveBeenLastCalledWith(expect.objectContaining({messageId:'m-accepted',text:'Accepted follow-up'}),false);
    expect(mocks.saveMessages.mock.lastCall![2].at(-1)).toEqual(expect.objectContaining({messageId:'m-accepted',text:'Accepted follow-up'}));
    expect(mocks.request.mock.calls.filter(([op])=>op==='steer')).toHaveLength(1);
  });
  it('requires the sending marker to be durable before dispatching a queued request',async()=>{
    withAccount();mocks.request.mockResolvedValue(historyPage());const durable=deferred<void>();const stored:any[]=[];
    chrome.runtime.sendMessage=vi.fn(async(value)=>{if(value.action==='read')return {ok:true,revision:'',items:[]};const items=value.items;stored.push(items);if(items.some((x:any)=>x.state==='sending'))await durable.promise;return {ok:true,revision:crypto.randomUUID()};}) as any;
    await boot();const first=deferred<CodexEvent>();let asks=0;
    mocks.request.mockImplementation((op,data,onEvent)=>{if(op==='history-read')return Promise.resolve(historyPage());if(op==='ask'){asks++;onEvent?.({id:'ask',type:'started',threadId:conversationId,turnId:'turn-'+asks,canSteer:true});return asks===1?first.promise:Promise.resolve({id:'ask',type:'done',text:'Second'});}return Promise.resolve({id:'other',type:'done'});});
    const sending=mocks.panelOptions!.onSend('First');await flush();await mocks.panelOptions!.onQueue!('Second');first.resolve({id:'ask',type:'done',text:'First'});await sending;await flush();
    expect(stored.some(items=>items[0]?.state==='sending')).toBe(true);expect(asks).toBe(1);durable.resolve();await flush();expect(asks).toBe(2);
  });
  it('does not accept a queue item if browser persistence fails',async()=>{
    withAccount();mocks.request.mockResolvedValue(historyPage());
    chrome.runtime.sendMessage=vi.fn(async(value)=>{if(value.action==='read')return {ok:true,revision:'',items:[]};if(value.items.length)throw new Error('Quota exceeded');return {ok:true,revision:crypto.randomUUID()};}) as any;
    await boot();const first=deferred<CodexEvent>();let asks=0;
    mocks.request.mockImplementation((op,data,onEvent)=>{if(op==='history-read')return Promise.resolve(historyPage());if(op==='ask'){asks++;onEvent?.({id:'ask',type:'started',threadId:conversationId,turnId:'t'});return first.promise;}return Promise.resolve({id:'other',type:'done'});});
    const sending=mocks.panelOptions!.onSend('First');await flush();await expect(mocks.panelOptions!.onQueue!('Keep this',selection)).rejects.toThrow('question and selection were kept');
    expect(mocks.panel.setQueue.mock.lastCall![0]).toEqual([]);first.resolve({id:'ask',type:'done',text:'Done'});await sending;await flush();expect(asks).toBe(1);
  });
});
