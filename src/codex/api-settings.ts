import type { APIProfile } from './types';

type ManagementOp = 'provider-list' | 'provider-save' | 'provider-delete' | 'provider-test';
interface ManagementResponse { profiles: APIProfile[]; message?: string }
type ManagementData = { profile?: { id?: string; name: string; baseUrl: string; model: string; apiKey?: string }; providerId?: string };
type ManagementRequest = (op: ManagementOp, data?: ManagementData) => Promise<ManagementResponse>;
const copy = {
  en: {
    title:'API connections', subtitle:'Overleaf Personal Tools · Codex remains the default.', language:'Language', connections:'Saved connections', add:'Add connection', refresh:'Refresh', empty:'No API connections saved yet.',
    newTitle:'New connection', editTitle:'Edit connection', preset:'Use DeepSeek defaults', name:'Connection name', nameHint:'A short name shown in Overleaf, such as DeepSeek.', nameError:'Enter a connection name.', url:'API base URL', urlHint:'Use an OpenAI-compatible Chat Completions API. HTTPS is required, except for a local service.', urlLocked:'The address stays fixed for this connection. Add a new connection to use another address.', urlError:'Enter a complete API URL.', model:'Model ID', modelHint:'Use the exact model ID supplied by your provider.', modelError:'Enter a model ID.', key:'API key', keyNew:'Saved only in a private local file on this Mac. Local services may not require a key.', keySaved:'A key is saved. Leave blank to keep it, or enter a replacement.', keyNone:'No key is saved. Enter one if your provider requires it.', save:'Save connection', test:'Check connection', remove:'Remove connection', confirm:'Remove this connection? Existing local chat history is kept.', yes:'Remove', cancel:'Cancel', saved:'Connection saved. Return to Overleaf, refresh the connection list and choose it. Project settings save automatically.', removed:'Connection removed. Existing local history was retained.', loading:'Loading connections…', saving:'Saving connection…', testing:'Checking the saved connection…', checking:'Checks the saved address and key through the model-list endpoint. No question or manuscript is sent.', ready:'Connection settings loaded.', failed:'The local helper is unavailable. Install the updated companion connection program and try again.', changed:'Save changes before checking this connection.', footer:'When you select an API in Overleaf, your question, selected passage and allowed project context are sent to that API. API conversations stay separate from Codex chats. Keys are never entered into the Overleaf page.',
  },
  zh: {
    title:'API 连接', subtitle:'Overleaf Personal Tools · 默认仍使用 Codex。', language:'语言', connections:'已保存的连接', add:'添加连接', refresh:'刷新', empty:'还没有保存 API 连接。',
    newTitle:'新连接', editTitle:'编辑连接', preset:'填入 DeepSeek 默认值', name:'连接名称', nameHint:'显示在 Overleaf 中的名称，例如 DeepSeek。', nameError:'请填写连接名称。', url:'API 地址', urlHint:'使用兼容 OpenAI Chat Completions 的接口。除本机服务外，需要 HTTPS。', urlLocked:'此连接的地址固定；使用其他地址时，请添加新连接。', urlError:'请填写完整的 API 地址。', model:'模型 ID', modelHint:'填写服务商提供的准确模型 ID。', modelError:'请填写模型 ID。', key:'API 密钥', keyNew:'只保存在这台 Mac 的私有本地文件中。本机服务可能不需要密钥。', keySaved:'已保存密钥。留空保持原密钥，填写新值即可替换。', keyNone:'尚未保存密钥；若服务商要求，请填写。', save:'保存连接', test:'检查连接', remove:'移除连接', confirm:'移除此连接？已有的本地聊天记录会保留。', yes:'移除', cancel:'取消', saved:'连接已保存。返回 Overleaf，刷新连接列表并选择该连接，项目设置会自动保存。', removed:'连接已移除，已有本地聊天记录仍保留。', loading:'正在读取连接…', saving:'正在保存连接…', testing:'正在检查已保存的连接…', checking:'通过模型列表接口检查已保存的地址和密钥，不发送问题或文稿。', ready:'已读取连接设置。', failed:'本机连接程序不可用，请安装更新后的配套连接程序再重试。', changed:'请先保存更改，再检查此连接。', footer:'在 Overleaf 选择 API 后，你的问题、选区及允许读取的项目上下文会发送给该 API。API 对话与 Codex 对话分别保存。密钥不会填入 Overleaf 网页。',
  },
};
function element<K extends keyof HTMLElementTagNameMap>(tag: K, cls='', text='') {
  const el=document.createElement(tag);el.className=cls;el.textContent=text;return el;
}
function profilesFrom(value: unknown): APIProfile[] | undefined {
  if(!Array.isArray(value)||value.length>100)return;
  const result:APIProfile[]=[];
  for(const p of value){
    if(!p || typeof p!=='object' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(p.id)
      || typeof p.name!=='string' || p.name.length>200 || typeof p.baseUrl!=='string' || p.baseUrl.length>2048
      || typeof p.model!=='string' || p.model.length>200 || typeof p.hasKey!=='boolean')return;
    result.push({id:p.id,name:p.name,baseUrl:p.baseUrl,model:p.model,hasKey:p.hasKey});
  }
  return result;
}
/** Dedicated extension-origin channel. No page messaging, URL keys or Chrome storage. */
export function createAPIManagementClient(runtime: typeof chrome.runtime) {
  let port:chrome.runtime.Port|undefined;
  const pending=new Map<string,{resolve(value:ManagementResponse):void;reject(reason:Error):void;timer:ReturnType<typeof setTimeout>}>();
  function close(reason='The connection closed.') {
    const old=port;port=undefined;
    for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error(reason));}pending.clear();
    try{old?.disconnect();}catch{ /* Already disconnected. */ }
  }
  function connect(){
    if(port)return port;
    const next=runtime.connect({name:'opt:api-settings'});port=next;
    next.onMessage.addListener(value=>{
      if(port!==next || !value || typeof value.id!=='string')return;
      const target=pending.get(value.id);if(!target)return;
      if(value.type!=='error' && value.type!=='profiles')return;
      clearTimeout(target.timer);pending.delete(value.id);
      if(value.type==='error'){target.reject(new Error(typeof value.message==='string'?value.message.slice(0,1500):'API connection request failed.'));return;}
      const profiles=profilesFrom(value.profiles);
      if(!profiles){target.reject(new Error('Invalid connection metadata.'));return;}
      target.resolve({profiles,...(typeof value.message==='string'?{message:value.message.slice(0,1500)}:{})});
    });
    next.onDisconnect.addListener(()=>{if(port===next)close(runtime.lastError?.message || 'The local helper disconnected.');});
    return next;
  }
  const request:ManagementRequest=(op,data={})=>new Promise((resolve,reject)=>{
    const id=crypto.randomUUID();
    try{
      const connection=connect();
      const timer=setTimeout(()=>{pending.delete(id);reject(new Error('The connection request timed out. Changes were not automatically retried.'));},60_000);
      pending.set(id,{resolve,reject,timer});connection.postMessage({version:1,id,op,...data});
    }catch(error){const saved=pending.get(id);if(saved)clearTimeout(saved.timer);pending.delete(id);reject(error);}
  });
  return {request,close};
}

