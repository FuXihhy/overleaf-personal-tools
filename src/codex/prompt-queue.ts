import { validCodexRequest, record, CODEX_SOURCE_MAX_FILES, CODEX_SOURCE_MAX_TOTAL_BYTES } from './types';
import type { CodexAnswerQuote, CodexSelection, CodexSettings } from './types';

export interface CapturedPrompt {
  question: string;
  selection?: CodexSelection;
  answerQuote?: CodexAnswerQuote;
  settings: CodexSettings;
  files: Array<{path: string; content: string}>;
  note: string;
  snapshotId?: string;
  sourceFileCount?: number;
  sourceTotalBytes?: number;
  providerId?: string;
  conversationId?: string;
}
export interface QueuedPrompt { id: string; prompt: CapturedPrompt; state: 'queued' | 'sending' | 'failed'; error?: string }
/** This page owns unsent prompts. A failed/uncertain submission is never retried.
 * Each item holds its original context, independent from subsequent edits. */
const bytes=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).byteLength;
const MAX_BYTES=1_048_576;
export class PromptQueue {
  private entries: QueuedPrompt[] = [];
  paused = false;
  get items(): readonly QueuedPrompt[] { return this.entries; }
  get length() { return this.entries.length; }
  add(prompt: CapturedPrompt) {
    const item: QueuedPrompt = {id: crypto.randomUUID(), prompt: structuredClone(prompt), state: 'queued'};
    if (this.entries.length >= 8 || bytes([...this.entries,item]) > MAX_BYTES) throw new Error('The message queue is full. Send or remove queued messages first.');
    this.entries.push(item); return item.id;
  }
  bindConversation(providerId: string | undefined, conversationId: string) {
    for (const item of this.entries) if (item.prompt.providerId === providerId && !item.prompt.conversationId) item.prompt.conversationId = conversationId;
  }
  begin(providerId: string | undefined, conversationId: string | undefined) {
    const item = this.entries[0];
    if (this.paused || !item || item.state !== 'queued') return;
    return this.beginItem(item.id, providerId, conversationId);
  }
  /** Explicit promotion may select a later item, but never resend an uncertain one. */
  beginItem(id: string, providerId: string | undefined, conversationId: string | undefined) {
    const item = this.entries.find(entry => entry.id === id);
    if (!item || item.state !== 'queued' || this.entries.some(entry => entry.state === 'sending')) return;
    if (item.prompt.providerId !== providerId || item.prompt.conversationId !== conversationId) {
      this.paused = true;
      throw new Error('The queued message belongs to another conversation. Review or remove it before continuing.');
    }
    item.state = 'sending'; return item;
  }
  release(id: string) {
    const item = this.entries.find(entry => entry.id === id);
    if (item?.state === 'sending') item.state = 'queued';
  }
  finish(id: string, error?: string) {
    const item = this.entries.find(entry => entry.id === id); if (!item) return;
    if (error) { item.state = 'failed'; item.error = error; this.paused = true; }
    else this.entries = this.entries.filter(entry => entry.id !== id);
  }
  remove(id: string): CapturedPrompt | undefined {
    const item = this.entries.find(entry => entry.id === id); if (!item || item.state === 'sending') return;
    this.entries = this.entries.filter(entry => entry.id !== id); return structuredClone(item.prompt);
  }
  snapshot() { return structuredClone(this.entries); }
  restore(value:unknown) {
    if(!Array.isArray(value) || value.length>8 || bytes(value)>MAX_BYTES)return;
    const entries:QueuedPrompt[]=[];const seen=new Set<string>();
    for(const raw of value){
      const item=record(raw),p=record(item?.prompt);if(!item || Object.keys(item).some(key=>!['id','prompt','state','error'].includes(key)) || item.error!==undefined && (typeof item.error!=='string' || item.error.length>1500) || !p || typeof item.id!=='string' || !/^[\w-]{1,100}$/.test(item.id) || seen.has(item.id))return;
      if(Object.keys(p).some(key=>!['question','selection','answerQuote','settings','files','note','providerId','conversationId','snapshotId','sourceFileCount','sourceTotalBytes'].includes(key)) || typeof p.note!=='string' || p.note.length>2000)return;
      if(p.conversationId!==undefined && (typeof p.conversationId!=='string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(p.conversationId)))return;
      if(!validCodexRequest({version:1,id:item.id,op:'ask',projectId:'000000000000000000000000',question:p.question,selection:p.selection,answerQuote:p.answerQuote,settings:p.settings,files:p.files,providerId:p.providerId,snapshotId:p.snapshotId}))return;
      for(const [key,max] of [['sourceFileCount',CODEX_SOURCE_MAX_FILES],['sourceTotalBytes',CODEX_SOURCE_MAX_TOTAL_BYTES]] as const)if(p[key]!==undefined && (!p.snapshotId || !Number.isSafeInteger(p[key]) || Number(p[key])<0 || Number(p[key])>max))return;
      if(!p.settings || !Array.isArray(p.files) || !['queued','sending','failed'].includes(String(item.state)))return;
      if((p.settings as CodexSettings).providerId!==p.providerId)return;
      const failed=item.state!=='queued';seen.add(item.id);
      entries.push({id:item.id,prompt:structuredClone(p) as unknown as CapturedPrompt,state:failed?'failed':'queued',...(failed?{error:'A previous submission may have been accepted. Check the conversation before sending again.'}:{})});
    }
    this.entries=entries;this.paused=entries.length>0;
  }
  pause() { this.paused = true; }
  resume() { if (this.entries.some(entry => entry.state === 'failed')) return false; this.paused = false; return true; }
}
