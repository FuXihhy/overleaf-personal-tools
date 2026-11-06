import { afterEach, describe, expect, it, vi } from 'vitest';
import { allowedAPISettingsSender, registerAPISettingsTransport, validProviderManagement } from '../src/codex/provider-background';
import { allowedNativeSender } from '../src/background';
import { registerCodexHistory, registerCodexTransport } from '../src/codex/background';
import { codexStorageKey } from '../src/codex/storage';
import { parseCodexEvent, validCodexRequest } from '../src/codex/types';

const extension='pffppbkokpnfafpechmlambifflkmbbn', project='0123456789abcdef01234567', account='abcdef0123456789abcdef01';
const provider='11111111-2222-3333-4444-555555555555';
const web={id:extension,frameId:0,tab:{id:1},url:`https://www.overleaf.com/project/${project}`} as chrome.runtime.MessageSender;
const settings={...web,url:`chrome-extension://${extension}/api-settings.html`};
const profile={name:'Synthetic API',baseUrl:'http://127.0.0.1:7777/v1',model:'synthetic',apiKey:'synthetic-key'};
class Port {
  name='opt:api-settings'; sender:chrome.runtime.MessageSender=settings;
  listeners:((value:unknown)=>void)[]=[];disconnections:(()=>void)[]=[];
  onMessage={addListener:(fn:(value:unknown)=>void)=>this.listeners.push(fn)};
  onDisconnect={addListener:(fn:()=>void)=>this.disconnections.push(fn)};
  postMessage=vi.fn();disconnect=vi.fn(()=>this.disconnections.forEach(fn=>fn()));
  receive(value:unknown){this.listeners.forEach(fn=>fn(value));}
  asPort(){return this as unknown as chrome.runtime.Port;}
}
function broker(management=true){
  let listener!:(port:chrome.runtime.Port)=>void;
  const native=new Port();
  const runtime={id:extension,lastError:undefined,onConnect:{addListener:(fn:typeof listener)=>listener=fn,removeListener:vi.fn()},connectNative:vi.fn(()=>native.asPort())};
  if(management)registerAPISettingsTransport(runtime as unknown as typeof chrome.runtime);
  else registerCodexTransport(runtime as unknown as typeof chrome.runtime,allowedNativeSender);
  const open=(sender:chrome.runtime.MessageSender=settings)=>{const p=new Port();p.sender=sender;p.name=management?'opt:api-settings':'opt:codex';listener(p.asPort());return p;};
  return {runtime,native,open};
}
afterEach(()=>vi.useRealTimers());
describe('API credential boundary and provider scoping',()=>{
  it('accepts only the extension-owned top-level settings page, including a normal browser tab',()=>{
    expect(allowedAPISettingsSender(settings,extension)).toBe(true);
    for(const s of [web,{...settings,id:'other'},{...settings,frameId:2},{...settings,url:`https://${extension}/api-settings.html`},{...settings,url:`chrome-extension://${extension}/other.html`}])expect(allowedAPISettingsSender(s,extension)).toBe(false);
  });
  it('rejects credential mutations from the ordinary Overleaf transport before native startup',()=>{
    const h=broker(false),p=h.open(web);
    for(const op of ['provider-save','provider-delete','provider-test'])p.receive({version:1,id:op,op,projectId:project,providerId:provider,profile});
    expect(h.runtime.connectNative).not.toHaveBeenCalled();p.disconnect();
  });
  it('rejects the entire management channel from Overleaf',()=>{
    const h=broker(),p=h.open(web);expect(p.disconnect).toHaveBeenCalledOnce();expect(h.runtime.connectNative).not.toHaveBeenCalled();
  });
  it('forwards one bounded management request and strips unexpected secret response fields',()=>{
    vi.useFakeTimers();const h=broker(),p=h.open();
    const request={version:1,id:'save',op:'provider-save',profile};p.receive(request);
    expect(h.native.postMessage).toHaveBeenCalledExactlyOnceWith(request);
    h.native.receive({id:'save',type:'profiles',apiKey:'do-not-return',profiles:[{...profile,id:provider,hasKey:true}]});
    expect(JSON.stringify(p.postMessage.mock.calls)).not.toContain('synthetic-key');
    expect(JSON.stringify(p.postMessage.mock.calls)).not.toContain('do-not-return');
    expect(vi.getTimerCount()).toBe(0);p.disconnect();
  });
  it('never replays an uncertain management mutation after disconnect',()=>{
    const h=broker(),p=h.open();p.receive({version:1,id:'save',op:'provider-save',profile});h.native.disconnect();
    expect(h.native.postMessage).toHaveBeenCalledTimes(1);expect(h.runtime.connectNative).toHaveBeenCalledTimes(1);
    expect(p.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({type:'error'}));
  });
  it('validates management operation fields and rejects credential header injection',()=>{
    expect(validProviderManagement({version:1,id:'s',op:'provider-save',profile})).toBe(true);
    for(const extra of [{profile:{...profile,apiKey:'key\r\nInjected: yes'}},{providerId:provider},{profile:{...profile,unknown:'x'}}])expect(validProviderManagement({version:1,id:'s',op:'provider-save',profile,...extra})).toBe(false);
  });
  it('scopes every model and history operation without granting management access',()=>{
    for(const op of ['status','ask','cancel','new-chat','history-list','history-read'])expect(validCodexRequest({version:1,id:'r',op,projectId:project,providerId:provider,...(op==='ask'?{question:'Explain'}:{})})).toBe(true);
    expect(validCodexRequest({version:1,id:'r',op:'status',projectId:project,providerId:'../other'})).toBe(false);
    expect(codexStorageKey(project,account)).not.toBe(codexStorageKey(project,account,provider));
  });
  it('does not let malformed provider metadata reach a renderer',()=>{
    expect(parseCodexEvent({id:'r',type:'profiles',profiles:[{id:'bad'}]})).toBeUndefined();
  });
  it('uses separate browser display caches for Codex and custom API history',async()=>{
    let receive!:(raw:unknown,sender:chrome.runtime.MessageSender,respond:(value:unknown)=>void)=>boolean|undefined;
    const session={get:vi.fn().mockResolvedValue({}),set:vi.fn().mockResolvedValue(undefined)};
    const runtime={id:extension,onMessage:{addListener:(fn:typeof receive)=>receive=fn}};
    registerCodexHistory(runtime as unknown as typeof chrome.runtime,session as unknown as chrome.storage.StorageArea,allowedNativeSender);
    receive({type:'opt:codex-history',projectId:project,accountId:account,providerId:provider,action:'write',messages:[]},web,vi.fn());
    receive({type:'opt:codex-history',projectId:project,accountId:account,action:'write',messages:[]},web,vi.fn());
    expect(session.set.mock.calls.map(([arg])=>Object.keys(arg)[0])).toEqual([codexStorageKey(project,account,provider)+':messages',codexStorageKey(project,account)+':messages']);
  });
});
