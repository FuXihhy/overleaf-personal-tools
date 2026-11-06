/** A deliberately small, data-only subset of snippet syntax. No evaluation. */
export function expandSnippet(template: string): { text: string; ranges: { from: number; to: number }[] } {
  let text = '';
  const positions: { order: number; from: number; to: number }[] = [];
  for(let i=0;i<template.length;) {
    const match=/^\$\{(\d+)(:|\})/.exec(template.slice(i));
    if(!match){text+=template[i++];continue;}
    let cursor=i+match[0].length;
    let value='';
    let closed=match[2]==='}';
    if(!closed) {
      while(cursor<template.length) {
        const character=template[cursor++];
        if(character==='}') {closed=true;break;}
        if(character==='\\' && /[\\{}$]/.test(template[cursor]||''))value+=template[cursor++];
        else value+=character;
      }
    }
    if(!closed){text+=template[i++];continue;}
    const from=text.length;text+=value;
    positions.push({order:Number(match[1])||9999,from,to:text.length});
    i=cursor;
  }
  return { text, ranges: positions.sort((a,b) => a.order-b.order).map(({from,to}) => ({from,to})) };
}
