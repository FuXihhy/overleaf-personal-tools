import {describe,it,expect} from 'vitest';
import {mergeConversationHistory} from '../src/codex/history-state';
import type {CodexMessage} from '../src/codex/types';
const message=(text:string):CodexMessage=>({role:'user',text});
describe('native history reconciliation',()=>{
  it('does not merge otherwise identical messages whose quoted answers differ',()=>{
    const first={...message('Why?'),answerQuote:{text:'First answer'}};
    const second={...message('Why?'),answerQuote:{text:'Second answer'}};
    expect(mergeConversationHistory('same',[message('Old'),first],'earlier',{id:'read',type:'history',conversationId:'same',messages:[second]}).messages).toEqual([second]);
    expect(mergeConversationHistory('same',[message('Old'),first],'earlier',{id:'read',type:'history',conversationId:'same',messages:[{...first,messageId:'native-1'}]}).messages).toEqual([message('Old'),{...first,messageId:'native-1'}]);
  });

  it('preserves older loaded pages while adding another window’s new messages',()=>{
    const result=mergeConversationHistory('same',['old','question','answer'].map(message),'earlier',{id:'read',type:'history',conversationId:'same',messages:['question','answer','new'].map(message),nextCursor:'recent'});
    expect(result).toEqual({id:'same',messages:['old','question','answer','new'].map(message),cursor:'earlier'});
  });
  it('never blends a different active chat or a nonmatching tail',()=>{
    const page={id:'read',type:'history' as const,conversationId:'different',messages:[message('new')],nextCursor:'older'};
    expect(mergeConversationHistory('old',[message('private')],undefined,page)).toEqual({id:'different',messages:page.messages,cursor:'older'});
    expect(mergeConversationHistory('different',[message('unmatched')],undefined,page).messages).toEqual(page.messages);
    expect(mergeConversationHistory('different',[message('old')],undefined,{id:'empty',type:'history',messages:[]})).toEqual({id:undefined,messages:[],cursor:undefined});
  });
  it('updates a partial answer by stable identity without losing earlier pages or the older-page cursor',()=>{
    const old={...message('Old page'),messageId:'m1'},question={...message('Question'),messageId:'m2'};
    const partial:CodexMessage={role:'assistant',text:'Partial',messageId:'m3'};
    const final={...partial,text:'Final complete answer'};
    expect(mergeConversationHistory('same',[old,question,partial],'before-old',{id:'read',type:'history',conversationId:'same',messages:[question,final],nextCursor:'before-question'}))
      .toEqual({id:'same',messages:[old,question,final],cursor:'before-old'});
  });
  it('adopts the fresh page cursor when its first message is the first loaded message',()=>{
    const question={...message('Question'),messageId:'m2'};
    const answer:CodexMessage={role:'assistant',text:'Answer',messageId:'m3'};
    expect(mergeConversationHistory('same',[question],'outdated',{id:'read',type:'history',conversationId:'same',messages:[question,answer],nextCursor:'earlier'}))
      .toEqual({id:'same',messages:[question,answer],cursor:'earlier'});
  });
  it('keeps exact selected text and its stable identity when a cached message gains native IDs',()=>{
    const selection={path:'main.tex',text:'x',from:0,to:1,startLine:1,endLine:1,before:'',after:''};
    const quote={...message('Why?'),selection};
    const native={...quote,messageId:'m2'};
    expect(mergeConversationHistory('same',[message('Old'),quote],'earlier',{id:'read',type:'history',conversationId:'same',messages:[native]}))
      .toEqual({id:'same',messages:[message('Old'),native],cursor:'earlier'});
  });
});
