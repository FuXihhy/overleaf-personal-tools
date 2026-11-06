import { Compartment, EditorState, EditorSelection, Prec, StateEffect, StateField, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, keymap, lineNumbers } from '@codemirror/view';
import { autocompletion, acceptCompletion } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, undoDepth, redoDepth } from '@codemirror/commands';
import { sources } from './fixtures.mjs';
import { createVisualPreviewFixture } from './visual-preview';
import { validCodexRequest, type CodexRequest, type CodexSourceManifestEntry } from '../src/codex/types';

// Opt-in competing native output and typing checks with a real CodeMirror view.
const fixtureParams = new URLSearchParams(location.search);
if(fixtureParams.get('codex-editor-unavailable')==='1')window.addEventListener('opt:request-document-context',event=>{
  event.stopImmediatePropagation();
  const {id}=JSON.parse((event as CustomEvent<string>).detail);
  window.dispatchEvent(new CustomEvent('opt:document-context-result',{detail:JSON.stringify({id,ok:false,pending:true})}));
});
const previewRace = fixtureParams.get('preview-race') === '1';
const codexLongByDefault = fixtureParams.get('codex-long') === '1';
const codexFailFirstStatus = fixtureParams.get('codex-status-fail') === '1';
const codexRoutingFailure = fixtureParams.get('codex-routing-fail') === '1';
const codexRejectAsk = fixtureParams.get('codex-reject') === '1';
let syntheticSyncPending = fixtureParams.get('codex-sync-pending') === '1';
let syntheticSourceFailure = fixtureParams.get('codex-source-fail') === '1';
const cachedEditors = fixtureParams.get('cached-editors') === '1';
const syntheticAPIProfiles = fixtureParams.get('api-provider')==='1' ? [{id:'22222222-3333-4444-8555-666666666666',name:'Synthetic API',baseUrl:'https://api.example.invalid/v1',model:'synthetic-model',hasKey:true}] : [];
let codexStatusAttempts = 0;
const themeSelect=document.getElementById('fixture-theme') as HTMLSelectElement;
themeSelect.value=fixtureParams.get('theme')==='dark'?'dark':'light';
const applyTheme=()=>{document.documentElement.dataset.theme=themeSelect.value;};
themeSelect.onchange=applyTheme;applyTheme();
const nativePreview = new URLSearchParams(location.search).get('native-preview') !== '0';
let raceStatus: HTMLElement | undefined;
let raceGeneration = 0;

function simulateNativePreview(native: HTMLElement, formula: string) {
  const generation=++raceGeneration;
  const original=native.querySelector<HTMLElement>('.native-formula')!;
  original.style.opacity='0';original.textContent=formula;
  let nativeErrorFrames=0, nativeVisibleFrames=0, frames=0;
  // The real host initially exposes raw formula text at opacity zero, then
  // asynchronously replaces it with MathJax SVG. This deliberately races the
  // extension; only the NativeOnly probe has a successful native result.
  [45,240].forEach(delay=>setTimeout(()=>{
    if(!native.isConnected)return;
    const success=formula==='\\fixtureNativeOnly';
    original.innerHTML=success
      ? '<mjx-container class="MathJax" jax="SVG"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><text x="3" y="18">N</text></svg></mjx-container>'
      : '<mjx-container class="MathJax" jax="SVG"><svg xmlns="http://www.w3.org/2000/svg" width="240" height="24"><g data-mml-node="merror"><text x="0" y="18">Native undefined control sequence</text></g></svg></mjx-container>';
    original.style.opacity='1';
  },delay));
  const inspect=()=>{
    if(generation!==raceGeneration||!native.isConnected||frames++>=90)return;
    const style=getComputedStyle(original);
    const visible=style.display!=='none'&&style.visibility!=='hidden'&&style.opacity!=='0'&&original.getBoundingClientRect().width>0;
    if(visible){nativeVisibleFrames++;if(original.querySelector('[data-mml-node="merror"]'))nativeErrorFrames++;}
    if(raceStatus){
      raceStatus.dataset.nativeErrorFrames=String(nativeErrorFrames);
      raceStatus.dataset.nativeVisibleFrames=String(nativeVisibleFrames);
      raceStatus.dataset.sampledFrames=String(frames);
      raceStatus.textContent=`Formula: ${formula}; native error frames: ${nativeErrorFrames}; visible native frames: ${nativeVisibleFrames}; sampled: ${frames}/90.`;
    }
    requestAnimationFrame(inspect);
  };
  requestAnimationFrame(inspect);
}
// Exercise the same public metadata contract as Overleaf's language bootstrap.
const languageMeta=document.createElement('meta');languageMeta.name='ol-i18n';
languageMeta.content=JSON.stringify({currentLangCode:'en'});document.head.append(languageMeta);
document.getElementById('fixture-language')!.onchange=event=>{
  const code=(event.target as HTMLSelectElement).value;
  languageMeta.content=JSON.stringify({currentLangCode:code});document.documentElement.lang=code;
};

