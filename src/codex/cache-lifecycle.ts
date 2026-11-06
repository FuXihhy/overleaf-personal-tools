import { CODEX_NATIVE_HOST, record } from './types';

const KEY = 'opt:project-cache-lifecycle:v1';
const ALARM = 'opt:project-cache-sweep';
const hex24 = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
type Scope = {projectId: string; accountId: string};
type Page = Scope & {tabId: number; documentId: string; leaseToken: string};
type State = {version: 1; browserId: string; pages: Page[]; scopes: Scope[]; departures: Page[]; releases: Array<Scope & {queueId: string}>; attempts: number};
const scopeKey = (scope: Scope) => `${scope.accountId}:${scope.projectId}`;
const project = (url?: string) => {
  try { const u = new URL(url!); return /^https:\/\/(www|cn)\.overleaf\.com$/.test(u.origin) ? /^\/project\/([a-f\d]{24})\/?$/i.exec(u.pathname)?.[1] : undefined; } catch { return; }
};

/** Browser evidence owns leases. A disconnected port, hidden page or sleeping
 * service worker never proves document departure. Every mutation is durable. */
export class ProjectCacheCoordinator {
  private tail = Promise.resolve();
  private epoch = 0;
  constructor(private api: {runtime: typeof chrome.runtime; storage: chrome.storage.StorageArea; tabs: typeof chrome.tabs; alarms: typeof chrome.alarms}) {}
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action); this.tail = result.then(() => {}, () => {}); return result;
  }
  private async load(): Promise<State> {
    const raw = (await this.api.storage.get(KEY))[KEY];
    if (raw === undefined) {
      const fresh: State = {version:1,browserId:crypto.randomUUID(),pages:[],scopes:[],departures:[],releases:[],attempts:0};
      await this.save(fresh); return fresh;
    }
    const s = record(raw);
    if (!s || s.version !== 1 || !uuid(s.browserId) || !['pages','scopes','departures','releases'].every(k => Array.isArray(s[k]) && (s[k] as unknown[]).length <= 10000)
      || !Number.isInteger(s.attempts) || Number(s.attempts) < 0) throw new Error('Project cache lifecycle metadata is invalid; cleanup is blocked.');
    const validScope = (v: unknown) => {const x=record(v);return !!x && hex24(x.projectId) && hex24(x.accountId);};
    if (!(s.scopes as unknown[]).every(validScope) || !(s.releases as unknown[]).every(v=>validScope(v)&&uuid(record(v)?.queueId))
      || ![...(s.pages as unknown[]),...(s.departures as unknown[])].every(v=>{const p=record(v);return validScope(v)&&!!p&&Number.isInteger(p.tabId)&&Number(p.tabId)>=0&&typeof p.documentId==='string'&&/^[\w.:-]{1,200}$/.test(p.documentId)&&uuid(p.leaseToken);})) throw new Error('Project cache lifecycle records are invalid; cleanup is blocked.');
    return s as unknown as State;
  }
  private save(state: State) { return this.api.storage.set({[KEY]:state}); }
  private remember(state: State, scope: Scope) {
    if (!state.scopes.some(s=>scopeKey(s)===scopeKey(scope))) state.scopes.push({projectId:scope.projectId,accountId:scope.accountId});
  }
  private native(op: string, scope: Scope, data: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return new Promise((resolve,reject)=>{
      const id=crypto.randomUUID(); let done=false; let port: chrome.runtime.Port | undefined;
      const finish=(error?:Error,value?:Record<string,unknown>)=>{if(done)return;done=true;clearTimeout(timer);try{port?.disconnect();}catch{}error?reject(error):resolve(value!);};
      const timer=setTimeout(()=>finish(new Error('Project cache coordination timed out; source is retained.')),15000);
      try {
        port=this.api.runtime.connectNative(CODEX_NATIVE_HOST);
        port.onMessage.addListener(raw=>{const value=record(raw);if(value?.id!==id)return;if(value.type==='source')finish(undefined,value);else if(value.type==='error')finish(new Error(String(value.message||'Project cache operation failed.')));});
        port.onDisconnect.addListener(()=>{const reason=this.api.runtime.lastError?.message;finish(new Error(reason||'Project cache connection lost; source is retained.'));});
        port.postMessage({version:1,id,op,projectId:scope.projectId,accountId:scope.accountId,...data});
      } catch(error) {finish(error instanceof Error?error:new Error(String(error)));}
    });
  }
  private schedule() { return this.api.alarms.create(ALARM,{delayInMinutes:.5}); }
  async acquire(sender: chrome.runtime.MessageSender, scope: Scope, leaseToken: string, previousLeaseToken?:string) {
    if (!uuid(leaseToken) || previousLeaseToken!==undefined&&!uuid(previousLeaseToken) || !uuid(sender.documentId) || !Number.isInteger(sender.tab?.id) || !hex24(scope.accountId) || project(sender.url)!==scope.projectId) throw new Error('A verified Chrome project document is required for project caching.');
    const page: Page={...scope,tabId:sender.tab!.id!,documentId:`${sender.tab!.id}:${sender.documentId}`,leaseToken};
    return this.serial(async()=>{
      const state=await this.load();this.remember(state,scope);
      const existing=state.pages.find(p=>p.documentId===page.documentId && scopeKey(p)===scopeKey(page));
      if(existing && existing.leaseToken!==leaseToken){
        if(existing.leaseToken!==previousLeaseToken)throw new Error('This document already registered a newer cache lease.');
        // BFCache keeps the Chrome documentId but revives the content script.
        // Native acquisition atomically retires the old generation; no release
        // or unprotected interval occurs between these two generations.
        ++this.epoch;existing.leaseToken=leaseToken;state.attempts=0;await this.save(state);await this.schedule();
      }
      if(!existing){++this.epoch;state.pages.push(page);state.attempts=0;await this.save(state);await this.schedule();}
      await this.native('source-page-acquire',scope,{browserId:state.browserId,documentId:page.documentId,leaseToken,...(previousLeaseToken?{previousLeaseToken}:{})});
      // A same document account transition is positively identified; a refresh
      // uses a different Chrome documentId and is reconciled by inventory.
      const old=state.pages.filter(p=>p.documentId===page.documentId&&scopeKey(p)!==scopeKey(page));
      state.departures.push(...old);state.pages=state.pages.filter(p=>!old.includes(p));await this.save(state);
      await this.flush(state);if(!existing||old.length)await this.schedule();return {ok:true,documentId:page.documentId,leaseToken};
    });
  }
  async departed(tabId: number) {
    ++this.epoch;
    return this.serial(async()=>{const state=await this.load();state.departures.push(...state.pages.filter(p=>p.tabId===tabId));state.pages=state.pages.filter(p=>p.tabId!==tabId);state.attempts=0;await this.save(state);await this.schedule();await this.flush(state);});
  }
  private async flush(state: State) {
    for(const p of [...state.departures]){
      await this.native('source-page-release',p,{browserId:state.browserId,documentId:p.documentId,leaseToken:p.leaseToken});
      state.departures=state.departures.filter(x=>scopeKey(x)!==scopeKey(p)||x.documentId!==p.documentId||x.leaseToken!==p.leaseToken);await this.save(state);
    }
    for(const p of [...state.releases]){
      await this.native('source-queue-release',p,{queueId:p.queueId});
      state.releases=state.releases.filter(x=>scopeKey(x)!==scopeKey(p)||x.queueId!==p.queueId);await this.save(state);
    }
  }
  async reconcile() {
    // Probe outside the serial lock: a new document must be able to register
    // while handling this probe. Recheck the epoch before retiring any lease.
    const epoch=this.epoch;
    const tabs=await this.api.tabs.query({});
    const live: Array<{tabId:number;documentId:string;leaseToken:string}>=[];
    let complete=true;
    for(const tab of tabs){
      if(!project(tab.url))continue;
      try{const reply=record(await this.api.tabs.sendMessage(tab.id!,{type:'opt:cache-page-probe'},{frameId:0}));
        if(reply?.ok!==true||typeof reply.documentId!=='string'||!uuid(reply.leaseToken)){complete=false;continue;}
        live.push({tabId:tab.id!,documentId:reply.documentId,leaseToken:reply.leaseToken});
      }catch{complete=false;}
    }
    return this.serial(async()=>{
      if(epoch!==this.epoch)return false;
      const state=await this.load();
      // Tabs with an unknown URL cannot prove navigation. Preserve their old
      // registered documents; missing tab IDs are authoritative closure.
      for(const page of state.pages)if(tabs.some(t=>t.id===page.tabId&&!t.url))live.push(page);
      if(!complete)return false;
      for(const scope of state.scopes){
        const pages=state.pages.filter(p=>scopeKey(p)===scopeKey(scope)&&live.some(l=>l.documentId===p.documentId&&l.leaseToken===p.leaseToken));
        await this.native('source-page-reconcile',scope,{browserId:state.browserId,documents:pages.map(p=>p.documentId),inventoryComplete:true});
      }
      const before=state.pages.length;
      state.pages=state.pages.filter(p=>live.some(l=>l.documentId===p.documentId&&l.leaseToken===p.leaseToken));await this.save(state);await this.flush(state);if(state.pages.length<before)await this.schedule();return true;
    });
  }
  /** An incomplete inventory is not permission to collect source. Retry only
   * local coordination metadata; do not flush native operations or run GC. */
  retryInventory() {
    return this.serial(async()=>{const state=await this.load();state.attempts++;await this.save(state);if(state.attempts<20)await this.schedule();});
  }
  /** Pin every new reference before durable queue storage. Release removed
   * references only after that write, with a durable retry outbox. */
  queueWrite(scope: Scope, previous: unknown[], next: unknown[], persist:()=>Promise<void>) {
    return this.serial(async()=>{
      const state=await this.load();this.remember(state,scope);
      const refs=(items:unknown[])=>items.map(record).filter((x):x is Record<string,unknown>=>!!x).filter(x=>typeof record(x.prompt)?.snapshotId==='string');
      const old=refs(previous), fresh=refs(next);
      // An earlier failed write may have left a release pending. Fence it out
      // durably before reusing that queue ID, otherwise a later flush could
      // unpin the successfully retried durable item.
      state.releases=state.releases.filter(p=>scopeKey(p)!==scopeKey(scope)||!fresh.some(item=>item.id===p.queueId));
      state.attempts=0;await this.save(state);await this.schedule();
      try{
        for(const item of fresh)await this.native('source-queue-pin',scope,{queueId:item.id,snapshotId:record(item.prompt)!.snapshotId});
        await persist();
      }catch(error){
        for(const item of fresh)if(!old.some(o=>o.id===item.id))state.releases.push({...scope,queueId:String(item.id)});
        await this.save(state);try{await this.flush(state);}catch{}await this.schedule();throw error;
      }
      for(const item of old)if(!fresh.some(n=>n.id===item.id))state.releases.push({...scope,queueId:String(item.id)});
      await this.save(state);try{await this.flush(state);}catch{/* Safe retention; alarm retries. */}await this.schedule();
    });
  }
  async sweep() {
    await this.serial(async()=>{const state=await this.load();let pending=false;
      try{await this.flush(state);
        for(const scope of state.scopes){const value=await this.native('source-cache-sweep',scope);pending ||= record(value.cacheInfo)?.cleanupPending===true;}
      }catch(error){pending=true;throw error;}
      finally{state.attempts++;await this.save(state);if(pending&&state.attempts<20)await this.schedule();}
    });
  }
}

