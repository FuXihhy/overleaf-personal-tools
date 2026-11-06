// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState, StateField } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import { mountVisualMathBridge, type VisualSnapshot } from '../src/overleaf/visual-math-bridge';
import { mountVisualMathRenderer } from '../src/preview/visual-math';
import { renderFormula } from '../src/preview/render';
import { emptyIndex } from '../src/core/types';
import { parseTex } from '../src/core/parser';

const pause = () => new Promise(resolve => setTimeout(resolve, 20));
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><path d="M0 0L20 10"/></svg>';
const cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterEach(() => { cleanups.splice(0).reverse().forEach(cleanup => cleanup()); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function widget(id = 'v900-1') {
  const editor = document.createElement('div'); editor.className = 'cm-editor';
  const element = document.createElement('span'); element.className = 'ol-cm-math'; element.dataset.optVisualId = id;
  const native = document.createElement('span'); native.textContent = 'native render'; element.append(native); editor.append(element); document.body.append(editor);
  return { element, native };
}
function snapshot(tex = '\\cN=(1,0)', id = 'v900-1', display = false) {
  window.dispatchEvent(new CustomEvent('opt:visual-math', { detail: JSON.stringify({view:id.split('-')[0], formulas:[{id,tex,display}]}) }));
}
function clearSnapshot() { window.dispatchEvent(new CustomEvent('opt:visual-math', { detail: JSON.stringify({view:'v900',formulas:[]}) })); }
function manager(render = vi.fn(async () => ({svg, diagnostics:[] as string[]})), enabled = () => true) {
  const instance = mountVisualMathRenderer({render, enabled}); cleanups.push(() => instance.destroy()); return instance;
}

describe('Visual project-aware mathematics', () => {
  it('renders an unclicked custom macro with the project index and keeps the native widget/event', async () => {
    const {element,native} = widget(), clicked = vi.fn(); element.addEventListener('mouseup', clicked);
    const index = {...emptyIndex(), macros:parseTex('\\newcommand{\\cN}{\\mathcal{N}}','macros.sty').events.flatMap(event => event.type === 'macro' ? [event.macro] : [])};
    const render = vi.fn((tex:string, display:boolean) => renderFormula(tex,index,display));
    manager(render); snapshot(); await pause();
    await vi.waitFor(()=>expect(element.dataset.optVisualRendered).toBe('true'));
    expect(element.contains(native)).toBe(true);
    expect(element.querySelector('.opt-visual-math-body svg')).not.toBeNull();
    expect(element.querySelector('[data-mml-node="merror"]')).toBeNull();
    element.dispatchEvent(new MouseEvent('mouseup', {bubbles:true})); expect(clicked).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalledWith('\\cN=(1,0)',false);
  });
  it('ignores late results after a caret click releases the widget', async () => {
    const {element} = widget(); let resolve!: (value:{svg:string;diagnostics:string[]}) => void;
    manager(vi.fn(() => new Promise(done => {resolve=done;}))); snapshot(); await pause();
    clearSnapshot(); resolve({svg, diagnostics:[]}); await pause();
    expect(element.dataset.optVisualRendered).toBeUndefined(); expect(element.querySelector('svg')).toBeNull();
  });
  it('restores native fallback on disable and does not replace unsuccessful formulas', async () => {
    const {element,native} = widget(); let enabled = true;
    const render = vi.fn(async () => ({svg, diagnostics:[] as string[]})); const ui=manager(render,()=>enabled);
    snapshot(); await pause(); enabled=false; ui.refresh(); await pause();
    expect(element.dataset.optVisualRendered).toBeUndefined(); expect(element.children).toHaveLength(1); expect(element.firstElementChild).toBe(native);
    enabled=true; render.mockResolvedValue({svg,diagnostics:['unsupported macro']}); ui.refresh(); await pause();
    expect(element.children).toHaveLength(1); expect(element.dataset.optVisualRendered).toBeUndefined();
  });
  it('recovers after asynchronous native writes without re-rendering or an observer loop', async () => {
    const {element} = widget(); const render=vi.fn(async()=>({svg,diagnostics:[] as string[]})); manager(render); snapshot(); await pause();
    const late=document.createElement('span');late.textContent='late native result';element.replaceChildren(late);
    await pause(); await pause();
    expect(element.contains(late)).toBe(true);expect(element.querySelectorAll('.opt-visual-math-body')).toHaveLength(1);
    expect(render).toHaveBeenCalledOnce();clearSnapshot();expect(element.children).toHaveLength(1);expect(element.firstElementChild).toBe(late);
  });
  it('renders a widget mounted after its source snapshot arrived', async () => {
    const render=vi.fn(async()=>({svg,diagnostics:[] as string[]}));manager(render);snapshot();await pause();
    expect(render).not.toHaveBeenCalled();
    const {element}=widget();await pause();
    expect(element.dataset.optVisualRendered).toBe('true');expect(render).toHaveBeenCalledOnce();
  });
  it('reattaches cached SVGs in the source frame when typing creates a fresh widget', async () => {
    const first=widget();const render=vi.fn(async()=>({svg,diagnostics:[] as string[]}));manager(render);snapshot();await pause();
    first.element.remove();const next=widget('v900-2');snapshot('\\cN=(1,0)','v900-2');
    expect(next.element.dataset.optVisualRendered).toBe('true');expect(render).toHaveBeenCalledOnce();
  });
  it('restores custom mathematics when the host remounts a parked editor', async () => {
    const {element}=widget(),editor=element.parentElement!;
    const render=vi.fn(async()=>({svg,diagnostics:[] as string[]}));manager(render);snapshot();await pause();
    editor.remove();await pause();expect(element.dataset.optVisualRendered).toBeUndefined();
    document.body.append(editor);await pause();
    expect(element.dataset.optVisualRendered).toBe('true');expect(element.querySelectorAll('.opt-visual-math-body')).toHaveLength(1);
    expect(render).toHaveBeenCalledOnce();
  });
  it('recovers when source identity or the native rendered marker arrives in a later frame', async () => {
    const {element}=widget();delete element.dataset.optVisualId;
    const render=vi.fn(async()=>({svg,diagnostics:[] as string[]}));manager(render);snapshot();await pause();
    expect(render).not.toHaveBeenCalled();element.dataset.optVisualId='v900-1';await pause();
    expect(element.dataset.optVisualRendered).toBe('true');
    delete element.dataset.optVisualRendered;await pause();
    expect(element.dataset.optVisualRendered).toBe('true');expect(element.querySelectorAll('.opt-visual-math-body')).toHaveLength(1);
    expect(render).toHaveBeenCalledOnce();
  });
  it('invalidates a slow render when settings/macros change', async () => {
    const {element}=widget();let resolve!: (value:{svg:string;diagnostics:string[]})=>void;
    const render=vi.fn().mockImplementationOnce(()=>new Promise(done=>{resolve=done;})).mockResolvedValue({svg:svg.replace('20 10','30 10'),diagnostics:[]});
    const ui=manager(render);snapshot();await pause();ui.refresh();resolve({svg,diagnostics:[]});await pause();await pause();
    expect(render).toHaveBeenCalledTimes(2);expect(element.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 30 10');
  });
  it('rejects external resources and malformed snapshots', async () => {
    const {element}=widget();manager(vi.fn(async()=>({svg:'<svg xmlns="http://www.w3.org/2000/svg"><use href="https://example.com/a.svg#x"/></svg>',diagnostics:[]})));
    window.dispatchEvent(new CustomEvent('opt:visual-math',{detail:JSON.stringify({view:'bad',formulas:[{id:'v900-1',tex:'x',display:false}]})}));await pause();expect(element.dataset.optVisualRendered).toBeUndefined();
    snapshot();await pause();expect(element.dataset.optVisualRendered).toBeUndefined();
  });
  it('reattaches its scoped stylesheet after the host replaces head contents', async () => {
    const {element}=widget();const ui=manager();snapshot();await pause();
    const style=[...document.head.querySelectorAll('style')].find(style=>style.textContent?.includes('data-opt-visual-rendered'))!;
    style.remove();await pause();
    expect(style.isConnected).toBe(true);expect(element.dataset.optVisualRendered).toBe('true');ui.destroy();
  });
});

class NativeWidget extends WidgetType {
  toDOM() { const element=document.createElement('span');element.className='ol-cm-math';element.innerHTML='<span>native formula</span>';return element; }
}
describe('Visual source mapping uses real CodeMirror replacement positions', () => {
  function typingView(render: (tex: string, display: boolean) => Promise<{svg?: string; diagnostics: string[]}>) {
    const formulaRange=(state:EditorState)=>({from:state.doc.toString().indexOf('$'),to:state.doc.toString().lastIndexOf('$')+1});
    const decorations=StateField.define({
      create:(state)=>{const {from,to}=formulaRange(state);return Decoration.set([Decoration.replace({widget:new NativeWidget()}).range(from,to)]);},
      update:(value,transaction)=>value.map(transaction.changes),provide:field=>EditorView.decorations.from(field),
    });
    const syntax=(state:EditorState)=>({resolveInner(){return {...formulaRange(state),name:'InlineMath',parent:null,type:{is:(name:string)=>name==='$MathContainer'}};}});
    const plugin=ViewPlugin.define(view=>{
      const bridge=mountVisualMathBridge(view,syntax,()=>true);
      return {update(update){if(update.docChanged)bridge.update(update.changes);},destroy(){bridge.destroy();}};
    });
    manager(vi.fn(render));
    const mount=document.createElement('div');document.body.append(mount);
    const view=new EditorView({parent:mount,state:EditorState.create({doc:'Before $\\cN=(1,0)$ after',extensions:[decorations,plugin]})});
    cleanups.push(()=>view.destroy());return view;
  }
  it('keeps unchanged formula rendering during nearby typing and invalidates only an actual formula edit', async () => {
    const render=vi.fn(async()=>({svg,diagnostics:[] as string[]}));
    const view=typingView(render);await pause();
    const element=view.contentDOM.querySelector<HTMLElement>('.ol-cm-math')!;
    await vi.waitFor(()=>expect(element.dataset.optVisualRendered).toBe('true'));
    for(const insert of ['a','b','c']){
      view.dispatch({changes:{from:0,insert}});
      // Assert before any animation frame: ordinary typing must never expose
      // native red unknown macros even briefly on the same surviving widget.
      expect(element.dataset.optVisualRendered).toBe('true');
      await pause();expect(element.dataset.optVisualRendered).toBe('true');
      const late=document.createElement('span');late.textContent='native red \\cN';element.replaceChildren(late);
      await pause();expect(element.dataset.optVisualRendered).toBe('true');expect(element.querySelectorAll('.opt-visual-math-body')).toHaveLength(1);
    }
    view.dispatch({changes:{from:view.state.doc.length,insert:' more'}});
    expect(element.dataset.optVisualRendered).toBe('true');await pause();expect(render).toHaveBeenCalledOnce();
    const at=view.state.doc.toString().indexOf('cN');view.dispatch({changes:{from:at,to:at+2,insert:'cM'}});
    expect(element.dataset.optVisualRendered).toBeUndefined();
    await pause();expect(render).toHaveBeenLastCalledWith('\\cM=(1,0)',false);
  });
  it('accepts a pending render after surrounding typing and retains it across consecutive transactions', async () => {
    let done!:(result:{svg:string;diagnostics:string[]})=>void;
    const render=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{done=resolve;})).mockResolvedValue({svg,diagnostics:[]});
    const view=typingView(render);await pause();
    view.dispatch({changes:{from:0,insert:'new text '}});await pause();
    const element=view.contentDOM.querySelector<HTMLElement>('.ol-cm-math')!;
    done({svg,diagnostics:[]});await pause();expect(element.dataset.optVisualRendered).toBe('true');expect(render).toHaveBeenCalledOnce();
    view.dispatch({changes:{from:0,insert:'more '}});view.dispatch({changes:{from:0,insert:'typing '}});
    expect(element.dataset.optVisualRendered).toBe('true');await pause();expect(render).toHaveBeenCalledOnce();
  });
  it('publishes exact inline and display source without moving the cursor or changing the document', async () => {
    const text='Text $\\cN=(1,0)$ end\n\\[\\cN^2\\]\n';
    const ranges=[{from:5,to:16,display:false},{from:21,to:31,display:true}];
    // Compute the offsets from source rather than rely on display dimensions.
    ranges[0].to=text.indexOf('$',6)+1;ranges[1].from=text.indexOf('\\[');ranges[1].to=text.indexOf('\\]')+2;
    const decorations=StateField.define({create:()=>Decoration.set(ranges.map(range=>Decoration.replace({widget:new NativeWidget(),block:range.display}).range(range.from,range.to)),true),update:value=>value,provide:field=>EditorView.decorations.from(field)});
    const mount=document.createElement('div');document.body.append(mount);
    const view=new EditorView({parent:mount,state:EditorState.create({doc:text,selection:{anchor:0},extensions:[decorations]})});cleanups.push(()=>view.destroy());
    const snapshots:VisualSnapshot[]=[];const listener=(event:Event)=>snapshots.push(JSON.parse((event as CustomEvent).detail));window.addEventListener('opt:visual-math',listener);cleanups.push(()=>window.removeEventListener('opt:visual-math',listener));
    const syntax=()=>({resolveInner(position:number){const range=ranges.find(range=>position===range.from);return range?{...range,name:'InlineMath',type:{is:(name:string)=>name==='$MathContainer'},parent:null}:{name:'Text',parent:null,type:{is:()=>false}};}});
    const bridge=mountVisualMathBridge(view,syntax,()=>true);cleanups.push(()=>bridge.destroy());await pause();
    expect(snapshots.at(-1)?.formulas.map(({tex,display})=>({tex,display}))).toEqual([{tex:'\\cN=(1,0)',display:false},{tex:'\\cN^2',display:true}]);
    expect(view.state.doc.toString()).toBe(text);expect(view.state.selection.main.from).toBe(0);
    const count=snapshots.length;bridge.update();await pause();expect(snapshots).toHaveLength(count);
    bridge.update(true);expect(snapshots.at(-1)?.formulas).toEqual([]);
  });
});