const storage: Record<string, unknown> = {};
const sessionStorage: Record<string, unknown> = {};
const historyStorage = new Map<string, unknown[]>();
const queueStorage = new Map<string, {revision:string;items:unknown[]}>();
type SyntheticSourceUpload = { projectId: string; accountId?: string; rootPath: string; manifest: CodexSourceManifestEntry[]; files: Map<string,string> };
const syntheticSourceUploads = new Map<string,SyntheticSourceUpload>();
const syntheticSourceSnapshots = new Map<string,SyntheticSourceUpload>();
const sourceSyncStatus = document.createElement('p');sourceSyncStatus.id='fixture-source-sync-status';sourceSyncStatus.setAttribute('role','status');sourceSyncStatus.textContent='人工测试 · Complete project snapshots: none yet.';
document.getElementById('fixture-state')!.after(sourceSyncStatus);
const restoreSourceButton=document.createElement('button');restoreSourceButton.type='button';restoreSourceButton.textContent='Restore simulated source access';restoreSourceButton.hidden=!syntheticSourceFailure;
restoreSourceButton.onclick=()=>{syntheticSourceFailure=false;restoreSourceButton.disabled=true;restoreSourceButton.textContent='Simulated source access restored';};
sourceSyncStatus.after(restoreSourceButton);
let syntheticSourceChunks=0,syntheticSourceCommits=0;
const sourceDigest=async(value:string)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
async function syntheticSourceRequest(request:CodexRequest):Promise<Record<string,unknown>>{
  if(!validCodexRequest(request))throw new Error('Invalid synthetic source request.');
  if(syntheticSourceFailure)throw new Error('Synthetic project cache access failed.');
  if(request.op==='source-check'){
    const snapshot=syntheticSourceSnapshots.get(request.snapshotId!);
    if(!snapshot || snapshot.projectId!==request.projectId || snapshot.accountId!==request.accountId)throw new Error('Synthetic snapshot unavailable.');
    return {type:'source',snapshotId:request.snapshotId};
  }
  if(request.op==='source-begin'){
    const files=new Map<string,string>(),missingPaths:string[]=[];
    for(const entry of request.sourceManifest!){
      let reused:string|undefined;
      for(const old of syntheticSourceSnapshots.values()){
        if(old.projectId!==request.projectId || old.accountId!==request.accountId)continue;
        const previous=old.manifest.find(file=>file.sha256===entry.sha256 && file.bytes===entry.bytes);
        if(previous){reused=old.files.get(previous.path);if(reused!==undefined)break;}
      }
      files.set(entry.path,reused??'');if(reused===undefined)missingPaths.push(entry.path);
    }
    const uploadId=crypto.randomUUID();syntheticSourceUploads.set(uploadId,{projectId:request.projectId,accountId:request.accountId,rootPath:request.rootPath!,manifest:structuredClone(request.sourceManifest!),files});
    sourceSyncStatus.dataset.state='uploading';sourceSyncStatus.textContent=`人工测试 · Uploading ${request.sourceManifest!.length} complete source files.`;
    sourceSyncStatus.dataset.missing=String(missingPaths.length);
    return {type:'source',uploadId,missingPaths};
  }
  const upload=syntheticSourceUploads.get(request.uploadId!);
  if(!upload || upload.projectId!==request.projectId || upload.accountId!==request.accountId)throw new Error('Synthetic source upload is unavailable in this project.');
  if(request.op==='source-chunk'){
    const previous=upload.files.get(request.path!),entry=upload.manifest.find(file=>file.path===request.path);
    if(previous===undefined || !entry || new TextEncoder().encode(previous).byteLength!==request.offset || new TextEncoder().encode(previous+request.content!).byteLength>entry.bytes)throw new Error('Synthetic source chunk has a gap or exceeds the manifest.');
    upload.files.set(request.path!,previous+request.content!);sourceSyncStatus.dataset.chunks=String(++syntheticSourceChunks);return {type:'source',uploadId:request.uploadId};
  }
  for(const entry of upload.manifest){const content=upload.files.get(entry.path)!;if(new TextEncoder().encode(content).byteLength!==entry.bytes || await sourceDigest(content)!==entry.sha256)throw new Error('Synthetic complete source digest mismatch.');}
  const snapshotId=await sourceDigest(JSON.stringify([upload.projectId,upload.accountId,upload.rootPath,upload.manifest]));syntheticSourceSnapshots.set(snapshotId,upload);syntheticSourceUploads.delete(request.uploadId!);
  const totalBytes=upload.manifest.reduce((sum,file)=>sum+file.bytes,0);sourceSyncStatus.dataset.state='complete';sourceSyncStatus.dataset.snapshotId=snapshotId;sourceSyncStatus.dataset.files=String(upload.manifest.length);sourceSyncStatus.dataset.bytes=String(totalBytes);sourceSyncStatus.dataset.commits=String(++syntheticSourceCommits);
  sourceSyncStatus.textContent=`人工测试 · Complete snapshot ${snapshotId.slice(0,12)}; ${upload.manifest.length} files; ${totalBytes} UTF-8 bytes; ${syntheticSourceChunks} chunks; ${syntheticSourceCommits} commits.`;
  return {type:'source',snapshotId,fileCount:upload.manifest.length,totalBytes};
}
type SyntheticMessage={messageId:string;role:'user'|'assistant';text:string;selection?:unknown;answerQuote?:unknown};
type SyntheticConversation={id:string;title:string;updatedAt:number;messages:SyntheticMessage[];remoteState:'idle'|'active'|'unknown';revision:number};
let syntheticConversation=1;
let syntheticMessage=0, syntheticDesktopTurn=0, syntheticReadCount=0;
const syntheticThreadId=()=>`00000000-0000-4000-8000-${String(syntheticConversation).padStart(12,'0')}`;
const syntheticMessageId=()=>`synthetic-message-${++syntheticMessage}`;
let syntheticActiveId:string|undefined;
const syntheticConversations=new Map<string,SyntheticConversation>();
const syntheticRevision=(conversation?:SyntheticConversation)=>String((conversation?.revision??0).toString(16)).padStart(64,'0');
let syntheticWebReply=false;
function updateSyntheticSyncStatus(){
  const conversation=syntheticActiveId?syntheticConversations.get(syntheticActiveId):undefined;
  const status=document.getElementById('fixture-codex-sync-status')!;
  status.dataset.reads=String(syntheticReadCount);status.dataset.remoteState=conversation?.remoteState??'idle';status.dataset.revision=syntheticRevision(conversation);
  status.dataset.messages=String(conversation?.messages.length??0);status.dataset.conversationId=conversation?.id??'';
  status.dataset.syncPending=String(syntheticSyncPending);
  status.textContent=`人工测试 · desktop turns ${syntheticDesktopTurn}; native history reads ${syntheticReadCount}; remote ${conversation?.remoteState??'idle'}; revision ${conversation?.revision??0}; messages ${conversation?.messages.length??0}.`;
  for(const id of ['fixture-codex-desktop-append','fixture-codex-desktop-start']) (document.getElementById(id) as HTMLButtonElement).disabled=!conversation||syntheticWebReply||conversation.remoteState==='active';
  (document.getElementById('fixture-codex-desktop-finish') as HTMLButtonElement).disabled=!conversation||syntheticWebReply||conversation.remoteState!=='active';
  (document.getElementById('fixture-codex-release-page') as HTMLButtonElement).disabled=!syntheticSyncPending;
}
function touchSyntheticConversation(conversation:SyntheticConversation){conversation.updatedAt=Date.now();conversation.revision++;updateSyntheticSyncStatus();}
if(fixtureParams.get('codex-history')==='1'||fixtureParams.get('quote-return')==='1'){
  const id=syntheticThreadId();syntheticActiveId=id;
  syntheticConversations.set(id,{id,title:'人工测试 · Saved derivation',updatedAt:Date.now(),remoteState:'idle',revision:1,messages:Array.from({length:42},(_,i)=>({messageId:syntheticMessageId(),role:i%2?'assistant':'user',text:i%2?`Saved answer ${i}: \\(x_${i}^2\\).`:`Saved question ${i+1}`}))});
  syntheticConversation++;
  const second=syntheticThreadId();syntheticConversations.set(second,{id:second,title:'人工测试 · Another conversation',updatedAt:Date.now()-60000,remoteState:'idle',revision:1,messages:[{messageId:syntheticMessageId(),role:'user',text:'What is the derivative?'},{messageId:syntheticMessageId(),role:'assistant',text:'It is \\(2x\\).'}]});
  if(fixtureParams.get('quote-return')==='1'){
    const c=syntheticConversations.get(id)!;
    const sourceQuote=(path:keyof typeof sources,text:string)=>{const source=sources[path],from=source.indexOf(text);return {path,text,from,to:from+text.length,startLine:source.slice(0,from).split('\n').length,endLine:source.slice(0,from+text.length).split('\n').length,before:'',after:''};};
    c.messages[1].text='The original quoted answer explains \\(x^2+y^2\\).\n\nKeep the source visible when returning to it.';
    c.messages.push(
      {messageId:syntheticMessageId(),role:'user',text:'Return to this equation in Code or Visual.',selection:sourceQuote('main.tex','Unclicked custom formula: $\\cN=(1,0)$.')},
      {messageId:syntheticMessageId(),role:'assistant',text:'The selected passage contains the custom macro \\(\\cN\\).'},
      {messageId:syntheticMessageId(),role:'user',text:'Return to the nested source file.',selection:sourceQuote('defs/extra.tex','\\DeclareMathOperator{\\Spec}{Spec}')},
      {messageId:syntheticMessageId(),role:'assistant',text:'This definition belongs to defs/extra.tex.'},
      {messageId:syntheticMessageId(),role:'user',text:'Return to the answer on an older history page.',answerQuote:{messageId:c.messages[1].messageId,text:'The original quoted answer explains \\(x^2+y^2\\).'}},
      {messageId:syntheticMessageId(),role:'assistant',text:'The original answer is preserved in the same conversation.'},
    );
  }
}
// Visible controls mutate only this in-memory synthetic host. The real content
// script must discover them through its normal history-read polling, not a DOM
// injection or a manually dispatched refresh event.
const addSyntheticDesktopTurn=(active:boolean)=>{
  const conversation=syntheticActiveId?syntheticConversations.get(syntheticActiveId):undefined;
  if(!conversation||syntheticWebReply||conversation.remoteState==='active')return;
  const turn=++syntheticDesktopTurn;
  conversation.messages.push({messageId:syntheticMessageId(),role:'user',text:`人工测试 · Desktop question ${turn}: explain the synthetic example.`},
    {messageId:syntheticMessageId(),role:'assistant',text:`**人工测试 · Desktop answer ${turn}**\n\nThis message was added by the synthetic desktop control. Formula: \\(u_${turn}+v_${turn}=w_${turn}\\).\n\n${active?'Synthetic desktop response in progress…':'Synthetic desktop response complete.'}`});
  conversation.remoteState=active?'active':'idle';touchSyntheticConversation(conversation);
};
document.getElementById('fixture-codex-desktop-append')!.onclick=()=>addSyntheticDesktopTurn(false);
document.getElementById('fixture-codex-release-page')!.onclick=()=>{syntheticSyncPending=false;updateSyntheticSyncStatus();};
document.getElementById('fixture-codex-desktop-start')!.onclick=()=>addSyntheticDesktopTurn(true);
document.getElementById('fixture-codex-desktop-finish')!.onclick=()=>{
  const conversation=syntheticActiveId?syntheticConversations.get(syntheticActiveId):undefined;
  if(!conversation||syntheticWebReply||conversation.remoteState!=='active')return;
  const message=conversation.messages.at(-1);
  if(message?.role==='assistant')message.text=message.text.replace('Synthetic desktop response in progress…','Synthetic desktop response complete.\n\nThe stable message ID is unchanged; this final paragraph was added remotely.');
  conversation.remoteState='idle';touchSyntheticConversation(conversation);
};
updateSyntheticSyncStatus();
const syntheticStorage = (values: Record<string, unknown>) => ({
  async get(keys: string[] | string) { return Object.fromEntries((typeof keys==='string'?[keys]:keys).filter(key=>key in values).map(key=>[key,values[key]])); },
  async remove(keys: string[] | string) { for(const key of typeof keys==='string'?[keys]:keys)delete values[key]; },
  async set(next: Record<string, unknown>) { Object.assign(values,next);const preference=Object.entries(next).find(([key])=>key.endsWith(':click-to-copy'));if(preference){const status=document.getElementById('fixture-codex-copy-status')!;status.dataset.enabled=String(preference[1]===true);status.textContent=`人工测试 · Saved click-to-copy preference: ${preference[1]===true?'on':'off'}.`; } },
});
function syntheticCodexPort(options: { name: string }) {
  if(options.name!=='opt:codex')throw new Error('人工测试页面只提供模拟 Codex 连接。');
  const messageListeners=new Set<(message: unknown)=>void>();
  const disconnectListeners=new Set<()=>void>();
  let disconnected=false;
  let active: {id:string;text:string;conversationId:string;turnId:string;canSteer:boolean;timers:ReturnType<typeof setTimeout>[]} | undefined;
  let progressTimer:ReturnType<typeof setInterval> | undefined;
  let progressPhase='idle',progressChunk=0,progressTotal=0;
  const updateProgress=()=>{
    const status=document.getElementById('fixture-codex-stream-status')!;
    const transcript=document.querySelector<HTMLElement>('#opt-codex-panel .opt-codex-messages');
    const math=[...document.querySelectorAll('#opt-codex-panel .opt-codex-math')];
    const rendered=math.filter(node=>node.querySelector('svg')).length;
    status.dataset.phase=progressPhase;status.dataset.chunks=String(progressChunk);status.dataset.totalChunks=String(progressTotal);
    status.dataset.mathCount=String(math.length);status.dataset.renderedMath=String(rendered);
    status.textContent=`人工测试 · ${progressPhase}; chunks ${progressChunk}/${progressTotal}; math ${rendered}/${math.length}; scrollTop ${Math.round(transcript?.scrollTop??0)}; below viewport ${Math.round(transcript?transcript.scrollHeight-transcript.scrollTop-transcript.clientHeight:0)}.`;
    (document.getElementById('fixture-codex-long') as HTMLButtonElement).disabled=!!active;
  };
  const finishProgress=(phase:string)=>{progressPhase=phase;clearInterval(progressTimer);progressTimer=undefined;updateProgress();setTimeout(updateProgress,800);};
  const threadId=()=>syntheticActiveId;
  const saveAnswer=(pending:{text:string;conversationId:string})=>{const c=syntheticConversations.get(pending.conversationId);syntheticWebReply=false;if(c){if(pending.text)c.messages.push({messageId:syntheticMessageId(),role:'assistant',text:pending.text});c.remoteState='idle';touchSyntheticConversation(c);}else updateSyntheticSyncStatus();};
  const emit=(message:unknown)=>{if(!disconnected)for(const listener of messageListeners)listener(message);};
  const stop=()=>{
    const pending=active;active=undefined;
    if(pending){for(const timer of pending.timers)clearTimeout(timer);saveAnswer(pending);emit({id:pending.id,type:'done',text:pending.text,threadId:threadId()});finishProgress('cancelled');}
  };
  return {
    name:options.name,
    onMessage:{addListener(listener:(message:unknown)=>void){messageListeners.add(listener);},removeListener(listener:(message:unknown)=>void){messageListeners.delete(listener);}},
    onDisconnect:{addListener(listener:()=>void){disconnectListeners.add(listener);},removeListener(listener:()=>void){disconnectListeners.delete(listener);}},
    postMessage(request: CodexRequest) {
      if(disconnected)throw new Error('Synthetic connection closed.');
      if(request.op.startsWith('source-')){void syntheticSourceRequest(request).then(result=>emit({id:request.id,...result})).catch(error=>{sourceSyncStatus.dataset.state='error';sourceSyncStatus.textContent=String(error);emit({id:request.id,type:'error',message:String(error)});});return;}
      if((request.op==='ask'||request.op==='steer') && request.snapshotId){const snapshot=syntheticSourceSnapshots.get(request.snapshotId);if(!snapshot || snapshot.projectId!==request.projectId || snapshot.accountId!==request.accountId){queueMicrotask(()=>emit({id:request.id,type:'error',notAccepted:true,message:'Synthetic complete project snapshot is unavailable.'}));return;}sourceSyncStatus.dataset.usedSnapshot=request.snapshotId;}
      if(request.op==='provider-list'){queueMicrotask(()=>emit({id:request.id,type:'profiles',profiles:syntheticAPIProfiles}));return;}
      if(request.op==='history-list'){
        queueMicrotask(()=>emit({id:request.id,type:'history',activeConversationId:syntheticActiveId,conversations:[...syntheticConversations.values()].map(c=>({id:c.id,title:c.title,updatedAt:c.updatedAt,current:c.id===syntheticActiveId}))}));return;
      }
      if(request.op==='history-read'||request.op==='history-select'){
        const id=request.conversationId??syntheticActiveId;
        const c=id?syntheticConversations.get(id):undefined;
        if(id&&!c){queueMicrotask(()=>emit({id:request.id,type:'error',message:'Synthetic conversation not found'}));return;}
        if(request.op==='history-select')syntheticActiveId=id;
        const end=request.cursor?Number(request.cursor):c?.messages.length??0,start=Math.max(0,end-12);
        syntheticReadCount++;updateSyntheticSyncStatus();
        const page={id:request.id,type:'history',conversationId:id,activeConversationId:syntheticActiveId,
          ...(syntheticSyncPending?{remoteState:'unknown',syncPending:true}:{remoteState:c?.remoteState??'idle',syncRevision:syntheticRevision(c)}),
          messages:structuredClone(c?.messages.slice(start,end)??[]),...(start?{nextCursor:String(start)}:{})};
        queueMicrotask(()=>emit(page));return;
      }
      if(request.op==='status'){
        const attempt=++codexStatusAttempts;
        const status=document.getElementById('fixture-codex-model-status')!;
        status.textContent=`人工测试 · catalogue request ${attempt}: loading (500 ms delay).`;status.dataset.attempts=String(attempt);
        setTimeout(()=>{
          const fail=(codexFailFirstStatus || codexRoutingFailure) && attempt===1;
          status.textContent=`人工测试 · catalogue request ${attempt}: ${fail?'simulated first-request failure':'two simulated models loaded'}.`;
          emit({id:request.id,type:'status',available:!fail,authenticated:!fail,...(fail && codexRoutingFailure?{errorCode:'routing_timeout',retryable:true,diagnostic:'Synthetic account/read: workspace routing discovery timed out'}:{}),message:fail?(codexRoutingFailure?'Codex workspace connection timed out.':'人工测试：首次连接失败，请重试。'):'人工测试：模拟连接，未调用真实 Codex。',models:fail?[]:[
            {id:'synthetic-model-a',displayName:'人工测试 · Model A',efforts:['low','medium','high','xhigh']},
            {id:'synthetic-model-b',displayName:'人工测试 · Model B',efforts:['minimal','low','medium']},
            ...(codexRoutingFailure?[{id:'gpt-6-astra',displayName:'人工测试 · GPT-6-Astra',efforts:['low','medium','high','xhigh','max','ultra']}]:[]),
          ]});
        },500);return;
      }
      if(request.op==='cancel'){
        queueMicrotask(()=>{stop();emit({id:request.id,type:'done',threadId:threadId(),message:'人工测试：已停止模拟回答。'});});return;
      }
      if(request.op==='steer'){
        const pending=active;
        if(!pending||!pending.canSteer||request.providerId||request.expectedConversationId!==pending.conversationId||request.expectedTurnId!==pending.turnId){
          queueMicrotask(()=>emit({id:request.id,type:'error',message:'人工测试：此轮已结束或不支持引导；问题没有发送。'}));return;
        }
        const conversation=syntheticConversations.get(pending.conversationId)!;
        const userMessageId=syntheticMessageId();
        conversation.messages.push({messageId:userMessageId,role:'user',text:request.question!,...(request.selection?{selection:request.selection}:{}),...(request.answerQuote?{answerQuote:request.answerQuote}:{})});
        touchSyntheticConversation(conversation);
        queueMicrotask(()=>{
          emit({id:request.id,type:'steered',threadId:pending.conversationId,turnId:pending.turnId,userMessageId});
          if(active===pending){const chunk='\n\n人工测试：已收到当前回复的补充要求。\n\n';pending.text+=chunk;emit({id:pending.id,type:'delta',text:chunk});}
        });return;
      }
      if(request.op==='new-chat'){
        queueMicrotask(()=>{stop();syntheticActiveId=undefined;updateSyntheticSyncStatus();emit({id:request.id,type:'done',text:'',message:'人工测试：已开始新的模拟对话。'});});return;
      }
      if(request.op!=='ask'){
        queueMicrotask(()=>emit({id:request.id,type:'error',message:'人工测试：不支持此请求。'}));return;
      }
      if(active){queueMicrotask(()=>emit({id:request.id,type:'error',message:'人工测试：已有模拟回答正在生成。'}));return;}
      const current=syntheticActiveId?syntheticConversations.get(syntheticActiveId):undefined;
      if(request.expectedConversationId!==undefined&&request.expectedConversationId!==(syntheticActiveId??null)||request.expectedSyncRevision&&request.expectedSyncRevision!==syntheticRevision(current)){
        queueMicrotask(()=>emit({id:request.id,type:'error',message:'人工测试：模拟桌面对话已更新，请先同步。'}));return;
      }
      if(current?.remoteState==='active'){queueMicrotask(()=>emit({id:request.id,type:'error',message:'人工测试：模拟桌面端仍在回复。'}));return;}
      if(codexRejectAsk){queueMicrotask(()=>emit({id:request.id,type:'error',notAccepted:true,message:'人工测试：模拟上下文参数被拒绝，问题未发送。'}));return;}
      const long=codexLongByDefault || request.question?.includes('[LONG-QA]');
      const longAnswer=[
        '**人工测试 · 长篇模拟回答**\n\n以下文字与公式均为 UI 验收数据，不代表对文稿的实际分析。请在生成期间向上滚动，确认阅读位置保持稳定。\n\n',
        ...Array.from({length:112},(_,index)=>{const n=index+1;return `段落 ${n}：这一段用于验证历史阅读位置。行内公式 \\(x_{${n}}^2+y_{${n}}^2=z_{${n}}^2\\) 应正常渲染；新内容到达时，手动上移的阅读位置应保留。\n\n`+(n%14===0?'\\[\\sum_{k=1}^{n}k=\\frac{n(n+1)}{2}\\]\n\n':'');}),
        '## 截图回归样例（模拟文字）\n\n',
        '- 选中段落之前的“the reducing direction is \\(E_5\\)”不准确。实施零模截断的是 \\(K=\\partial_y|_x\\)；\\(E_5\\) 是进入正交标架计算的方向。这一区别恰好是整个推导的起点。\n',
        '- 后面分隔线之后又保留了一套没有 \\(1/\\sqrt2\\) 的公式。在 \\(\\sigma\\)、几何向量 \\(V\\) 和 \\(Q\\psi=D\\sigma\\) 的约定都不变时，它不能直接与当前这套公式混用，需要明确重定义或统一约定。\n\n',
        '人工测试结束：末尾应有完整公式，向上阅读时不应被强制拉到最新内容。',
      ].join('');
      const smallChunks=[
        '**人工测试 · 模拟回答**\n\n',
        '这里用于验证选区、流式输出和公式排版，未调用真实 Codex。\n\n',
        '以函数 \\(x^2\\) 为例，',
        '它的导数是\n\n',
        '\\[\\frac{d}{dx}x^2=2x\\]\n\n',
        '本段是固定测试文本，不代表对所选文稿的实际分析。',
      ];
      const chunkSize=Math.ceil(longAnswer.length/100);
      const chunks=long?Array.from({length:Math.ceil(longAnswer.length/chunkSize)},(_,i)=>longAnswer.slice(i*chunkSize,(i+1)*chunkSize)):smallChunks;
      const interval=long?150:230;
      if(!syntheticActiveId){syntheticConversation++;syntheticActiveId=syntheticThreadId();syntheticConversations.set(syntheticActiveId,{id:syntheticActiveId,title:'人工测试 · '+request.question!.slice(0,60),updatedAt:Date.now(),messages:[],remoteState:'idle',revision:1});}
      const conversation=syntheticConversations.get(syntheticActiveId)!;
      conversation.messages.push({messageId:syntheticMessageId(),role:'user',text:request.question!,...(request.selection?{selection:request.selection}:{}),...(request.answerQuote?{answerQuote:request.answerQuote}:{})});
      conversation.remoteState='active';syntheticWebReply=true;touchSyntheticConversation(conversation);
      const pending={id:request.id,text:'',conversationId:syntheticActiveId,turnId:crypto.randomUUID(),canSteer:!request.providerId,timers:[] as ReturnType<typeof setTimeout>[]};active=pending;
      progressPhase='streaming';progressChunk=0;progressTotal=chunks.length;updateProgress();
      clearInterval(progressTimer);progressTimer=setInterval(updateProgress,250);
      queueMicrotask(()=>emit({id:request.id,type:'started',threadId:threadId(),turnId:pending.turnId,canSteer:pending.canSteer}));
      chunks.forEach((chunk,index)=>pending.timers.push(setTimeout(()=>{
        if(active!==pending)return;pending.text+=chunk;progressChunk=index+1;emit({id:request.id,type:'delta',text:chunk});
      },160+index*interval)));
      pending.timers.push(setTimeout(()=>{if(active!==pending)return;active=undefined;saveAnswer(pending);emit({id:request.id,type:'done',text:pending.text,threadId:threadId()});finishProgress('complete');},200+chunks.length*interval));
    },
    disconnect(){if(disconnected)return;stop();disconnected=true;for(const listener of disconnectListeners)listener();},
  };
}
Object.defineProperty(window, 'chrome', { configurable: true, value: {
  storage: { local:syntheticStorage(storage),session:syntheticStorage(sessionStorage) },
  runtime: {
    id:'synthetic-extension',
    getURL(path:string){return `${location.origin}/dist/${path}`;},
    connect:syntheticCodexPort,
    sendMessage(message:{type?:string;accountId?:string;projectId?:string;providerId?:string;action?:string;messages?:unknown[];items?:unknown[];expectedRevision?:string},callback?:(value:unknown)=>void){
      let result:unknown={available:false,message:'人工测试页面未连接本机服务。',diagnostics:['人工测试页面未连接本机服务。']};
      if(message.type==='opt:codex-history'){
        const key=`${message.accountId}:${message.projectId}:${message.providerId || 'codex'}`;
        if(message.action==='read')result={messages:structuredClone(historyStorage.get(key)??[])};
        else if(message.action==='write' && Array.isArray(message.messages)){historyStorage.set(key,structuredClone(message.messages));result={ok:true};}
        else result={ok:false};
      }
      if(message.type==='opt:codex-queue'){
        const key=`${message.accountId}:${message.projectId}`, current=queueStorage.get(key)??{revision:'',items:[]};
        if(message.action==='read')result={ok:true,...structuredClone(current)};
        else if(message.action==='write' && message.expectedRevision===current.revision && Array.isArray(message.items)){
          const next={revision:crypto.randomUUID(),items:structuredClone(message.items)};queueStorage.set(key,next);result={ok:true,revision:next.revision};
        }else result={ok:false,message:'人工测试：队列已在另一窗口更改，请检查后重新加载。'};
      }
      if(message.type==='opt:open-api-settings'){window.open('/dev/api-settings.html','_blank','noopener');result={ok:true};}
      if(callback)queueMicrotask(()=>callback(result));
      return Promise.resolve(result);
    },
  },
} });

