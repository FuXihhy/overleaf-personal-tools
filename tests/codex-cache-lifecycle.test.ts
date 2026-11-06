import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectCacheCoordinator, createProjectCachePage, registerProjectCacheLifecycle } from '../src/codex/cache-lifecycle';
import { registerCodexHistory } from '../src/codex/background';
import { codexStorageKey } from '../src/codex/storage';
import { DEFAULT_CODEX_SETTINGS } from '../src/codex/types';

const KEY='opt:project-cache-lifecycle:v1';
const scope={projectId:'0123456789abcdef01234567',accountId:'abcdef0123456789abcdef01'};
const url=`https://www.overleaf.com/project/${scope.projectId}`;
const token=()=>crypto.randomUUID();
function event() {
  const listeners=new Set<(...args:any[])=>any>();
  return {listeners,addListener:vi.fn((fn:(...args:any[])=>any)=>listeners.add(fn)),removeListener:vi.fn((fn:(...args:any[])=>any)=>listeners.delete(fn)),emit:(...args:any[])=>[...listeners].map(fn=>fn(...args))};
}
function fixture() {
  const data:Record<string,any>={},calls:Array<Record<string,any>>=[],order:string[]=[],ports:any[]=[];
  const native=vi.fn(async (_request:Record<string,any>):Promise<Record<string,unknown>>=>({type:'source',cacheInfo:{cleanupPending:false}}));
  const runtime={id:'synthetic-extension',onMessage:event(),onStartup:event(),lastError:undefined,
    connectNative:vi.fn(()=>{
      const port={onMessage:event(),onDisconnect:event(),disconnect:vi.fn(),postMessage:vi.fn((request:Record<string,any>)=>{
        calls.push(request);order.push(request.op);
        void Promise.resolve().then(()=>native(request)).then(value=>port.onMessage.emit({version:1,id:request.id,...value}),error=>port.onMessage.emit({id:request.id,type:'error',message:error.message}));
      })};ports.push(port);return port;
    })};
  const storage={get:vi.fn(async(key:string)=>({[key]:structuredClone(data[key])})),set:vi.fn(async(value:Record<string,unknown>)=>{Object.assign(data,structuredClone(value));})};
  const tabs={query:vi.fn(async():Promise<Array<{id:number;url?:string}>>=>[]),sendMessage:vi.fn(async(..._args:unknown[]):Promise<unknown>=>undefined),onRemoved:event(),onUpdated:event()};
  const alarms={create:vi.fn(async()=>{}),onAlarm:event()};
  const api={runtime,storage,tabs,alarms} as unknown as ConstructorParameters<typeof ProjectCacheCoordinator>[0];
  const coordinator=new ProjectCacheCoordinator(api);
  const sender=(id:number,documentId:string=token(),pageUrl=url)=>({id:runtime.id,frameId:0,tab:{id},documentId,url:pageUrl} as chrome.runtime.MessageSender);
  return {data,calls,order,native,runtime,storage,tabs,alarms,ports,api,coordinator,sender};
}
const queued=(id=token(),snapshotId='ab'.repeat(32))=>({id,prompt:{snapshotId}});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});

