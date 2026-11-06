// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {mountAPISettings,createAPIManagementClient} from '../src/codex/api-settings';
import {mountNativeSettings, type PanelModel} from '../src/settings/native-panel';
import {DEFAULT_SETTINGS,emptyIndex} from '../src/core/types';
import {mountCodexAssistant} from '../src/codex/panel';

const id='11111111-2222-3333-4444-555555555555';
const profile={id,name:'DeepSeek',baseUrl:'https://api.deepseek.com',model:'deepseek-flash',hasKey:true};
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
const input=(name:string)=>document.getElementById('api-'+name) as HTMLInputElement;
const change=(name:string,value:string)=>{input(name).value=value;input(name).dispatchEvent(new Event('input'));};
const submit=()=>document.querySelector('form')!.dispatchEvent(new Event('submit',{cancelable:true}));
const button=(text:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(el=>el.textContent===text)!;
let destroy:(()=>void)|undefined;
beforeEach(()=>{document.body.replaceChildren();document.documentElement.lang='en';vi.stubGlobal('chrome',{runtime:{id:'test',getURL:(path:string)=>'chrome-extension://test/'+path}});});
afterEach(()=>{destroy?.();destroy=undefined;vi.restoreAllMocks();vi.unstubAllGlobals();document.body.replaceChildren();});

describe('private API connection page',()=>{
  it('keeps credentials in the management request, never reads them back, and preserves blank existing keys',async()=>{
    const request=vi.fn(async(op:string)=>({profiles:op==='provider-list'?[]:[profile]}));
    const root=document.createElement('main');document.body.append(root);destroy=mountAPISettings(root,{request,locale:'en'}).destroy;await flush();
    change('name','DeepSeek');change('url','https://api.deepseek.com');change('model','deepseek-flash');change('key','synthetic-secret');
    expect(input('key').type).toBe('password');expect(input('key').autocomplete).toBe('off');
    submit();await flush();
    expect(request).toHaveBeenCalledWith('provider-save',{profile:{name:'DeepSeek',baseUrl:'https://api.deepseek.com',model:'deepseek-flash',apiKey:'synthetic-secret'}});
    expect(input('key').value).toBe('');expect(document.body.textContent).not.toContain('synthetic-secret');
    expect(input('url').readOnly).toBe(true);
    change('model','another-model');submit();await flush();
    const last=request.mock.calls.at(-1) as unknown as [string,{profile:Record<string,unknown>}];
    expect(last[0]).toBe('provider-save');expect(last[1].profile.id).toBe(id);expect(last[1].profile).not.toHaveProperty('apiKey');
  });
  it('does not check unsaved credentials or send a model question; removal requires the inline confirmation',async()=>{
    const request=vi.fn(async(op:string)=>({profiles:op==='provider-delete'?[]:[profile],message:'Ready'}));
    const root=document.createElement('main');document.body.append(root);destroy=mountAPISettings(root,{request,locale:'en'}).destroy;await flush();
    document.querySelector<HTMLButtonElement>('.api-list button')!.click();
    change('key','replacement-secret');expect(button('Check connection').disabled).toBe(true);button('Check connection').click();
    expect(request.mock.calls.map(x=>x[0])).toEqual(['provider-list']);
    submit();await flush();button('Check connection').click();await flush();
    expect(request).toHaveBeenLastCalledWith('provider-test',{providerId:id});
    button('Remove connection').click();expect(request.mock.calls.map(x=>x[0])).not.toContain('provider-delete');
    expect(document.querySelector<HTMLElement>('.api-confirm')!.hidden).toBe(false);
    button('Remove').click();await flush();expect(request).toHaveBeenLastCalledWith('provider-delete',{providerId:id});
    expect(document.body.textContent).toContain('Existing local history was retained.');
  });
  it('does not overwrite a draft during metadata refresh and clears the key on connection navigation',async()=>{
    const request=vi.fn(async()=>({profiles:[profile]}));const root=document.createElement('main');document.body.append(root);
    destroy=mountAPISettings(root,{request,locale:'en'}).destroy;await flush();change('name','Unsaved connection');change('key','new-secret');
    button('Refresh').click();await flush();expect(input('name').value).toBe('Unsaved connection');expect(input('key').value).toBe('new-secret');
    document.querySelector<HTMLButtonElement>('.api-list button')!.click();expect(input('key').value).toBe('');expect(input('name').value).toBe('DeepSeek');
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('validates required fields before saving, places hints above fields, and does not reflect secret errors',async()=>{
    const request=vi.fn(async(op:string)=>{if(op==='provider-save')throw new Error('Rejected synthetic-secret');return {profiles:[]};});
    const root=document.createElement('main');document.body.append(root);destroy=mountAPISettings(root,{request,locale:'en'}).destroy;await flush();
    submit();await flush();expect(request).toHaveBeenCalledTimes(1);
    expect(input('url').type).toBe('url');expect(input('url').required).toBe(true);
    expect(input('name').maxLength).toBe(80);expect(input('model').maxLength).toBe(128);expect(input('url').maxLength).toBe(2000);
    expect(input('url').previousElementSibling?.id).toBe(input('url').getAttribute('aria-describedby'));
    change('name','test');change('url','https://example.invalid/v1');change('model','model');change('key','synthetic-secret');submit();await flush();
    expect(document.querySelector('.api-status')!.textContent).toBe('Rejected [redacted]');
  });
  it('strips secret-shaped fields from returned connection metadata',async()=>{
    let receive:(value:unknown)=>void=()=>{};
    const port={postMessage:vi.fn(),disconnect:vi.fn(),onMessage:{addListener:(listener:typeof receive)=>{receive=listener;}},onDisconnect:{addListener:vi.fn()}};
    const client=createAPIManagementClient({connect:()=>port} as unknown as typeof chrome.runtime);
    const result=client.request('provider-list');const request=port.postMessage.mock.calls[0][0];
    receive({id:request.id,type:'profiles',profiles:[{...profile,apiKey:'never-expose'}]});
    expect(await result).toEqual({profiles:[profile]});client.close();
  });
});

describe('API source in native Overleaf settings',()=>{
  it('defaults to Codex; automatically saves the selected source and preserves instructions across list updates',async()=>{
    const model:PanelModel={settings:{...DEFAULT_SETTINGS,extraFiles:[]},files:[],index:emptyIndex(),status:'',busy:false,editorReady:true,codexProviders:[profile]};
    const save=vi.fn(async()=>{}),manage=vi.fn(async()=>{}),refresh=vi.fn(async()=>{});
    const ui=mountNativeSettings(()=>model,{save:vi.fn(async()=>{}),defaults:vi.fn(async()=>{}),refresh:vi.fn(async()=>{}),saveCodex:save,manageCodexProviders:manage,refreshCodexProviders:refresh});destroy=ui.destroy;
    document.body.insertAdjacentHTML('beforeend','<div role="dialog"><div class="ide-settings-modal-body"><nav class="ide-settings-tab-nav" role="tablist"><button role="tab" aria-selected="true">Editor</button></nav><div class="ide-settings-tab-content"><div role="tabpanel">Editor</div></div></div></div>');await flush();
    document.getElementById('opt-settings-tab')!.click();document.getElementById('opt-settings-codex-tab')!.click();
    const provider=document.getElementById('opt-codex-provider') as HTMLSelectElement;
    expect(provider.value).toBe('');expect(provider.options[0].text).toBe('Codex (default)');
    const instructions=document.getElementById('opt-codex-instructions') as HTMLTextAreaElement;instructions.value='Keep notation';instructions.dispatchEvent(new Event('input'));
    provider.value=id;provider.dispatchEvent(new Event('change'));
    expect(document.getElementById('opt-codex-model')!.closest<HTMLElement>('.ide-setting')?.hidden ?? document.getElementById('opt-codex-model')!.parentElement?.parentElement?.hidden).toBe(false);
    expect(document.querySelector('input[type=password]')).toBeNull();expect(document.getElementById('opt-codex-api-details')!.textContent).toContain('deepseek-flash');
    model.codexProviders=[{...profile,name:'Renamed connection'}];ui.update();expect(provider.value).toBe(id);expect(instructions.value).toBe('Keep notation');
    await flush();expect(save).toHaveBeenCalledWith(expect.objectContaining({providerId:id,instructions:'Keep notation'}));
    document.querySelector<HTMLButtonElement>('[data-opt-action=codex-manage-providers]')!.click();await flush();expect(manage).toHaveBeenCalledTimes(1);
  });
  it('lists API models, autosaves a distinct override, and keeps Codex model preferences separate',async()=>{
    const model:PanelModel={settings:{...DEFAULT_SETTINGS,extraFiles:[]},files:[],index:emptyIndex(),status:'',busy:false,editorReady:true,
      codex:{enabled:true,providerId:id,model:'gpt-6-astra',effort:'high',instructions:'',contextMode:'project'},codexProviders:[profile],
      codexModels:[{id:'deepseek-flash',displayName:'deepseek-flash'},{id:'deepseek-pro',displayName:'deepseek-pro'}]};
    const save=vi.fn(async value=>{model.codex={...value};});
    const ui=mountNativeSettings(()=>model,{save:vi.fn(async()=>{}),defaults:vi.fn(async()=>{}),refresh:vi.fn(async()=>{}),saveCodex:save});destroy=ui.destroy;
    document.body.insertAdjacentHTML('beforeend','<div role="dialog"><div class="ide-settings-modal-body"><nav class="ide-settings-tab-nav" role="tablist"><button role="tab" aria-selected="true">Editor</button></nav><div class="ide-settings-tab-content"><div role="tabpanel">Editor</div></div></div></div>');await flush();
    document.getElementById('opt-settings-tab')!.click();document.getElementById('opt-settings-codex-tab')!.click();
    const select=document.getElementById('opt-codex-model') as HTMLSelectElement;
    expect(select.closest<HTMLElement>('.ide-setting')!.hidden).toBe(false);
    expect(select.value).toBe('');expect(select.options[0].text).toBe('Connection default: deepseek-flash');
    expect([...select.options].map(x=>x.value)).toEqual(['','deepseek-flash','deepseek-pro','__custom__']);
    select.value='deepseek-pro';select.dispatchEvent(new Event('change'));await flush();
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({apiModel:'deepseek-pro',model:'gpt-6-astra',effort:'high'}));
    const provider=document.getElementById('opt-codex-provider') as HTMLSelectElement;
    provider.value='';provider.dispatchEvent(new Event('change'));await flush();
    expect(model.codex?.model).toBe('gpt-6-astra');expect(model.codex).not.toHaveProperty('apiModel');
    expect(select.options[0].text).toBe('Follow Codex');
  });
  it('allows custom API model IDs without a catalogue and rejects invalid input without saving it',async()=>{
    const model:PanelModel={settings:{...DEFAULT_SETTINGS,extraFiles:[]},files:[],index:emptyIndex(),status:'',busy:false,editorReady:true,
      codex:{enabled:true,providerId:id,model:'',effort:'',instructions:'',contextMode:'project'},codexProviders:[profile],codexModelsError:'No model list'};
    const save=vi.fn(async value=>{model.codex={...value};});
    const ui=mountNativeSettings(()=>model,{save:vi.fn(async()=>{}),defaults:vi.fn(async()=>{}),refresh:vi.fn(async()=>{}),saveCodex:save});destroy=ui.destroy;
    document.body.insertAdjacentHTML('beforeend','<div role="dialog"><div class="ide-settings-modal-body"><nav class="ide-settings-tab-nav" role="tablist"><button role="tab" aria-selected="true">Editor</button></nav><div class="ide-settings-tab-content"><div role="tabpanel">Editor</div></div></div></div>');await flush();
    document.getElementById('opt-settings-tab')!.click();document.getElementById('opt-settings-codex-tab')!.click();
    const select=document.getElementById('opt-codex-model') as HTMLSelectElement;
    expect(select.disabled).toBe(false);select.value='__custom__';select.dispatchEvent(new Event('change'));
    const field=document.getElementById('opt-codex-api-model-id') as HTMLInputElement;
    expect(document.activeElement).toBe(field);expect(field.closest<HTMLElement>('.ide-setting')!.hidden).toBe(false);
    field.value='bad id';field.dispatchEvent(new Event('input'));field.dispatchEvent(new Event('blur'));await flush();
    expect(save).not.toHaveBeenCalled();expect(field.getAttribute('aria-invalid')).toBe('true');ui.update();expect(field.value).toBe('bad id');
    field.value='vendor/model@v2+fast';field.dispatchEvent(new Event('input'));field.dispatchEvent(new Event('blur'));await flush();
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({apiModel:'vendor/model@v2+fast'}));
    expect(field.getAttribute('aria-invalid')).toBe('false');ui.update();expect(field.value).toBe('vendor/model@v2+fast');
    select.value='';select.dispatchEvent(new Event('change'));await flush();expect(model.codex).not.toHaveProperty('apiModel');
  });
  it('shows reading budgets only for an API source with project context and keeps hidden controls disabled',async()=>{
    const model:PanelModel={settings:{...DEFAULT_SETTINGS,extraFiles:[]},files:[],index:emptyIndex(),status:'',busy:false,editorReady:true,
      codex:{enabled:true,model:'',effort:'',instructions:'',contextMode:'project'},codexProviders:[profile]};
    const save=vi.fn(async value=>{model.codex={...value};});
    const ui=mountNativeSettings(()=>model,{save:vi.fn(async()=>{}),defaults:vi.fn(async()=>{}),refresh:vi.fn(async()=>{}),saveCodex:save});destroy=ui.destroy;
    document.body.insertAdjacentHTML('beforeend','<div role="dialog"><div class="ide-settings-modal-body"><nav class="ide-settings-tab-nav" role="tablist"><button role="tab" aria-selected="true">Editor</button></nav><div class="ide-settings-tab-content"><div role="tabpanel">Editor</div></div></div></div>');await flush();
    document.getElementById('opt-settings-tab')!.click();document.getElementById('opt-settings-codex-tab')!.click();
    const budget=document.getElementById('opt-codex-api-budget')!;
    const fields=[...budget.querySelectorAll<HTMLInputElement>('input')];
    const provider=document.getElementById('opt-codex-provider') as HTMLSelectElement;
    const context=document.getElementById('opt-codex-context') as HTMLSelectElement;
    expect(fields).toHaveLength(3);expect(budget.hidden).toBe(true);expect(fields.every(field=>field.disabled)).toBe(true);
    provider.value=id;provider.dispatchEvent(new Event('change'));await flush();
    expect(budget.hidden).toBe(false);expect(fields.every(field=>!field.disabled)).toBe(true);
    context.value='selection';context.dispatchEvent(new Event('change'));await flush();
    expect(budget.hidden).toBe(true);expect(fields.every(field=>field.disabled)).toBe(true);
    context.value='project';context.dispatchEvent(new Event('change'));await flush();
    expect(budget.hidden).toBe(false);expect(fields.every(field=>!field.disabled)).toBe(true);
    provider.value='';provider.dispatchEvent(new Event('change'));await flush();
    expect(budget.hidden).toBe(true);expect(fields.every(field=>field.disabled)).toBe(true);
  });
  it('labels API answers accurately and hides Desktop opening for the API history',async()=>{
    let settings={enabled:true,providerId:id,providerName:'DeepSeek'};
    document.body.innerHTML='<div class="ide-redesign-inner"><nav class="ide-rail"><div class="ide-rail-tabs-nav"><div class="ide-rail-tabs-wrapper"><button id="ide-rail-tabs-tab-workbench" class="ide-rail-tab-link">AI assistant</button></div></div></nav><div id="ide-redesign-sidebar-panel-workbench"></div><div id="ide-redesign-editor-and-pdf-panel"></div></div>';
    const panel=mountCodexAssistant({projectId:'project',getSettings:()=>settings,onSend:vi.fn(async()=>{}),onCancel:vi.fn(),onNewChat:vi.fn(async()=>{}),onListConversations:vi.fn(async()=>({conversations:[{id,title:'API chat',updatedAt:123}]})),onSelectConversation:vi.fn(async()=>{}),onOpenConversationInCodex:vi.fn(async()=>{})});destroy=panel.destroy;
    await flush();panel.open();panel.appendMessage('assistant','API answer');expect(document.querySelector('.opt-codex-title')!.textContent).toBe('DeepSeek');expect(document.querySelector('.opt-codex-role-name')!.textContent).toBe('DeepSeek');
    document.querySelector<HTMLButtonElement>('[aria-label="Conversation history"]')!.click();await flush();expect(document.querySelector('.opt-codex-open-conversation')).toBeNull();
    settings={enabled:true,providerId:'',providerName:''};panel.update();await flush();expect(document.querySelector('.opt-codex-open-conversation')).not.toBeNull();
  });
});
