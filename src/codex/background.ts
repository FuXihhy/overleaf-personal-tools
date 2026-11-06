import { CODEX_NATIVE_HOST, CODEX_PORT, parseCodexEvent, validCodexRequest, isCodexSelection, isCodexAnswerQuote, record, type CodexMessage } from './types';
import { PromptQueue } from './prompt-queue';
import { codexStorageKey } from './storage';
import type { ProjectCacheCoordinator } from './cache-lifecycle';

export function registerCodexTransport(runtime: typeof chrome.runtime, allowed: (sender: chrome.runtime.MessageSender, extensionId: string) => boolean): () => void {
  const connections = new Set<() => void>();
  const projectTurns = new Map<string, string>();
  const listener = (port: chrome.runtime.Port) => {
    if (port.name !== CODEX_PORT) return;
    if (!port.sender || !allowed(port.sender, runtime.id)) { port.disconnect(); return; }
    const projectId = new URL(port.sender.url!).pathname.split('/')[2];
    let native: chrome.runtime.Port | undefined;
    let ended = false;
    const pending = new Map<string, { op: string; timer: ReturnType<typeof setTimeout> }>();
    const send = (value: unknown) => { if (!ended) try { port.postMessage(value); } catch { stop(); } };
    const stop = () => {
      if (ended) return; ended = true; connections.delete(stop);
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        if (projectTurns.get(projectId) === id) projectTurns.delete(projectId);
      }
      pending.clear();
      try { native?.disconnect(); } catch { /* Already closed. */ }
      try { port.disconnect(); } catch { /* Already closed. */ }
    };
    connections.add(stop);
    port.onDisconnect.addListener(() => { void runtime.lastError; stop(); });
    port.onMessage.addListener(raw => {
      const data = record(raw);
      if (!validCodexRequest(raw) || raw.projectId !== projectId) {
        if (typeof data?.id === 'string' && /^[\w-]{1,100}$/.test(data.id)) send({ id: data.id, type: 'error', message: 'Invalid Codex request or project.' });
        return;
      }
      if (pending.has(raw.id)) return;
      if (['ask', 'new-chat', 'history-select'].includes(raw.op) && projectTurns.has(projectId)) {
        send({ id: raw.id, type: 'error', message: 'This project is already answering in another request. Stop it or wait before starting another conversation.' }); return;
      }
      if (pending.size >= 4 || raw.op === 'ask' && [...pending.values()].some(p => p.op === 'ask')) {
        send({ id: raw.id, type: 'error', message: 'A Codex request is already running.' }); return;
      }
      try {
        if (!native) {
          native = runtime.connectNative(CODEX_NATIVE_HOST);
          native.onMessage.addListener(rawEvent => {
            const event = parseCodexEvent(rawEvent); if (!event || !pending.has(event.id)) return;
            if (['done','steered','error','status','history','profiles','source'].includes(event.type)) {
              clearTimeout(pending.get(event.id)!.timer); pending.delete(event.id);
              if (projectTurns.get(projectId) === event.id) projectTurns.delete(projectId);
            }
            send(event);
          });
          native.onDisconnect.addListener(() => {
            const reason = runtime.lastError?.message || 'The local Codex helper disconnected.';
            for (const id of pending.keys()) send({ id, type: 'error', message: reason.slice(0, 1000) });
            stop();
          });
        }
        const timer = setTimeout(() => {
          if (raw.op.startsWith('source-')) {
            // A queued context upload must not terminate an unrelated active
            // answer on this shared connection. Late upload ACKs are ignored.
            pending.delete(raw.id); send({ id: raw.id, type: 'error', message: 'Project source synchronization timed out. The question was not sent.' });
          } else { send({ id: raw.id, type: 'error', message: 'Codex request timed out.' }); stop(); }
        }, raw.op === 'ask' ? 590_000 : 55_000);
        pending.set(raw.id, { op: raw.op, timer });
        if (['ask', 'new-chat', 'history-select'].includes(raw.op)) projectTurns.set(projectId, raw.id);
        native.postMessage(raw);
      } catch (error) {
        send({ id: raw.id, type: 'error', message: (error instanceof Error ? error.message : String(error)).slice(0, 1000) }); stop();
      }
    });
  };
  runtime.onConnect.addListener(listener);
  return () => { runtime.onConnect.removeListener(listener); for (const close of [...connections]) close(); };
}