describe('durable browser project cache lifecycle',()=>{
  it('keeps separate documents and releases only a positively closed tab',async()=>{
    const f=fixture();const a=f.sender(1),b=f.sender(2);
    const first=await f.coordinator.acquire(a,scope,token());const second=await f.coordinator.acquire(b,scope,token());
    await f.coordinator.departed(1);
    expect(f.calls.filter(r=>r.op==='source-page-release').map(r=>r.documentId)).toEqual([first.documentId]);
    expect(f.data[KEY].pages.map((p:any)=>p.documentId)).toEqual([second.documentId]);
    expect(f.calls.every(r=>!('tabId' in r))).toBe(true);
    expect(f.alarms.create).toHaveBeenCalledWith('opt:project-cache-sweep',{delayInMinutes:.5});
  });
  it('survives worker reconstruction and native port disconnect without releasing a live page',async()=>{
    const f=fixture(),sender=f.sender(5),lease=token();await f.coordinator.acquire(sender,scope,lease);
    const browserId=f.data[KEY].browserId;
    f.ports.forEach(port=>port.onDisconnect.emit());
    const next=new ProjectCacheCoordinator(f.api);await next.acquire(sender,scope,lease);
    expect(f.data[KEY].browserId).toBe(browserId);expect(f.data[KEY].pages).toHaveLength(1);
    expect(f.calls.some(r=>r.op==='source-page-release')).toBe(false);
  });
  it('does not retire any page when a project inventory probe fails',async()=>{
    const f=fixture();await f.coordinator.acquire(f.sender(1),scope,token());await f.coordinator.acquire(f.sender(2),scope,token());
    f.tabs.query.mockResolvedValue([{id:1,url}]);f.tabs.sendMessage.mockRejectedValue(new Error('Page loading'));
    await f.coordinator.reconcile();
    expect(f.calls.some(r=>r.op==='source-page-reconcile')).toBe(false);expect(f.data[KEY].pages).toHaveLength(2);
  });
  it('retains unknown tab URLs but retires absent tab IDs after complete inventory',async()=>{
    const f=fixture();const first=await f.coordinator.acquire(f.sender(1),scope,token());await f.coordinator.acquire(f.sender(2),scope,token());
    f.tabs.query.mockResolvedValue([{id:1}]);await f.coordinator.reconcile();
    expect(f.calls.find(r=>r.op==='source-page-reconcile')).toMatchObject({documents:[first.documentId],inventoryComplete:true});
    expect(f.data[KEY].pages).toHaveLength(1);
  });
  it('fences a refresh occurring during inventory and reconciles to the replacement document on the next pass',async()=>{
    const f=fixture();const old=await f.coordinator.acquire(f.sender(9),scope,token());
    const sender=f.sender(9),lease=token();let current:Awaited<ReturnType<ProjectCacheCoordinator['acquire']>>;
    f.tabs.query.mockResolvedValue([{id:9,url}]);
    f.tabs.sendMessage.mockImplementation(async()=>current=await f.coordinator.acquire(sender,scope,lease));
    await f.coordinator.reconcile();
    expect(f.calls.some(r=>r.op==='source-page-reconcile')).toBe(false);expect(f.data[KEY].pages).toHaveLength(2);
    await f.coordinator.reconcile();
    expect(f.calls.filter(r=>r.op==='source-page-reconcile')).toHaveLength(1);
    expect(f.calls.find(r=>r.op==='source-page-reconcile')!.documents).toEqual([current!.documentId]);
    expect(current!.documentId).not.toBe(old.documentId);expect(f.data[KEY].pages).toHaveLength(1);
  });
  it('keeps profile identities independent and account transitions scoped',async()=>{
    const f=fixture(),other=fixture(),sender=f.sender(4),lease=token();await f.coordinator.acquire(sender,scope,lease);await other.coordinator.acquire(other.sender(4),scope,token());
    expect(f.data[KEY].browserId).not.toBe(other.data[KEY].browserId);
    const changed={...scope,accountId:'111111111111111111111111'};await f.coordinator.acquire(sender,changed,lease);
    expect(f.calls.find(r=>r.op==='source-page-release')).toMatchObject(scope);
    expect(f.data[KEY].pages).toEqual([expect.objectContaining(changed)]);
  });
  it('rotates a restored document generation without a release window and rejects delayed old registration',async()=>{
    const f=fixture(),sender=f.sender(4),old=token(),next=token();await f.coordinator.acquire(sender,scope,old);
    await f.coordinator.acquire(sender,scope,next,old);expect(f.data[KEY].pages).toHaveLength(1);expect(f.data[KEY].pages[0].leaseToken).toBe(next);
    expect(f.calls.filter(r=>r.op==='source-page-acquire').map(r=>r.leaseToken)).toEqual([old,next]);expect(f.calls.some(r=>r.op==='source-page-release')).toBe(false);
    expect(f.calls.filter(r=>r.op==='source-page-acquire')[1]).toMatchObject({previousLeaseToken:old});
    await expect(f.coordinator.acquire(sender,scope,old)).rejects.toThrow('newer cache lease');
  });
  it('rejects unverified document identity and corrupt durable metadata without deleting anything',async()=>{
    const f=fixture();await expect(f.coordinator.acquire(f.sender(1,'not-a-chrome-document'),scope,token())).rejects.toThrow('verified Chrome');
    f.data[KEY]={version:1,pages:[]};await expect(f.coordinator.sweep()).rejects.toThrow('metadata is invalid');expect(f.calls).toEqual([]);
  });
  it('pins before durable queue storage and releases removed references only after the write',async()=>{
    const f=fixture(),a=queued(),b=queued();await f.coordinator.queueWrite(scope,[],[a],async()=>{f.order.push('persist A');});
    expect(f.order.indexOf('source-queue-pin')).toBeLessThan(f.order.indexOf('persist A'));
    f.order.length=0;await f.coordinator.queueWrite(scope,[a],[b],async()=>{f.order.push('persist B');});
    expect(f.order).toEqual(['source-queue-pin','persist B','source-queue-release']);
    expect(f.calls.find(r=>r.op==='source-queue-release')).toMatchObject({queueId:a.id});
  });
  it('rolls back only newly acquired queue references after storage failure and preserves preexisting pins',async()=>{
    const f=fixture(),a=queued(),b=queued();
    await expect(f.coordinator.queueWrite(scope,[a],[a,b],async()=>{throw new Error('Storage full');})).rejects.toThrow('Storage full');
    expect(f.calls.filter(r=>r.op==='source-queue-release').map(r=>r.queueId)).toEqual([b.id]);
  });
  it('does not persist a queue after a partial native pin failure and compensates new pins',async()=>{
    const f=fixture(),a=queued(),b=queued();f.native.mockImplementation(async r=>{if(r.op==='source-queue-pin'&&r.queueId===b.id)throw new Error('Missing snapshot');return {type:'source'};});
    const persist=vi.fn(async()=>{});await expect(f.coordinator.queueWrite(scope,[],[a,b],persist)).rejects.toThrow('Missing snapshot');
    expect(persist).not.toHaveBeenCalled();expect(f.calls.some(r=>r.op==='source-queue-release'&&r.queueId===a.id)).toBe(true);
  });
  it('cancels a stale rollback outbox before repinning the same successfully retried queue item',async()=>{
    const f=fixture(),a=queued();f.native.mockImplementation(async r=>{if(r.op==='source-queue-release')throw new Error('Disconnected');return {type:'source'};});
    await expect(f.coordinator.queueWrite(scope,[],[a],async()=>{throw new Error('Storage full');})).rejects.toThrow('Storage full');
    expect(f.data[KEY].releases).toHaveLength(1);f.calls.length=0;
    f.native.mockResolvedValue({type:'source'});
    await f.coordinator.queueWrite(scope,[],[a],async()=>{expect(f.data[KEY].releases).toEqual([]);});
    await f.coordinator.sweep();
    expect(f.calls.some(r=>r.op==='source-queue-release')).toBe(false);expect(f.calls.some(r=>r.op==='source-queue-pin'&&r.queueId===a.id)).toBe(true);
  });
  it('restores saved queue contents with an explicit protection error instead of hiding or deleting a missing snapshot',async()=>{
    const f=fixture(),key=codexStorageKey(scope.projectId,scope.accountId)+':queue';
    const item={id:token(),state:'queued',prompt:{question:'Keep the original',settings:DEFAULT_CODEX_SETTINGS,files:[],note:'',snapshotId:'ab'.repeat(32)}};
    const saved={revision:token(),items:[item]};f.data[key]=structuredClone(saved);
    f.native.mockRejectedValue(new Error('Original snapshot is unavailable'));
    registerCodexHistory(f.api.runtime,f.api.storage,()=>true,f.coordinator);
    const response=await new Promise<any>(resolve=>f.runtime.onMessage.emit({type:'opt:codex-queue',...scope,action:'read'},f.sender(1),resolve));
    expect(response).toEqual({ok:true,...saved,cacheError:'Original snapshot is unavailable'});expect(f.data[key]).toEqual(saved);
    expect(f.calls.every(r=>r.op!=='source-queue-release')).toBe(true);
  });
  it('retains a departure after helper failure and schedules bounded retries without guessing a terminal turn',async()=>{
    const f=fixture();await f.coordinator.acquire(f.sender(1),scope,token());f.alarms.create.mockClear();
    f.native.mockRejectedValue(new Error('Helper unavailable'));
    await expect(f.coordinator.departed(1)).rejects.toThrow('Helper unavailable');expect(f.data[KEY].departures).toHaveLength(1);expect(f.alarms.create).toHaveBeenCalledOnce();
    f.alarms.create.mockClear();for(let i=0;i<22;i++)await f.coordinator.sweep().catch(()=>{});
    expect(f.alarms.create).toHaveBeenCalledTimes(19);expect(f.data[KEY].departures).toHaveLength(1);
    f.native.mockResolvedValue({type:'source',cacheInfo:{cleanupPending:false}});await f.coordinator.sweep();expect(f.data[KEY].departures).toEqual([]);
  });
  it('registers positive tab lifecycle and alarms while ignoring runtime disconnects',async()=>{
    const f=fixture();registerProjectCacheLifecycle(f.api,()=>true);
    expect(f.tabs.onRemoved.addListener).toHaveBeenCalledOnce();expect(f.tabs.onUpdated.addListener).toHaveBeenCalledOnce();expect(f.alarms.onAlarm.addListener).toHaveBeenCalledOnce();expect(f.runtime.onStartup.addListener).toHaveBeenCalledOnce();
    expect(f.runtime.onMessage.listeners.size).toBe(1);
  });
  it.each(['loading','query-failed','epoch-race'])('does not run cleanup when a reopened project inventory is %s',async failure=>{
    const f=fixture();await f.coordinator.acquire(f.sender(1),scope,token());await f.coordinator.departed(1);
    f.calls.length=0;f.alarms.create.mockClear();
    f.tabs.query.mockResolvedValue([{id:2,url}]);
    if(failure==='query-failed')f.tabs.query.mockRejectedValue(new Error('Chrome temporarily unavailable'));
    else if(failure==='loading')f.tabs.sendMessage.mockRejectedValue(new Error('Content script still loading'));
    const coordinator=registerProjectCacheLifecycle(f.api,()=>true);
    if(failure==='epoch-race')f.tabs.sendMessage.mockImplementation(async()=>coordinator.acquire(f.sender(2),scope,token()));
    await vi.waitFor(()=>expect(f.alarms.create).toHaveBeenCalled());
    expect(f.calls.some(r=>r.op==='source-cache-sweep')).toBe(false);
    expect(f.calls.some(r=>r.op==='source-page-reconcile')).toBe(false);
    if(failure!=='epoch-race'){
      f.tabs.query.mockResolvedValue([]);f.alarms.onAlarm.emit({name:'opt:project-cache-sweep'});
      await vi.waitFor(()=>expect(f.calls.some(r=>r.op==='source-cache-sweep')).toBe(true));
    }
  });
});