export function registerProjectCacheLifecycle(api: ConstructorParameters<typeof ProjectCacheCoordinator>[0], allowed:(sender:chrome.runtime.MessageSender,id:string)=>boolean) {
  const coordinator=new ProjectCacheCoordinator(api);
  const cycle=()=>coordinator.reconcile().catch(()=>false).then(complete=>complete?coordinator.sweep():coordinator.retryInventory()).catch(()=>{});
  api.runtime.onMessage.addListener((raw,sender,respond)=>{
    const data=record(raw);if(data?.type!=='opt:cache-page')return;
    if(!allowed(sender,api.runtime.id)||!hex24(data.projectId)||!hex24(data.accountId)||!uuid(data.leaseToken)||data.previousLeaseToken!==undefined&&!uuid(data.previousLeaseToken)
      ||Object.keys(data).some(key=>!['type','projectId','accountId','leaseToken','previousLeaseToken'].includes(key))){respond({ok:false,message:'Invalid project cache page.'});return false;}
    void coordinator.acquire(sender,{projectId:data.projectId,accountId:data.accountId},data.leaseToken,data.previousLeaseToken as string|undefined).then(respond,error=>respond({ok:false,message:String(error)}));return true;
  });
  api.tabs.onRemoved.addListener(tabId=>{void coordinator.departed(tabId).catch(()=>{});});
  api.tabs.onUpdated.addListener((tabId,change)=>{
    if(change.url && !project(change.url))void coordinator.departed(tabId).catch(()=>{});
    else if(change.status==='complete')void cycle();
  });
  api.alarms.onAlarm.addListener(alarm=>{if(alarm.name===ALARM)void cycle();});
  api.runtime.onStartup?.addListener(()=>{void cycle();});
  void cycle();
  return coordinator;
}

