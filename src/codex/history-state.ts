import type { CodexEvent, CodexMessage } from './types';

/** Join a fresh tail with already loaded older pages. A different active chat
 * or an unmatched tail must replace the display rather than mix conversations. */
export function mergeConversationHistory(currentId: string | undefined, messages: CodexMessage[], cursor: string | undefined, page: CodexEvent) {
  const id=page.conversationId ?? page.activeConversationId;
  const tail=page.messages ?? [];
  if(id && currentId===id && tail.length){
    // Stable IDs allow the desktop's partial answer to become its final answer
    // without duplicating it or losing previously loaded pages.
    if(tail[0].messageId){
      const start=messages.findIndex(message=>message.messageId===tail[0].messageId);
      if(start>=0)return {id,messages:[...messages.slice(0,start),...tail],cursor:start>0?cursor:page.nextCursor};
    }
    const key=(message:CodexMessage)=>JSON.stringify({role:message.role,text:message.text,...(message.selection?{selection:message.selection}:{}),...(message.answerQuote?{answerQuote:message.answerQuote}:{})});
    const keys=messages.map(key), next=tail.map(key);
    for(let overlap=Math.min(keys.length,next.length);overlap>0;overlap--){
      if(next.slice(0,overlap).every((key,index)=>key===keys[keys.length-overlap+index])){
        return {id,messages:[...messages.slice(0,messages.length-overlap),...tail],cursor};
      }
    }
  }
  return {id,messages:tail,cursor:page.nextCursor};
}