describe('project document registration',()=>{
  it('renews a BFCache-restored page and prevents an old in-flight registration from replacing its generation',async()=>{
    const pageshow=event();vi.stubGlobal('window',{addEventListener:(_name:string,fn:(...args:any[])=>unknown)=>pageshow.addListener(fn)});
    const resolvers:Array<(value:any)=>void>=[],requests:any[]=[];
    const sendMessage=vi.fn((request:any)=>{requests.push(request);return new Promise(resolve=>resolvers.push(resolve));});
    vi.stubGlobal('chrome',{runtime:{onMessage:event(),sendMessage}});const abort=new AbortController();
    const page=createProjectCachePage(scope.projectId,()=>scope.accountId,abort.signal);
    const old=page.acquire();const rejected=expect(old).rejects.toThrow('page was restored');await Promise.resolve();
    pageshow.emit({persisted:true});const current=page.acquire();await Promise.resolve();
    expect(requests[1].previousLeaseToken).toBe(requests[0].leaseToken);expect(requests[1].leaseToken).not.toBe(requests[0].leaseToken);
    resolvers[0]({ok:true,documentId:'same-document',leaseToken:requests[0].leaseToken});await rejected;
    expect(page.acquire()).toBe(current);
    resolvers[1]({ok:true,documentId:'same-document',leaseToken:requests[1].leaseToken});expect((await current).leaseToken).toBe(requests[1].leaseToken);abort.abort();
  });
  it('coalesces registration and removes its listener on abort without releasing or treating hidden pages as departed',async()=>{
    const onMessage=event(),sendMessage=vi.fn(async r=>({ok:true,documentId:'1:'+token(),leaseToken:r.leaseToken}));
    vi.stubGlobal('chrome',{runtime:{onMessage,sendMessage}});const abort=new AbortController();
    const page=createProjectCachePage(scope.projectId,()=>scope.accountId,abort.signal);
    const [a,b]=await Promise.all([page.acquire(),page.acquire()]);expect(a).toEqual(b);expect(sendMessage).toHaveBeenCalledOnce();
    abort.abort();expect(onMessage.listeners.size).toBe(0);expect(sendMessage.mock.calls.every(([r])=>r.type==='opt:cache-page')).toBe(true);
  });
  it('fails closed when the account or native document registration cannot be verified',async()=>{
    const sendMessage=vi.fn(async()=>({ok:false,message:'Local helper unavailable'}));vi.stubGlobal('chrome',{runtime:{onMessage:event(),sendMessage}});
    const abort=new AbortController(),page=createProjectCachePage(scope.projectId,()=>undefined,abort.signal);
    await expect(page.acquire()).rejects.toThrow('account could not be verified');expect(sendMessage).not.toHaveBeenCalled();
    const valid=createProjectCachePage(scope.projectId,()=>scope.accountId,abort.signal);await expect(valid.acquire()).rejects.toThrow('Local helper unavailable');abort.abort();
  });
});