// Match native rail toggling: opening the extension can close the native panel
// through its existing button, and returning to Files/AI closes the extension.
const nativeRailPanel=document.getElementById('fixture-native-rail-panel')!;
for(const [buttonId,panelId,label] of [
  ['ide-rail-tabs-tab-file-tree','fixture-files-panel','Project files'],
  ['ide-rail-tabs-tab-workbench','fixture-ai-panel','AI assistant'],
]){
  const button=document.getElementById(buttonId)!;
  button.onclick=()=>{
    const wasOpen=button.classList.contains('open-rail');
    for(const id of ['ide-rail-tabs-tab-file-tree','ide-rail-tabs-tab-workbench']){
      const item=document.getElementById(id)!;item.classList.remove('open-rail');item.setAttribute('aria-selected','false');
    }
    nativeRailPanel.hidden=wasOpen;
    if(!wasOpen){
      button.classList.add('open-rail');button.setAttribute('aria-selected','true');
      nativeRailPanel.setAttribute('aria-label',label);nativeRailPanel.setAttribute('aria-labelledby',buttonId);
      for(const id of ['fixture-files-panel','fixture-ai-panel'])document.getElementById(id)!.hidden=id!==panelId;
    }
  };
}

const visualFixture = createVisualPreviewFixture(fixtureParams.get('visual-preview') === '1');
const syntaxTree = visualFixture.syntaxTree;