function validMessages(value: unknown): value is CodexMessage[] {
  if (!Array.isArray(value) || value.length > 60) return false;
  let length = 0;
  return value.every(item => {
    const m = record(item);
    if (!m || !['user','assistant'].includes(String(m.role)) || typeof m.text !== 'string' || Object.keys(m).some(k => !['role','text','selection','answerQuote','messageId'].includes(k))) return false;
    if(m.messageId!==undefined && (typeof m.messageId!=='string' || !/^[\w.:-]{1,300}$/.test(m.messageId)))return false;
    if (m.selection !== undefined && (m.role !== 'user' || !isCodexSelection(m.selection))) return false;
    if (m.answerQuote !== undefined && (m.role !== 'user' || !isCodexAnswerQuote(m.answerQuote))) return false;
    length += m.text.length + (m.selection ? JSON.stringify(m.selection).length : 0) + (m.answerQuote ? JSON.stringify(m.answerQuote).length : 0); return length <= 400_000;
  });
}
export function registerCodexHistory(runtime: typeof chrome.runtime, session: chrome.storage.StorageArea, allowed: (sender: chrome.runtime.MessageSender, extensionId: string) => boolean, cache?: ProjectCacheCoordinator): void {
  const queueOperations=new Map<string,Promise<void>>();
  runtime.onMessage.addListener((raw, sender, respond) => {
    const data = record(raw);
    if(data?.type==='opt:codex-queue'){
      if(!allowed(sender,runtime.id) || data.projectId!==new URL(sender.url!).pathname.split('/')[2] || typeof data.accountId!=='string' || !/^[a-f\d]{24}$/i.test(data.accountId)
        || Object.keys(data).some(key=>!['type','projectId','accountId','action','items','expectedRevision'].includes(key)) || !['read','write'].includes(String(data.action))){respond({ok:false,message:'Invalid queue scope.'});return false;}
      const key=codexStorageKey(String(data.projectId),data.accountId)+':queue';
      if(data.action==='write'){
        const validated=new PromptQueue();validated.restore(data.items);
        if(!Array.isArray(data.items) || data.items.length>8 || validated.length!==data.items.length || typeof data.expectedRevision!=='string' || data.expectedRevision!=='' && !/^[\w-]{1,100}$/.test(data.expectedRevision)) {respond({ok:false,message:'Invalid queued messages.'});return false;}
      }
      const previous=queueOperations.get(key) ?? Promise.resolve();
      const operation=(async()=>{
        await previous;
        try{
          const saved=record((await session.get(key))[key]);
          const revision=typeof saved?.revision==='string'?saved.revision:'';
          if(data.action==='read'){
            const items=Array.isArray(saved?.items)?saved.items:[];
            if(cache)try{await cache.queueWrite({projectId:String(data.projectId),accountId:String(data.accountId)},items,items,async()=>{});}
            catch(error){respond({ok:true,revision,items,cacheError:error instanceof Error?error.message.slice(0,1000):'Source protection is unavailable.'});return;}
            respond({ok:true,revision,items});return;
          }
          if(data.expectedRevision!==revision){respond({ok:false,message:'Queued messages changed in another window. Reload to review the latest queue; nothing was sent.'});return;}
          const nextRevision=crypto.randomUUID();
          const persist=()=>session.set({[key]:{revision:nextRevision,items:data.items}});
          if(cache)await cache.queueWrite({projectId:String(data.projectId),accountId:String(data.accountId)},Array.isArray(saved?.items)?saved.items:[],data.items as unknown[],persist);
          else await persist();
          respond({ok:true,revision:nextRevision});
        }catch{respond({ok:false,message:'Queued messages could not be saved in browser storage.'});}
      })();
      queueOperations.set(key,operation);void operation.finally(()=>{if(queueOperations.get(key)===operation)queueOperations.delete(key);});return true;
    }
    if (data?.type !== 'opt:codex-history') return undefined;
    if (!allowed(sender, runtime.id) || data.projectId !== new URL(sender.url!).pathname.split('/')[2]
      || typeof data.accountId !== 'string' || !/^[a-f\d]{24}$/i.test(data.accountId)) { respond({ messages: [] }); return false; }
    if (data.providerId !== undefined && (typeof data.providerId !== 'string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(data.providerId))) { respond({messages:[]}); return false; }
    const key = codexStorageKey(String(data.projectId), data.accountId, data.providerId as string | undefined) + ':messages';
    if (data.action === 'read') {
      void session.get(key).then(result => respond({ messages: validMessages(result[key]) ? result[key] : [] }), () => respond({ messages: [] })); return true;
    }
    if (data.action === 'write' && validMessages(data.messages)) {
      void session.set({ [key]: data.messages }).then(() => respond({ ok: true }), () => respond({ ok: false })); return true;
    }
    respond({ ok: false }); return false;
  });
}
