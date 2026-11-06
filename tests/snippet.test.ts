import { describe, it, expect } from 'vitest';
import { expandSnippet } from '../src/overleaf/snippet';
import { parseTex, macroToCommand } from '../src/core/parser';

describe('snippet insertion',()=>{
  it('decodes escaped TeX defaults without confusing inner braces with snippet terminators',()=>{
    const parsed=parseTex(String.raw`\newcommand{\spaceof}[2][\mathbb{R}]{#1^{#2}}`);
    const event=parsed.events.find(e=>e.type==='macro');
    if(event?.type!=='macro')throw new Error('missing macro');
    const result=expandSnippet(macroToCommand(event.macro).snippet!);
    expect(result.text).toBe(String.raw`\spaceof[\mathbb{R}]{arg}`);
    expect(result.ranges.map(r=>result.text.slice(r.from,r.to))).toEqual([String.raw`\mathbb{R}`,'arg']);
  });
  it('keeps normal command backslashes and unrecognized placeholders unchanged',()=>{
    expect(expandSnippet(String.raw`\pdv{${'${1:f}'}}{${'${2:x}'}}`).text).toBe(String.raw`\pdv{f}{x}`);
    expect(expandSnippet('\\foo${not-a-placeholder}').text).toBe('\\foo${not-a-placeholder}');
  });
});