// Mimics the existing native tooltip lifecycle. The extension may replace the
// equation body, but the native menu and popup trigger remain owned by this host.
let popup: HTMLElement | null = null;
window.addEventListener('opt:editor', ((event: CustomEvent<string>) => {
  const message = JSON.parse(event.detail);
  if (message.type === 'ready') document.getElementById('fixture-state')!.textContent = 'Real CodeMirror editor connected.';
  if (message.type !== 'formula') return;
  if(!nativePreview)return;
  if (!message.formula) {
    popup?.remove(); popup = null;
    if(previewRace)raceGeneration++;
    return;
  }
  if(previewRace){popup?.remove();popup=null;}
  if (!popup) {
    popup = document.createElement('div'); popup.className = 'ol-cm-math-tooltip-container';
    popup.innerHTML = '<div class="ol-cm-math-tooltip" id="ol-cm-math-tooltip"><div class="native-formula">Native equation preview</div><div class="dropdown"><button aria-label="Preview options">⋮</button></div></div>';
    document.body.append(popup);
  }
  popup.querySelector('.native-formula')!.textContent = message.formula.tex;
  if(previewRace)simulateNativePreview(popup,message.formula.tex);
}) as EventListener);

await import('/dist/editor-bridge.js');
await import('/dev/content.js');
document.getElementById('fixture-codex-long')!.onclick=()=>{
  const panel=document.getElementById('opt-codex-panel');
  if(panel?.hidden)document.getElementById('opt-codex-tab')?.click();
  const input=document.querySelector<HTMLTextAreaElement>('#opt-codex-panel textarea');
  if(!input)return;
  input.value='[LONG-QA] 人工测试：生成长篇模拟回答，检查公式与滚动。';input.dispatchEvent(new Event('input',{bubbles:true}));
  input.closest('form')?.requestSubmit();
};
if(new URLSearchParams(location.search).get('context-regression')==='1'){
  const controls=document.createElement('div');
  const button=document.createElement('button');button.textContent='Simulate extension reload';
  const status=document.createElement('p');status.id='fixture-context-status';status.setAttribute('role','status');
  let errors=0;
  window.addEventListener('error',()=>errors++);
  window.addEventListener('unhandledrejection',()=>errors++);
  button.onclick=()=>{
    // Only the synthetic runtime above is changed. No real extension is reloaded.
    Object.defineProperty(chrome.runtime,'id',{value:undefined,configurable:true});
    Object.defineProperty(chrome.runtime,'getURL',{value:()=>{throw new Error('Extension context invalidated.');},configurable:true});
    status.textContent='Simulated reload';
    requestAnimationFrame(()=>{
      status.textContent=`Context retired; extension tabs: ${document.querySelectorAll('#opt-settings-tab').length}; preview popups: ${document.querySelectorAll('.opt-formula-popup').length}; native preview hidden: ${document.documentElement.hasAttribute('data-opt-preview-enabled')}; uncaught errors: ${errors}.`;
    });
  };
  controls.append(button,status);document.getElementById('fixture-state')!.after(controls);
}
function collectThirdPartyExtensions() {
  const extensions: Extension[] = [];
  window.dispatchEvent(new CustomEvent('UNSTABLE_editor:extensions', { detail: { CodeMirror: { EditorView, EditorSelection, Prec, StateEffect, StateField, ViewPlugin, keymap, syntaxTree }, extensions } }));
  return extensions;
}
const extensions=collectThirdPartyExtensions();
const reconnectFixture=fixtureParams.get('preview-reconnect')==='1';
const thirdPartyExtensions=new Compartment();
let currentPath = 'main.tex';
const documents = new Map(Object.entries(sources) as [string, string][]);
const editorHost = document.getElementById('editor')!;
const cachedViews = new Map<string, EditorView>();
let cachedReuses = 0, createdViews = 0;
let updateQuoteReturnStatus = () => {};
function createFixtureView(path: string) {
  const created = new EditorView({ parent: editorHost, state: EditorState.create({ doc: documents.get(path), extensions: [lineNumbers(), history(), autocompletion(), keymap.of([{ key: 'Tab', run: acceptCompletion }, ...defaultKeymap, ...historyKeymap]), ...visualFixture.extensions, ...(reconnectFixture ? [thirdPartyExtensions.of(extensions)] : extensions),
    ...(cachedEditors ? [EditorView.updateListener.of(update => {
      if (update.docChanged) update.view.dom.dataset.fixtureDocChanges = String(Number(update.view.dom.dataset.fixtureDocChanges || 0) + 1);
      if (update.view === view) updateQuoteReturnStatus();
    })] : []),
  ] }) });
  if (cachedEditors) {
    created.dom.dataset.fixtureEditorPath = path;
    created.dom.dataset.fixtureViewId = String(++createdViews);
    created.dom.dataset.fixtureDocChanges = '0';
  }
  return created;
}
let view = createFixtureView(currentPath);
if (cachedEditors) cachedViews.set(currentPath, view);
if(reconnectFixture){
  const controls=document.createElement('div');controls.id='fixture-reconnect-controls';
  const status=document.createElement('p');status.id='fixture-reconnect-status';status.setAttribute('role','status');
  let snapshot: {doc: string; selection: string; undo: number; redo: number}|undefined, reconnects=0;
  const capture=()=>({doc:view.state.doc.toString(),selection:JSON.stringify(view.state.selection.toJSON()),undo:undoDepth(view.state),redo:redoDepth(view.state)});
  const update=()=>{status.dataset.reconnects=String(reconnects);status.dataset.preserved=String(!snapshot||JSON.stringify(capture())===JSON.stringify(snapshot));status.textContent=`Editor reconnects: ${reconnects}; document, selection and undo preserved: ${status.dataset.preserved}.`;};
  const disconnect=document.createElement('button');disconnect.type='button';disconnect.textContent='Select formula and disconnect editor';
  const focusEditor=document.createElement('button');focusEditor.type='button';focusEditor.textContent='Return to editor without editing';focusEditor.onclick=()=>view.focus();
  disconnect.onclick=()=>{
    const pos=view.state.doc.toString().indexOf('$');
    if(pos>=0)view.dispatch({selection:{anchor:pos+2}});
    snapshot=capture();
    view.dispatch({effects:thirdPartyExtensions.reconfigure([])});
    update();
  };
  window.addEventListener('editor:extension-loaded',()=>{
    const fresh=collectThirdPartyExtensions();
    for(const current of new Set([view,...cachedViews.values()]))current.dispatch({effects:thirdPartyExtensions.reconfigure(fresh)});
    reconnects++;update();
  });
  controls.append(disconnect,focusEditor,status);document.getElementById('fixture-state')!.after(controls);update();
}
// Fixture controls always operate on the active real view. The cached views
// themselves, their states and their bridge plugins are never replaced.
visualFixture.mount(cachedEditors ? new Proxy(view, { get(_initial, key) { const value = Reflect.get(view, key, view); return typeof value === 'function' ? value.bind(view) : value; } }) : view);
if(fixtureParams.get('quote-return')==='1'){
  const status=document.createElement('p');status.id='fixture-quote-return-status';status.setAttribute('role','status');
  const update=()=>{status.dataset.path=currentPath;status.dataset.selected=view.state.sliceDoc(view.state.selection.main.from,view.state.selection.main.to);status.dataset.unchanged=String(view.state.doc.toString()===sources[currentPath as keyof typeof sources]);status.textContent=`Source navigation · ${currentPath}; selected: ${status.dataset.selected||'(none)'}; unchanged: ${status.dataset.unchanged}.`;
    if(cachedEditors){status.dataset.activeView=view.dom.dataset.fixtureViewId;status.dataset.cachedViews=String(cachedViews.size);status.dataset.cachedReuses=String(cachedReuses);status.dataset.docChanges=view.dom.dataset.fixtureDocChanges;status.textContent+=` Cached editor ${status.dataset.activeView}; mounted views ${cachedViews.size}; reuses ${cachedReuses}; document changes ${status.dataset.docChanges}.`;}
  };
  const select=document.createElement('button');select.type='button';select.textContent='Select source passage';select.onclick=()=>{const source=view.state.doc.toString(),text='Unclicked custom formula: $\\cN=(1,0)$.',from=source.indexOf(text);if(from<0)return;view.dispatch({selection:{anchor:from,head:from+text.length}});view.focus();};
  const selectAnswer=document.createElement('button');selectAnswer.type='button';selectAnswer.textContent='Select answer passage';selectAnswer.onclick=()=>{const body=[...document.querySelectorAll<HTMLElement>('.opt-codex-message[data-role="assistant"] .opt-codex-message-body')].find(element=>element.textContent?.includes('The original quoted answer explains')) || document.querySelector('.opt-codex-message[data-role="assistant"] .opt-codex-message-body');if(!body)return;const range=document.createRange();range.selectNodeContents(body);const selection=document.getSelection();selection?.removeAllRanges();selection?.addRange(range);};
  document.getElementById('fixture-state')!.after(select,selectAnswer,status);
  updateQuoteReturnStatus=update;
  if(!cachedEditors)view.dispatch({effects:StateEffect.appendConfig.of(EditorView.updateListener.of(update))});update();
}
if(previewRace){
  const controls=document.createElement('div');controls.id='fixture-preview-race';
  raceStatus=document.createElement('p');raceStatus.id='fixture-preview-race-status';raceStatus.setAttribute('role','status');
  raceStatus.textContent='Ready: verify exclusive extension preview ownership.';
  for(const [label,formula] of [['Check preview ownership','\\ensuremath'],['Check unknown command','\\fixtureNativeOnly'],['Check another unknown command','\\fixtureBothFail']]){
    const button=document.createElement('button');button.type='button';button.textContent=label;
    button.onclick=()=>{const position=view.state.doc.toString().indexOf(formula);if(position<0)return;view.dispatch({selection:{anchor:0}});view.focus();view.dispatch({selection:{anchor:position+2}});};
    controls.append(button);
  }
  controls.append(raceStatus);document.getElementById('fixture-state')!.after(controls);
}
if(new URLSearchParams(location.search).get('typing-regression')==='1'){
  const controls=document.createElement('div');
  const run=document.createElement('button');run.textContent='Run typing regression';run.type='button';
  const status=document.createElement('p');status.id='fixture-typing-status';status.setAttribute('role','status');status.textContent='Ready for typing, partial errors, and independent preview checks.';
  controls.append(run,status);document.getElementById('fixture-state')!.after(controls);
  let generation=0;
  run.onclick=()=>{
    const pass=++generation;
    const text=view.state.doc.toString();const start=text.indexOf('$');const end=text.indexOf('$',start+1);
    if(start<0||end<0)return;
    const initial='x^2 + \\bR + \\frac{1}{2}';
    view.dispatch({changes:{from:start+1,to:end,insert:initial},selection:{anchor:start+1+9},userEvent:'input.type'});view.focus();
    const suffix='sdfsdfsdfsdfsdf';let typed=0,frames=0,loadingFrames=0,nativeFrames=0,redFrames=0;
    const type=()=>{
      if(pass!==generation||typed>=suffix.length)return;
      const pos=start+1+9+typed;
      view.dispatch({changes:{from:pos,insert:suffix[typed++]},selection:{anchor:pos+1},userEvent:'input.type'});
      setTimeout(type,40);
    };
    setTimeout(type,80);
    const sample=()=>{
      if(pass!==generation||frames++>=100)return;
      const own=document.querySelector<HTMLElement>('.opt-formula-popup');
      if(own&&!own.hidden){
        if(/rendering preview|正在生成|undefined control/i.test(own.textContent||''))loadingFrames++;
        if(own.querySelector('[fill="#c62828"],[mathcolor="#c62828"]'))redFrames++;
      }
      for(const native of document.querySelectorAll<HTMLElement>('.ol-cm-math-tooltip-container'))if(native.getBoundingClientRect().width>0&&getComputedStyle(native).display!=='none')nativeFrames++;
      status.dataset.frames=String(frames);status.dataset.loadingFrames=String(loadingFrames);status.dataset.nativeFrames=String(nativeFrames);status.dataset.redFrames=String(redFrames);
      status.textContent=`Typed ${typed}/${suffix.length}; frames ${frames}/100; status-text frames ${loadingFrames}; native frames ${nativeFrames}; red-command frames ${redFrames}.`;
      requestAnimationFrame(sample);
    };requestAnimationFrame(sample);
  };
}
const cachedTabs = cachedEditors ? document.createElement('div') : undefined;
if(cachedTabs){cachedTabs.id='fixture-cached-editor-tabs';cachedTabs.setAttribute('role','tablist');cachedTabs.setAttribute('aria-label','Cached source editors');editorHost.before(cachedTabs);}
function activateFixtureDocument(path: string) {
  documents.set(currentPath, view.state.doc.toString()); currentPath = path;
  document.querySelectorAll<HTMLElement>('#file-tree [role=treeitem]').forEach(item => item.setAttribute('aria-selected', String(item.textContent === path)));
  cachedTabs?.querySelectorAll<HTMLElement>('[role=tab]').forEach(tab => tab.setAttribute('aria-selected', String(tab.dataset.fixturePath === path)));
  document.getElementById('current-file')!.textContent = path;
  if(cachedEditors){
    const existing=cachedViews.get(path);
    if(existing!==view){
      view.dom.hidden=true;view.dom.setAttribute('aria-hidden','true');view.dom.style.display='none';
      view=existing || createFixtureView(path);cachedViews.set(path,view);
      view.dom.hidden=false;view.dom.removeAttribute('aria-hidden');view.dom.style.removeProperty('display');
      if(existing)cachedReuses++;
    }
    // No dispatch/setState: cached editor reactivation is deliberately only a
    // native tab/visibility/focus change, reproducing Overleaf's cached views.
  }else view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: documents.get(path)! }, selection: { anchor: 0 } });
  view.focus();updateQuoteReturnStatus();
}
for (const path of documents.keys()) {
  const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'treeitem'); button.setAttribute('aria-label', path.split('/').at(-1)!); button.setAttribute('aria-selected', String(path === currentPath)); button.textContent = path;
  button.onclick = () => activateFixtureDocument(path);
  document.getElementById('file-tree')!.append(button);
  if(cachedTabs){
    const tab=document.createElement('button');tab.type='button';tab.className='editor-file-tab btn';tab.setAttribute('role','tab');tab.setAttribute('aria-selected',String(path===currentPath));tab.dataset.fixturePath=path;
    const label=document.createElement('span');label.className='editor-file-tab-path';label.textContent=path;tab.append(label);tab.onclick=()=>activateFixtureDocument(path);cachedTabs.append(tab);
  }
}