export function mountAPISettings(root: HTMLElement, options: {request?:ManagementRequest;locale?:'en'|'zh'}={}) {
  let locale:'en'|'zh'=options.locale || (navigator.language.startsWith('zh')?'zh':'en');
  const client=options.request?undefined:createAPIManagementClient(chrome.runtime);
  const request=options.request || client!.request;
  let profiles:APIProfile[]=[],selected:string|undefined,busy=false,dirty=false,alive=true;
  const heading=element('header','api-header'),headingText=element('div');
  const title=element('h1'),subtitle=element('p','api-subtitle'),language=element('select','api-input api-locale');
  language.append(new Option('English','en'),new Option('简体中文','zh'));language.value=locale;
  headingText.append(title,subtitle);heading.append(headingText,language);
  const layout=element('div','api-layout'),left=element('section','api-list-pane'),right=element('section','api-form-pane');
  const listTitle=element('h2'),listActions=element('div','api-actions'),add=element('button','api-button'),refresh=element('button','api-button'),list=element('ul','api-list'),empty=element('p','api-empty');
  add.type=refresh.type='button';listActions.append(add,refresh);left.append(listTitle,listActions,list,empty);
  const form=element('form'),formHeading=element('div','api-form-heading'),formTitle=element('h2'),preset=element('button','api-button');preset.type='button';formHeading.append(formTitle,preset);form.append(formHeading);form.autocomplete='off';
  const fields={} as Record<'name'|'url'|'model'|'key',{input:HTMLInputElement;label:HTMLLabelElement;hint:HTMLElement;error:HTMLElement}>;
  for(const name of ['name','url','model','key'] as const){
    const box=element('div','api-field'),label=element('label'),hint=element('p','api-hint'),input=element('input','api-input'),error=element('p','api-validation');
    input.id='api-'+name;label.htmlFor=input.id;hint.id=input.id+'-hint';error.id=input.id+'-error';
    input.type=name==='key'?'password':name==='url'?'url':'text';input.required=name!=='key';input.maxLength=name==='key'?4096:name==='url'?2000:name==='model'?128:80;
    input.autocomplete='off';input.spellcheck=false;input.setAttribute('aria-describedby',hint.id);input.setAttribute('aria-errormessage',error.id);
    input.addEventListener('input',()=>{dirty=true;deleteBox.hidden=true;syncAria(input);updateButtons();});input.addEventListener('blur',()=>syncAria(input));
    box.append(label,hint,input,error);form.append(box);fields[name]={input,label,hint,error};
  }
  const actions=element('div','api-actions'),save=element('button','api-button api-primary'),test=element('button','api-button'),remove=element('button','api-button api-danger');
  save.type='submit';test.type=remove.type='button';actions.append(save,test,remove);
  const checkNote=element('p','api-check-note'),deleteBox=element('div','api-confirm'),deleteText=element('p'),deleteActions=element('div','api-actions'),yes=element('button','api-button api-danger'),cancel=element('button','api-button');
  yes.type=cancel.type='button';deleteActions.append(yes,cancel);deleteBox.append(deleteText,deleteActions);deleteBox.hidden=true;
  const status=element('p','api-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  form.append(actions,checkNote,deleteBox,status);right.append(form);layout.append(left,right);const footer=element('p','api-footer');root.replaceChildren(heading,layout,footer);
  function syncAria(input:HTMLInputElement){
    // Chromium 145+ supports :user-invalid; native validation owns focus/errors.
    try{input.setAttribute('aria-invalid',String(input.matches(':user-invalid')));}catch{input.removeAttribute('aria-invalid');}
  }
  function message(text:string,error=false){if(!alive)return;status.textContent=text;status.classList.toggle('is-error',error);}
  function updateButtons(){
    root.setAttribute('aria-busy',String(busy));
    for(const control of root.querySelectorAll<HTMLInputElement|HTMLButtonElement|HTMLSelectElement>('input,button,select'))control.disabled=busy;
    test.disabled=busy||!selected||dirty;remove.disabled=busy||!selected;preset.hidden=!!selected;remove.hidden=!selected;test.title=dirty?copy[locale].changed:'';
  }
  function labels(){
    const t=copy[locale];document.documentElement.lang=locale;document.title=t.title+' · Overleaf Personal Tools';
    title.textContent=t.title;subtitle.textContent=t.subtitle;language.setAttribute('aria-label',t.language);listTitle.textContent=t.connections;add.textContent=t.add;refresh.textContent=t.refresh;empty.textContent=t.empty;formTitle.textContent=selected?t.editTitle:t.newTitle;preset.textContent=t.preset;
    for(const name of ['name','url','model','key'] as const)fields[name].label.textContent=t[name];
    fields.name.hint.textContent=t.nameHint;fields.name.error.textContent=t.nameError;fields.url.hint.textContent=selected?t.urlLocked:t.urlHint;fields.url.error.textContent=t.urlError;fields.model.hint.textContent=t.modelHint;fields.model.error.textContent=t.modelError;
    const saved=profiles.find(profile=>profile.id===selected);fields.key.hint.textContent=selected?saved?.hasKey?t.keySaved:t.keyNone:t.keyNew;fields.key.error.textContent='';
    save.textContent=t.save;test.textContent=t.test;remove.textContent=t.remove;checkNote.textContent=t.checking;deleteText.textContent=t.confirm;yes.textContent=t.yes;cancel.textContent=t.cancel;footer.textContent=t.footer;
    list.replaceChildren();
    for(const p of profiles){const item=element('li'),choose=element('button');choose.type='button';choose.setAttribute('aria-current',String(p.id===selected));choose.append(document.createTextNode(p.name),element('small','',p.model));choose.onclick=()=>chooseProfile(p.id);item.append(choose);list.append(item);}
    empty.hidden=!!profiles.length;updateButtons();
  }
  function chooseProfile(id?:string){
    if(busy)return;selected=id;const p=profiles.find(value=>value.id===id);fields.name.input.value=p?.name||'';fields.url.input.value=p?.baseUrl||'';fields.url.input.readOnly=!!id;fields.model.input.value=p?.model||'';fields.key.input.value='';dirty=false;deleteBox.hidden=true;
    for(const f of Object.values(fields))f.input.removeAttribute('aria-invalid');labels();message('');
  }
  async function operation(label:string,fn:()=>Promise<void>){
    if(busy||!alive)return;busy=true;updateButtons();message(label);
    const secret=fields.key.input.value;
    try{await fn();}catch(error){let text=error instanceof Error?error.message:copy[locale].failed;if(secret)text=text.split(secret).join('[redacted]');message(text,true);}
    finally{busy=false;if(alive)updateButtons();}
  }
  async function refreshList(){await operation(copy[locale].loading,async()=>{const response=await request('provider-list');if(!alive)return;profiles=response.profiles;labels();message(response.message||copy[locale].ready);});}
  add.onclick=()=>chooseProfile();refresh.onclick=()=>void refreshList();
  preset.onclick=()=>{fields.name.input.value='DeepSeek';fields.url.input.value='https://api.deepseek.com';fields.model.input.value='deepseek-flash';dirty=true;updateButtons();fields.key.input.focus();};
  language.onchange=()=>{locale=language.value==='zh'?'zh':'en';labels();};
  form.onsubmit=event=>{event.preventDefault();if(!form.reportValidity()){for(const f of Object.values(fields))syncAria(f.input);return;}void operation(copy[locale].saving,async()=>{
    const previous=new Set(profiles.map(p=>p.id));
    const profile={...(selected?{id:selected}:{}),name:fields.name.input.value.trim(),baseUrl:fields.url.input.value.trim(),model:fields.model.input.value.trim(),...(fields.key.input.value?{apiKey:fields.key.input.value}:{})};
    const response=await request('provider-save',{profile});if(!alive)return;fields.key.input.value='';profiles=response.profiles;selected=selected||profiles.find(p=>!previous.has(p.id))?.id;fields.url.input.readOnly=!!selected;dirty=false;labels();message(response.message||copy[locale].saved);
  });};
  test.onclick=()=>{if(!selected||dirty)return;void operation(copy[locale].testing,async()=>{const response=await request('provider-test',{providerId:selected});if(!alive)return;profiles=response.profiles;labels();message(response.message||copy[locale].ready);});};
  remove.onclick=()=>{deleteBox.hidden=false;yes.focus();};cancel.onclick=()=>{deleteBox.hidden=true;remove.focus();};
  yes.onclick=()=>{if(!selected)return;void operation(copy[locale].loading,async()=>{const response=await request('provider-delete',{providerId:selected});if(!alive)return;profiles=response.profiles;selected=undefined;for(const f of Object.values(fields))f.input.value='';fields.url.input.readOnly=false;dirty=false;deleteBox.hidden=true;labels();message(copy[locale].removed);});};
  labels();void refreshList();
  const pagehide=()=>{fields.key.input.value='';client?.close();};window.addEventListener('pagehide',pagehide);
  return {refresh:refreshList,destroy(){alive=false;fields.key.input.value='';client?.close();window.removeEventListener('pagehide',pagehide);root.replaceChildren();}};
}
const root=document.getElementById('api-settings-root');
if(root)mountAPISettings(root);
