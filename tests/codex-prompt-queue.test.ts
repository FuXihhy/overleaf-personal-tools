import {describe,it,expect} from 'vitest';
import {PromptQueue,type CapturedPrompt} from '../src/codex/prompt-queue';
import {DEFAULT_CODEX_SETTINGS} from '../src/codex/types';
const conversation='11111111-2222-3333-4444-555555555555';
const provider='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const prompt=(question='First'):CapturedPrompt=>({question,files:[{path:'main.tex',content:'original source'}],settings:{...DEFAULT_CODEX_SETTINGS},note:'',conversationId:conversation});
describe('bounded captured prompt queue',()=>{
 it('stores immutable full-project references without putting source text in browser queue storage',()=>{
  const snapshotId='ab'.repeat(32),queue=new PromptQueue();
  const source:CapturedPrompt={...prompt(),files:[],snapshotId,sourceFileCount:2000,sourceTotalBytes:16*1024*1024};
  const id=queue.add(source);source.snapshotId='cd'.repeat(32);
  expect(queue.items[0].prompt.snapshotId).toBe(snapshotId);expect(JSON.stringify(queue.snapshot()).length).toBeLessThan(2000);
  const restored=new PromptQueue();restored.restore(queue.snapshot());expect(restored.length).toBe(1);expect(restored.remove(id)?.snapshotId).toBe(snapshotId);
  const invalid=queue.snapshot();invalid[0].prompt.snapshotId='../escape';const rejected=new PromptQueue();rejected.restore(invalid);expect(rejected.length).toBe(0);
 });
 it('promotes an explicit queued item without reordering others or duplicating an in-flight item',()=>{
  const queue=new PromptQueue();queue.add(prompt('First'));const second=queue.add(prompt('Second'));
  expect(queue.beginItem(second,undefined,conversation)?.prompt.question).toBe('Second');
  expect(queue.begin(undefined,conversation)).toBeUndefined();expect(queue.beginItem(second,undefined,conversation)).toBeUndefined();
  queue.release(second);expect(queue.items[1].state).toBe('queued');
  queue.beginItem(second,undefined,conversation);queue.finish(second);
  expect(queue.begin(undefined,conversation)?.prompt.question).toBe('First');
 });
 it('freezes context and sends FIFO without replacing or editing the active entry',()=>{
  const queue=new PromptQueue(),p=prompt();const first=queue.add(p);queue.add(prompt('Second'));p.files[0].content='later edit';
  expect(queue.items[0].prompt.files[0].content).toBe('original source');expect(queue.begin(undefined,conversation)?.id).toBe(first);
  expect(queue.remove(first)).toBeUndefined();expect(queue.begin(undefined,conversation)).toBeUndefined();queue.finish(first);
  expect(queue.begin(undefined,conversation)?.prompt.question).toBe('Second');
 });
 it('pauses rather than moving queued material to another provider or conversation',()=>{
  const queue=new PromptQueue();queue.add(prompt());expect(()=>queue.begin(provider,conversation)).toThrow('another conversation');expect(queue.paused).toBe(true);
  expect(queue.items).toHaveLength(1);queue.resume();expect(()=>queue.begin(undefined,'different')).toThrow();
 });
 it('binds first-turn snapshots only for the matching source',()=>{
  const queue=new PromptQueue();queue.add({...prompt(),conversationId:undefined});queue.bindConversation(provider,conversation);expect(queue.items[0].prompt.conversationId).toBeUndefined();
  queue.bindConversation(undefined,conversation);expect(queue.begin(undefined,conversation)).toBeDefined();
 });
 it('never automatically retries an uncertain submission and restores sending entries as failed',()=>{
  const queue=new PromptQueue();const id=queue.add(prompt());queue.add(prompt('Second'));queue.begin(undefined,conversation);
  const restored=new PromptQueue();restored.restore(queue.snapshot());expect(restored.paused).toBe(true);expect(restored.items[0].state).toBe('failed');expect(restored.resume()).toBe(false);
  const edit=restored.remove(id)!;expect(edit.question).toBe('First');expect(restored.resume()).toBe(true);expect(restored.begin(undefined,conversation)?.prompt.question).toBe('Second');
 });
 it('restores queued items paused and rejects invalid stored payloads',()=>{
  const queue=new PromptQueue();queue.add(prompt());const restored=new PromptQueue();restored.restore(queue.snapshot());expect(restored.paused).toBe(true);expect(restored.begin(undefined,conversation)).toBeUndefined();
  const corrupt=queue.snapshot();corrupt[0].prompt.files[0].path='../secret';const rejected=new PromptQueue();rejected.restore(corrupt);expect(rejected.items).toHaveLength(0);
 });
 it('bounds UTF-8 bytes instead of characters and never clips context',()=>{
  const queue=new PromptQueue();const long={...prompt(),files:[{path:'main.tex',content:'中'.repeat(240000)}]};queue.add(long);
  expect(()=>queue.add(long)).toThrow('full');expect(queue.items[0].prompt.files[0].content).toBe(long.files[0].content);
 });
});