let nativeRootPath = 'main.tex';
let nativeAutocomplete = true;
let nativeFontSize = '12px';
const nativeIcon = (path: string) => `<svg class="ide-settings-tab-link-icon" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="${path}"/></svg>`;
document.getElementById('settings-open')!.onclick = () => {
  const host = document.getElementById('dialog-host')!;
  host.innerHTML = `<div class="backdrop"><div role="dialog" aria-label="Settings" class="modal">
    <div class="modal-header"><span>Settings</span><button id="settings-close" aria-label="Close settings">×</button></div>
    <div class="ide-settings-modal-body">
      <nav class="ide-settings-tab-nav" role="tablist">
        <button type="button" class="ide-settings-tab-link ide-settings-tab-link-button nav-link active" role="tab" id="native-editor-tab" aria-controls="native-editor-panel" aria-selected="true" tabindex="0">${nativeIcon('M3 14v3h3L17 6l-3-3L3 14Z M12 5l3 3')}<span>Editor</span></button>
        <button type="button" class="ide-settings-tab-link ide-settings-tab-link-button nav-link" role="tab" id="native-project-tab" aria-controls="native-project-panel" aria-selected="false" tabindex="-1">${nativeIcon('M4 2h8l4 4v12H4V2Z M12 2v4h4 M7 10h6 M7 13h6')}<span>Project</span></button>
        <a class="ide-settings-tab-link nav-link" href="https://docs.overleaf.com" target="_blank" rel="noopener noreferrer">${nativeIcon('M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Z M7.5 7a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4 M10 14v1')}<span>Help</span></a>
      </nav>
      <div class="ide-settings-tab-content">
        <div id="native-editor-panel" class="tab-pane active" role="tabpanel" aria-labelledby="native-editor-tab">
          <div class="ide-settings-section">
            <div class="ide-settings-section-title">Editor</div>
            <div class="ide-setting"><div><label class="ide-setting-title" for="native-auto-complete">Auto-complete</label><div class="ide-setting-description">Show command suggestions while typing.</div></div><div class="ide-setting-input"><div class="form-switch"><input class="form-check-input" type="checkbox" role="switch" id="native-auto-complete"></div></div></div>
            <div class="ide-setting"><div><label class="ide-setting-title" for="native-font-size">Font Size</label><div class="ide-setting-description">Choose the text size in the source editor.</div></div><div class="ide-setting-input"><select class="ide-dropdown-setting form-select form-select-sm" id="native-font-size"><option>10px</option><option>12px</option><option>14px</option><option>16px</option></select></div></div>
          </div>
        </div>
        <div id="native-project-panel" class="tab-pane" role="tabpanel" aria-labelledby="native-project-tab" hidden>
          <div class="ide-settings-section">
            <div class="ide-settings-section-title">Project</div>
            <div class="ide-setting"><div><label class="ide-setting-title" for="rootDocId">Main document</label><div class="ide-setting-description">The document compiled when you recompile the project.</div></div><div class="ide-setting-input"><select class="ide-dropdown-setting form-select form-select-sm" id="rootDocId"></select></div></div>
          </div>
        </div>
      </div>
    </div>
  </div></div>`;
  const autocomplete = document.getElementById('native-auto-complete') as HTMLInputElement;
  autocomplete.checked = nativeAutocomplete;
  autocomplete.onchange = () => { nativeAutocomplete = autocomplete.checked; };
  const fontSize = document.getElementById('native-font-size') as HTMLSelectElement;
  fontSize.value = nativeFontSize;
  fontSize.onchange = () => { nativeFontSize = fontSize.value; };
  const rootSelect = document.getElementById('rootDocId') as HTMLSelectElement;
  [...documents.keys()].filter(path => /\.(?:tex|ltx)$/i.test(path)).forEach((path, index) => {
    // The visible label is the full path; the native select value is a file ID.
    rootSelect.add(new Option(path, (index + 1).toString(16).padStart(24, '0'), false, path === nativeRootPath));
  });
  rootSelect.onchange = () => { nativeRootPath = rootSelect.selectedOptions[0].textContent!; };
  document.getElementById('settings-close')!.onclick = () => { host.replaceChildren(); };
  for (const name of ['editor', 'project']) document.getElementById('native-' + name + '-tab')!.onclick = () => {
    for (const other of ['editor', 'project']) {
      const tab = document.getElementById('native-' + other + '-tab')!;
      tab.setAttribute('aria-selected', String(name === other)); tab.tabIndex = name === other ? 0 : -1;
      tab.classList.toggle('active', name === other);
      const panel = document.getElementById('native-' + other + '-panel')!;
      panel.hidden = name !== other; panel.classList.toggle('active', name === other);
    }
  };
};
