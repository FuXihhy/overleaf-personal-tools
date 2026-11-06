// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createMathSelectionFeedback,createFormulaCopyToast,mathFeedbackStyles} from '../src/codex/selection-feedback';

let cleanup: (()=>void) | undefined;
beforeEach(()=>{document.body.innerHTML='';document.getSelection()?.removeAllRanges();});
afterEach(()=>{cleanup?.();cleanup=undefined;document.getSelection()?.removeAllRanges();vi.useRealTimers();vi.restoreAllMocks();});
function content(){
  const transcript=document.createElement('div');
  transcript.innerHTML='<p>Before <span class="opt-codex-math"><svg><path d="M0 0"/></svg></span> between <span class="opt-codex-math opt-codex-math-display"><svg><path d="M1 1"/></svg></span> after <span class="opt-codex-math">z</span>.</p>';
  document.body.append(transcript);
  return {transcript,p:transcript.firstChild!,formulas:[...transcript.querySelectorAll<HTMLElement>('.opt-codex-math')]};
}
function select(start:Node,from:number,end:Node,to:number){
  const range=document.createRange();range.setStart(start,from);range.setEnd(end,to);
  const selection=document.getSelection()!;selection.removeAllRanges();selection.addRange(range);return range;
}
describe('formula selection presentation',()=>{
  it('highlights each overlapping SVG formula while preserving the exact native selection',()=>{
    const {transcript,p,formulas}=content();const feedback=createMathSelectionFeedback(transcript);cleanup=feedback.destroy;
    const range=select(p.childNodes[0],2,p.childNodes[4],3),selection=document.getSelection()!;
    const originalText=selection.toString(),anchor=selection.anchorNode,focus=selection.focusNode;
    feedback.refresh();
    expect(formulas.map(f=>f.dataset.selected)).toEqual(['true','true',undefined]);
    expect(selection.getRangeAt(0)).toBe(range);expect(selection.toString()).toBe(originalText);
    expect(selection.anchorNode).toBe(anchor);expect(selection.focusNode).toBe(focus);
    expect(transcript.querySelectorAll('svg')).toHaveLength(2);
    expect(mathFeedbackStyles).toContain('background:Highlight; color:HighlightText');
  });
  it('supports backward selections and removes highlighting after collapse or leaving the answer',()=>{
    const {transcript,p,formulas}=content();const feedback=createMathSelectionFeedback(transcript);cleanup=feedback.destroy;
    const selection=document.getSelection()!;selection.setBaseAndExtent(p.childNodes[4],3,p.childNodes[0],2);
    feedback.refresh();expect(formulas[0].dataset.selected).toBe('true');expect(formulas[1].dataset.selected).toBe('true');
    expect(selection.anchorNode).toBe(p.childNodes[4]);
    selection.collapse(p.childNodes[4],2);feedback.refresh();expect(formulas.every(f=>!f.dataset.selected)).toBe(true);
    const outside=document.createTextNode('Elsewhere');document.body.append(outside);select(outside,0,outside,4);
    feedback.refresh();expect(formulas.every(f=>!f.dataset.selected)).toBe(true);
  });
  it('does not select a formula when the range only touches its boundary',()=>{
    const {transcript,p,formulas}=content();const feedback=createMathSelectionFeedback(transcript);cleanup=feedback.destroy;
    select(p.childNodes[0],0,p,1);feedback.refresh();expect(formulas[0].dataset.selected).toBeUndefined();
    select(p,2,p.childNodes[2],4);feedback.refresh();expect(formulas[0].dataset.selected).toBeUndefined();
    const path=formulas[0].querySelector('path')!;select(path.parentNode!,0,path.parentNode!,1);feedback.refresh();
    expect(formulas[0].dataset.selected).toBe('true');
  });
  it('refreshes for newly rendered math and cleans up when the panel is unavailable',async()=>{
    vi.useFakeTimers();const {transcript,p,formulas}=content();let enabled=true;
    const feedback=createMathSelectionFeedback(transcript,{enabled:()=>enabled});cleanup=feedback.destroy;
    const end=p.childNodes[4];select(p.childNodes[0],1,end,3);feedback.refresh();
    const added=document.createElement('span');added.className='opt-codex-math';added.innerHTML='<svg><path/></svg>';p.insertBefore(added,end);
    formulas[0].replaceChildren(document.createElementNS('http://www.w3.org/2000/svg','svg'));
    await Promise.resolve();await vi.advanceTimersByTimeAsync(20);
    expect(added.dataset.selected).toBe('true');expect(formulas[0].dataset.selected).toBe('true');
    enabled=false;feedback.refresh();expect(transcript.querySelector('[data-selected]')).toBeNull();
    enabled=true;feedback.refresh();expect(added.dataset.selected).toBe('true');
    feedback.destroy();expect(transcript.querySelector('[data-selected]')).toBeNull();
    document.dispatchEvent(new Event('selectionchange'));await vi.advanceTimersByTimeAsync(20);
    expect(transcript.querySelector('[data-selected]')).toBeNull();
  });
});

describe('small copied-formula notice',()=>{
  it('uses one manual popover, preserves focus, replaces a rapid notice and dismisses without stale timers',()=>{
    vi.useFakeTimers();const panel=document.createElement('section');panel.innerHTML='<textarea></textarea><span class="opt-codex-math">x</span>';
    document.body.append(panel);const input=panel.querySelector('textarea')!,formula=panel.querySelector<HTMLElement>('span')!;input.focus();
    const toast=createFormulaCopyToast(panel);cleanup=toast.destroy;
    const notice=panel.querySelector<HTMLElement>('.opt-codex-copy-toast')!;
    expect(notice.hidden).toBe(true);expect(notice.getAttribute('popover')).toBe('manual');
    toast.show(formula,'公式已复制');expect(notice.hidden).toBe(false);expect(notice.textContent).toBe('公式已复制');
    expect(document.activeElement).toBe(input);expect(notice.getAttribute('aria-hidden')).toBe('true');
    vi.advanceTimersByTime(800);toast.show(formula,'Formula copied');vi.advanceTimersByTime(600);
    expect(notice.hidden).toBe(false);expect(panel.querySelectorAll('.opt-codex-copy-toast')).toHaveLength(1);
    vi.advanceTimersByTime(550);expect(notice.hidden).toBe(true);
    toast.show(formula,'Copied');document.dispatchEvent(new Event('scroll'));expect(notice.hidden).toBe(true);
    toast.show(formula,'Copied');toast.destroy();expect(panel.querySelector('.opt-codex-copy-toast')).toBeNull();
  });
  it('does not show a notice for a hidden panel, removed formula or another panel',()=>{
    const panel=document.createElement('section'),formula=document.createElement('span');panel.append(formula);document.body.append(panel);
    const toast=createFormulaCopyToast(panel);cleanup=toast.destroy;const notice=panel.querySelector<HTMLElement>('.opt-codex-copy-toast')!;
    panel.hidden=true;toast.show(formula,'Copied');expect(notice.hidden).toBe(true);
    panel.hidden=false;formula.remove();toast.show(formula,'Copied');expect(notice.hidden).toBe(true);
    document.body.append(formula);toast.show(formula,'Copied');expect(notice.hidden).toBe(true);
  });
});