export function createProjectCachePage(projectId:string, account:()=>string|undefined, signal:AbortSignal) {
  let leaseToken=crypto.randomUUID(),previousLeaseToken:string|undefined;let pending:Promise<{documentId:string;leaseToken:string}>|undefined;
  const acquire=()=>{
    if(pending)return pending;
    const accountId=account();
    if(!accountId)return Promise.reject(new Error('The Overleaf account could not be verified. Project caching is unavailable.'));
    const generation=leaseToken,previous=previousLeaseToken;
    pending=Promise.resolve().then(()=>chrome.runtime.sendMessage({type:'opt:cache-page',projectId,accountId,leaseToken:generation,...(previous?{previousLeaseToken:previous}:{})})).then(value=>{
      if(generation!==leaseToken)throw new Error('The project page was restored; retry with its current cache registration.');
      if(!value?.ok||typeof value.documentId!=='string'||value.leaseToken!==generation)throw new Error(value?.message||'Could not register the project cache page.');return value;
    }).finally(()=>{if(generation===leaseToken)pending=undefined;});return pending!;
  };
  const listener=(raw:unknown,_sender:chrome.runtime.MessageSender,respond:(value:unknown)=>void)=>{
    if(record(raw)?.type!=='opt:cache-page-probe')return;
    void acquire().then(value=>respond({ok:true,...value}),()=>respond({ok:false}));return true;
  };
  if(chrome.runtime.onMessage?.addListener){chrome.runtime.onMessage.addListener(listener);signal.addEventListener('abort',()=>chrome.runtime.onMessage.removeListener(listener),{once:true});}
  if(typeof window!=='undefined')window.addEventListener('pageshow',event=>{
    if(!event.persisted||signal.aborted)return;
    previousLeaseToken=leaseToken;leaseToken=crypto.randomUUID();pending=undefined;
    void acquire().catch(()=>{});
  },{signal});
  // Registration is independent of whether the assistant panel is open.
  void acquire().catch(()=>{});
  return {acquire};
}
