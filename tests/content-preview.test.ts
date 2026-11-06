// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, emptyIndex, type ProjectIndex, type Settings } from '../src/core/types';
import type { PanelActions, PanelModel } from '../src/settings/native-panel';
import type { TexPreviewInput } from '../src/preview/tex-service';

const mocks=vi.hoisted(()=>({
  settings:{} as Settings,
  actions:undefined as PanelActions|undefined,
  model:undefined as (()=>PanelModel)|undefined,
  cooldownUntil:0,
  discover:vi.fn(),buildIndex:vi.fn(),renderTex:vi.fn(),renderFormula:vi.fn(),renderPdf:vi.fn(),cancelLocal:vi.fn(),saveSettings:vi.fn(),reconnectEditor:vi.fn(),
  ui:{update:vi.fn(),refreshForm:vi.fn(),destroy:vi.fn()},
}));
vi.mock('../src/overleaf/project-source',()=>({OverleafProjectSource:class {
  discover=mocks.discover;setRootPath=vi.fn();setLiveDocument=vi.fn();observeNativeRoot=vi.fn();invalidate=vi.fn();
  readFile=vi.fn(async()=>String.raw`\documentclass{article}\begin{document}x\end{document}`);
}}));
vi.mock('../src/core/project-index',()=>({buildProjectIndex:mocks.buildIndex}));
vi.mock('../src/overleaf/editor-connection',()=>({createEditorConnection:()=>({reconnect:mocks.reconnectEditor,dispose:vi.fn()})}));
vi.mock('../src/settings/storage',()=>({loadSettings:async()=>({...mocks.settings}),saveSettings:mocks.saveSettings,saveDefaults:vi.fn(),validateSettings:(settings:Settings)=>({...settings})}));
vi.mock('../src/settings/native-panel',()=>({mountNativeSettings:(model:()=>PanelModel,actions:PanelActions)=>{mocks.model=model;mocks.actions=actions;return mocks.ui;}}));
vi.mock('../src/preview/tex-service',()=>({TexPreviewService:class {
  render=mocks.renderTex;invalidate=vi.fn();invalidateEnvironment=vi.fn();loadSharedBinding=vi.fn();prepareSharedProject=vi.fn();
  get cooldownRemainingMs(){return Math.max(0,mocks.cooldownUntil-Date.now());}
  cloud={getPreviewProject:()=>undefined};
}}));
vi.mock('../src/preview/local-client',()=>({cancelLocalTex:mocks.cancelLocal,getLocalStatus:vi.fn()}));
vi.mock('../src/preview/render',()=>({renderFormula:mocks.renderFormula}));
vi.mock('../src/preview/cloud-pdf',()=>({renderCloudPdf:mocks.renderPdf}));
vi.mock('../src/i18n',()=>({getLocale:()=> 'en',observeLocale:()=>()=>{},translateRuntimeText:(text:string)=>text}));

const project={files:[{id:'main',path:'main.tex',kind:'doc' as const}],rootPath:'main.tex',rootCandidates:['main.tex'],name:'Synthetic'};
const anchor={left:200,top:200,bottom:220,editorTop:0,editorBottom:600,editorLeft:0,editorRight:800,viewportWidth:1000,viewportHeight:700};
const formula=(tex:string,location='view:main.tex:20')=>({tex,display:false,location});
const emit=(message:object)=>window.dispatchEvent(new CustomEvent('opt:editor',{detail:JSON.stringify(message)}));
const select=(tex:string,location?:string)=>{const selected=formula(tex,location);emit({type:'formula',formula:selected});emit({type:'geometry',formula:selected,anchor});};
const popup=()=>document.querySelector<HTMLElement>('.opt-formula-popup')!;
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();await vi.dynamicImportSettled();};
const advance=async(ms:number)=>{await vi.advanceTimersByTimeAsync(ms);await flush();};
function deferred<T>() {let resolve!:(value:T)=>void;let reject!:(reason?:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}

let events:Array<{target:EventTarget;type:string;listener:EventListenerOrEventListenerObject;options?:boolean|AddEventListenerOptions}>;
let observers:MutationObserver[];

beforeEach(async()=>{
  vi.resetModules();vi.clearAllMocks();vi.useFakeTimers();
  document.body.replaceChildren();history.replaceState(null,'','/project/0123456789abcdef01234567');
  mocks.settings={...DEFAULT_SETTINGS,extraFiles:[],previewEngine:'tex',texBackend:'local'};
  mocks.cooldownUntil=0;
  mocks.saveSettings.mockReset().mockResolvedValue(undefined);
  mocks.reconnectEditor.mockReset().mockResolvedValue(undefined);
  mocks.discover.mockReset().mockResolvedValue(project);mocks.buildIndex.mockReset().mockImplementation(async()=>emptyIndex());
  mocks.renderTex.mockReset().mockImplementation(async(input:TexPreviewInput)=>({pdf:new TextEncoder().encode(input.formula),diagnostics:[]}));
  mocks.renderFormula.mockReset().mockImplementation(async(tex:string)=>({svg:`<svg xmlns="http://www.w3.org/2000/svg"><text>${tex}</text></svg>`,diagnostics:[]}));
  mocks.renderPdf.mockReset().mockImplementation(async(pdf:Uint8Array)=>({dataUrl:'data:image/png;base64,'+btoa(new TextDecoder().decode(pdf)),width:50,height:20,diagnostics:[]}));
  vi.stubGlobal('chrome',{runtime:{id:'synthetic-extension',getURL:(name:string)=>name==='renderer.js'?new URL('../src/preview/render.ts',import.meta.url).pathname:new URL('../src/preview/cloud-pdf.ts',import.meta.url).pathname},storage:{local:{get:async()=>({}),set:async()=>{}}}});
  vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>setTimeout(()=>callback(performance.now()),16));
  vi.stubGlobal('cancelAnimationFrame',(id:number)=>clearTimeout(id));
  events=[];observers=[];
  for(const target of [window,document]){
    const original=target.addEventListener.bind(target);
    vi.spyOn(target,'addEventListener').mockImplementation(((type:string,listener:EventListenerOrEventListenerObject,options?:boolean|AddEventListenerOptions)=>{events.push({target,type,listener,options});original(type,listener,options);}) as typeof target.addEventListener);
  }
  const Observer=MutationObserver;
  vi.stubGlobal('MutationObserver',class extends Observer {constructor(callback:MutationCallback){super(callback);observers.push(this);}});
  await import('../src/content');await flush();
  expect(mocks.model?.().busy).toBe(false);
});

afterEach(()=>{
  for(const {target,type,listener,options} of events)target.removeEventListener(type,listener,options);
  for(const observer of observers)observer.disconnect();
  vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();
  document.body.replaceChildren();document.head.querySelectorAll('style').forEach(style=>style.remove());document.documentElement.removeAttribute('data-opt-preview-enabled');
});

describe('content preview lifecycle through bridge events',()=>{
  it('restores a failed editor only after a confirmed reconnect without reading project files again',async()=>{
    emit({type:'error',message:'Synthetic editor failure'});
    const connected=deferred<void>();mocks.reconnectEditor.mockReturnValueOnce(connected.promise);
    const configs:Settings[]=[];
    window.addEventListener('opt:configuration',event=>configs.push(JSON.parse((event as CustomEvent<string>).detail).settings));
    const reads=mocks.discover.mock.calls.length,builds=mocks.buildIndex.mock.calls.length;
    mocks.model!().busy=true;
    const reconnecting=mocks.actions!.reconnectEditor!();await flush();
    expect(mocks.model!().editorReady).toBe(false);expect(configs).toHaveLength(0);
    connected.resolve();await reconnecting;
    expect(mocks.model!().editorReady).toBe(true);expect(configs.at(-1)).toEqual(mocks.model!().settings);
    expect(mocks.discover).toHaveBeenCalledTimes(reads);expect(mocks.buildIndex).toHaveBeenCalledTimes(builds);
    select('x');await advance(16);expect(popup().hidden).toBe(false);
  });

  it('does not report the editor as ready when reconnect verification fails',async()=>{
    emit({type:'error',message:'Synthetic editor failure'});
    mocks.reconnectEditor.mockRejectedValueOnce(new Error('editor-reconnect-timeout'));
    await expect(mocks.actions!.reconnectEditor!()).rejects.toThrow('editor-reconnect-timeout');
    expect(mocks.model!().editorReady).toBe(false);expect(popup().hidden).toBe(true);
  });

  it('applies a setting only after its storage write succeeds',async()=>{
    const stored=deferred<void>();mocks.saveSettings.mockReturnValueOnce(stored.promise);
    select('x');await advance(16);
    const configurations:Settings[]=[];
    window.addEventListener('opt:configuration',event=>configurations.push(JSON.parse((event as CustomEvent<string>).detail).settings));
    const saving=mocks.actions!.save({...mocks.model!().settings,preview:false});await flush();
    expect(mocks.saveSettings).toHaveBeenCalledWith('0123456789abcdef01234567',expect.objectContaining({preview:false}));
    expect(mocks.model!().settings.preview).toBe(true);expect(popup().hidden).toBe(false);expect(configurations).toEqual([]);
    stored.resolve();await saving;
    expect(mocks.model!().settings.preview).toBe(false);expect(popup().hidden).toBe(true);
    expect(configurations.at(-1)?.preview).toBe(false);expect(mocks.discover).toHaveBeenCalledOnce();
  });

  it('keeps the active preview and runtime settings unchanged after a failed storage write',async()=>{
    select('x');await advance(16);
    const previous=mocks.model!().settings,content=popup().querySelector('svg');
    const cancellations=mocks.cancelLocal.mock.calls.length;
    mocks.saveSettings.mockRejectedValueOnce(new Error('Storage unavailable'));
    await expect(mocks.actions!.save({...previous,preview:false})).rejects.toThrow('Storage unavailable');
    expect(mocks.model!().settings).toBe(previous);expect(popup().hidden).toBe(false);expect(popup().querySelector('svg')).toBe(content);
    expect(mocks.cancelLocal).toHaveBeenCalledTimes(cancellations);expect(mocks.discover).toHaveBeenCalledOnce();
  });

  it('preserves in-flight TeX and its cache when only command completion changes',async()=>{
    const pending=deferred<{pdf:Uint8Array;diagnostics:string[]}>();mocks.renderTex.mockReturnValueOnce(pending.promise);
    select('x');await advance(650);
    const cancellations=mocks.cancelLocal.mock.calls.length;
    await mocks.actions!.save({...mocks.model!().settings,completion:false});await flush();
    expect(mocks.model!().settings.completion).toBe(false);expect(mocks.discover).toHaveBeenCalledOnce();
    expect(mocks.cancelLocal).toHaveBeenCalledTimes(cancellations);
    pending.resolve({pdf:new TextEncoder().encode('x'),diagnostics:[]});await flush();
    expect(popup().querySelector('img')).not.toBeNull();
    emit({type:'formula',formula:null});select('x');await advance(1000);
    expect(mocks.renderTex).toHaveBeenCalledOnce();expect(popup().querySelector('img')).not.toBeNull();
  });

  it('updates preview sources from the existing index without dropping completion or rereading files',async()=>{
    const macro={name:'custom',body:'x',args:0,raw:String.raw`\newcommand{\custom}{x}`,kind:'newcommand',source:'macros.sty',offset:0,supported:true};
    const pkg={name:'physics',options:[],source:'main.tex'};
    const index:ProjectIndex={...emptyIndex(),macros:[macro],packages:[pkg],files:['main.tex','macros.sty'],commands:[{name:'custom',source:'macros.sty',preview:'supported'}],
      previewSources:[{id:'file:macros.sty',kind:'file',name:'macros.sty',path:'macros.sty'},{id:'package:physics',kind:'package',name:'physics'}],
      previewEvents:[{sourceId:'file:macros.sty',type:'macro',macro},{sourceId:'package:physics',type:'package',package:pkg}]};
    mocks.buildIndex.mockResolvedValueOnce(index);await mocks.actions!.refresh();
    await mocks.actions!.save({...mocks.model!().settings,previewEngine:'mathjax'});
    select(String.raw`\custom+\qty{x}`);await advance(16);
    expect(mocks.renderFormula.mock.lastCall?.[1].macros).toEqual([macro]);
    const reads=mocks.discover.mock.calls.length,builds=mocks.buildIndex.mock.calls.length;
    const completions=mocks.model!().index.commands;
    const configurations:ProjectIndex['commands'][]=[];
    window.addEventListener('opt:configuration',event=>configurations.push(JSON.parse((event as CustomEvent<string>).detail).commands));
    await mocks.actions!.save({...mocks.model!().settings,previewSources:[{id:'file:macros.sty',enabled:false},{id:'package:physics',enabled:false}]});await advance(16);
    expect(mocks.renderFormula.mock.lastCall?.[1].macros).toEqual([]);expect(mocks.renderFormula.mock.lastCall?.[1].packages).toEqual([]);
    expect(mocks.model!().index.commands).toEqual(completions);expect(configurations.at(-1)).toEqual(completions);
    expect(mocks.discover).toHaveBeenCalledTimes(reads);expect(mocks.buildIndex).toHaveBeenCalledTimes(builds);
  });

  it('keeps mounted Visual math intact for unrelated settings and refreshes it when its source or preview is changed',async()=>{
    const macro={name:'custom',body:'x',args:0,raw:String.raw`\newcommand{\custom}{x}`,kind:'newcommand',source:'macros.sty',offset:0,supported:true};
    const index:ProjectIndex={...emptyIndex(),macros:[macro],files:['main.tex','macros.sty'],
      previewSources:[{id:'file:macros.sty',kind:'file',name:'macros.sty',path:'macros.sty'}],
      previewEvents:[{sourceId:'file:macros.sty',type:'macro',macro}]};
    mocks.buildIndex.mockResolvedValueOnce(index);await mocks.actions!.refresh();
    const editor=document.createElement('div');editor.className='cm-editor';
    const widget=document.createElement('span');widget.className='ol-cm-math';widget.dataset.optVisualId='v900-1';
    const native=document.createElement('span');native.textContent='Native formula';widget.append(native);editor.append(widget);document.body.append(editor);
    window.dispatchEvent(new CustomEvent('opt:visual-math',{detail:JSON.stringify({view:'v900',formulas:[{id:'v900-1',tex:String.raw`\custom`,display:false}]})}));
    await advance(16);
    const rendered=widget.querySelector('.opt-visual-math-body');
    expect(rendered?.querySelector('svg')).not.toBeNull();expect(widget.dataset.optVisualRendered).toBe('true');
    expect(mocks.renderFormula).toHaveBeenCalledOnce();

    for(const preference of [{completion:false},{texCompiler:'xelatex' as const}]) {
      await mocks.actions!.save({...mocks.model!().settings,...preference});
      // Check before the next paint: an unnecessary refresh would expose the
      // native error and detach this existing SVG, even if later re-rendered.
      expect(widget.querySelector('.opt-visual-math-body')).toBe(rendered);
      expect(widget.dataset.optVisualRendered).toBe('true');
      await advance(16);expect(mocks.renderFormula).toHaveBeenCalledOnce();
    }

    await mocks.actions!.save({...mocks.model!().settings,previewSources:[{id:'file:macros.sty',enabled:false}]});await advance(16);
    expect(widget.querySelector('.opt-visual-math-body')).toBeNull();expect(widget.firstElementChild).toBe(native);
    await mocks.actions!.save({...mocks.model!().settings,previewSources:[{id:'file:macros.sty',enabled:true}]});await advance(16);
    expect(widget.dataset.optVisualRendered).toBe('true');expect(mocks.renderFormula).toHaveBeenCalledTimes(2);
    expect(widget.querySelector('.opt-visual-math-body')).not.toBe(rendered);
    await mocks.actions!.save({...mocks.model!().settings,preview:false});
    expect(widget.querySelector('.opt-visual-math-body')).toBeNull();expect(widget.firstElementChild).toBe(native);
    await mocks.actions!.save({...mocks.model!().settings,preview:true});await advance(16);
    expect(widget.dataset.optVisualRendered).toBe('true');expect(mocks.renderFormula).toHaveBeenCalledTimes(3);
  });

  it('lets newer settings save during slow discovery and ignores the superseded discovery result',async()=>{
    const oldDiscovery=deferred<typeof project>();mocks.discover.mockReturnValueOnce(oldDiscovery.promise);
    await mocks.actions!.save({...mocks.model!().settings,rootFile:'old.tex'});
    expect(mocks.model!().busy).toBe(true);expect(mocks.saveSettings).toHaveBeenCalledOnce();
    const newerProject={...project,rootPath:'new.tex',rootCandidates:['new.tex']};mocks.discover.mockResolvedValueOnce(newerProject);
    const index={...emptyIndex(),files:['new.tex']};mocks.buildIndex.mockResolvedValueOnce(index);
    await mocks.actions!.save({...mocks.model!().settings,rootFile:'new.tex'});await flush();
    expect(mocks.saveSettings).toHaveBeenCalledTimes(2);expect(mocks.model!().rootPath).toBe('new.tex');expect(mocks.model!().index.files).toEqual(['new.tex']);
    const builds=mocks.buildIndex.mock.calls.length;
    oldDiscovery.resolve({...project,rootPath:'old.tex',rootCandidates:['old.tex']});await flush();
    expect(mocks.buildIndex).toHaveBeenCalledTimes(builds);expect(mocks.model!().rootPath).toBe('new.tex');expect(mocks.model!().busy).toBe(false);
  });

  it('retires the old content instance after extension reload and discards an in-flight TeX result',async()=>{
    const native=document.createElement('div');native.className='ol-cm-math-tooltip-container';document.body.append(native);
    const pending=deferred<{pdf:Uint8Array;diagnostics:string[]}>();mocks.renderTex.mockReturnValueOnce(pending.promise);
    select('x');await advance(650);expect(getComputedStyle(native).display).toBe('none');
    Object.defineProperty(chrome.runtime,'id',{value:undefined,configurable:true});
    select('y');await flush();
    expect(popup()).toBeNull();expect(getComputedStyle(native).display).not.toBe('none');
    expect(mocks.ui.destroy).toHaveBeenCalledOnce();
    pending.resolve({pdf:new TextEncoder().encode('old'),diagnostics:[]});await flush();
    expect(mocks.renderPdf).not.toHaveBeenCalled();
    const drafts=mocks.renderFormula.mock.calls.length;const rebuilds=mocks.discover.mock.calls.length;
    select('z');await mocks.actions!.refresh();await advance(2000);
    expect(mocks.renderFormula).toHaveBeenCalledTimes(drafts);expect(mocks.discover).toHaveBeenCalledTimes(rebuilds);
    expect(mocks.renderTex).toHaveBeenCalledOnce();expect(mocks.ui.destroy).toHaveBeenCalledOnce();
  });

  it('cleans up when getURL throws even if the runtime id is still present',async()=>{
    const pending=deferred<{pdf:Uint8Array;diagnostics:string[]}>();mocks.renderTex.mockReturnValueOnce(pending.promise);
    select('x');await advance(650);
    vi.spyOn(chrome.runtime,'getURL').mockImplementation(()=>{throw new Error('Extension context invalidated.');});
    pending.resolve({pdf:new TextEncoder().encode('x'),diagnostics:[]});await flush();
    expect(mocks.ui.destroy).toHaveBeenCalledOnce();expect(popup()).toBeNull();
    expect(mocks.renderPdf).not.toHaveBeenCalled();
    expect(document.documentElement.hasAttribute('data-opt-preview-enabled')).toBe(false);
  });

  it('does not apply a delayed project discovery after the extension context is invalidated',async()=>{
    const pending=deferred<typeof project>();mocks.discover.mockReturnValueOnce(pending.promise);
    const refreshing=mocks.actions!.refresh();await flush();const builds=mocks.buildIndex.mock.calls.length;
    Object.defineProperty(chrome.runtime,'id',{value:undefined,configurable:true});
    document.body.append(document.createElement('span'));await flush();
    pending.resolve(project);await refreshing;await flush();
    expect(mocks.buildIndex).toHaveBeenCalledTimes(builds);expect(mocks.ui.destroy).toHaveBeenCalledOnce();
    expect(popup()).toBeNull();
  });

  it('does not restart the 650ms TeX debounce on repeated same-formula or geometry events',async()=>{
    select('x');await advance(300);emit({type:'formula',formula:formula('x')});emit({type:'geometry',formula:formula('x'),anchor:{...anchor,left:300}});
    await advance(349);expect(mocks.renderTex).not.toHaveBeenCalled();
    await advance(1);expect(mocks.renderTex).toHaveBeenCalledOnce();expect(mocks.renderTex.mock.calls[0][0].formula).toBe('x');
    expect(popup().querySelector('[data-opt-render-kind="tex"]')).not.toBeNull();
  });

  it('can compile a formula re-entered after its first timer was abandoned',async()=>{
    select('x');await advance(100);emit({type:'formula',formula:null});await advance(800);
    expect(mocks.renderTex).not.toHaveBeenCalled();expect(popup().hidden).toBe(true);
    select('x');await advance(649);expect(mocks.renderTex).not.toHaveBeenCalled();
    await advance(1);expect(mocks.renderTex).toHaveBeenCalledOnce();
  });

  it('hides on a global geometry clear and rejects geometry for another formula location',()=>{
    select('x');expect(popup().hidden).toBe(false);
    emit({type:'geometry',formula:null,anchor:null});expect(popup().hidden).toBe(true);
    emit({type:'geometry',formula:formula('x','other-view:main.tex:20'),anchor});expect(popup().hidden).toBe(true);
    emit({type:'geometry',formula:formula('x'),anchor});expect(popup().hidden).toBe(false);
  });

  it('discards a slow old MathJax result after the selected formula changes',async()=>{
    const old=deferred<{svg:string;diagnostics:string[]}>();mocks.renderFormula.mockImplementationOnce(()=>old.promise);
    select('x');await advance(16);expect(mocks.renderFormula).toHaveBeenCalledOnce();
    select('y');await advance(16);expect(popup().querySelector('svg')?.textContent).toBe('y');
    old.resolve({svg:'<svg xmlns="http://www.w3.org/2000/svg"><text>STALE X</text></svg>',diagnostics:[]});await flush();
    expect(popup().querySelector('svg')?.textContent).toBe('y');expect(popup().textContent).not.toContain('STALE');
  });

  it('serializes TeX work and never rasterizes a stale old PDF over a newer formula',async()=>{
    const old=deferred<{pdf:Uint8Array;diagnostics:string[]}>();mocks.renderTex.mockImplementationOnce(()=>old.promise);
    select('x');await advance(650);expect(mocks.renderTex).toHaveBeenCalledOnce();
    select('y');await advance(650);expect(mocks.renderTex).toHaveBeenCalledOnce();expect(popup().querySelector('svg')?.textContent).toBe('y');
    old.resolve({pdf:new TextEncoder().encode('STALE X'),diagnostics:[]});await flush();
    expect(mocks.renderPdf).not.toHaveBeenCalled();await advance(650);
    expect(mocks.renderTex).toHaveBeenCalledTimes(2);expect(mocks.renderPdf).toHaveBeenCalledOnce();
    expect(popup().querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,'+btoa('y'));
  });

  it('reschedules a TeX preview skipped while an unchanged project index is rebuilding',async()=>{
    select('x');const discovering=deferred<typeof project>();mocks.discover.mockReturnValueOnce(discovering.promise);
    const refresh=mocks.actions!.refresh();await flush();expect(mocks.model!().busy).toBe(true);
    await advance(650);expect(mocks.renderTex).not.toHaveBeenCalled();
    discovering.resolve(project);await refresh;await flush();expect(mocks.model!().busy).toBe(false);
    await advance(650);expect(mocks.renderTex).toHaveBeenCalledOnce();
  });

  it('recompiles TeX after an explicit refresh even when static declarations are unchanged',async()=>{
    select('x');await advance(650);expect(mocks.renderTex).toHaveBeenCalledOnce();
    // A class option, font or layout change can affect real TeX without changing
    // the command/package index. Refresh must invalidate the compiled PDF too.
    await mocks.actions!.refresh();await flush();await advance(650);
    expect(mocks.renderTex).toHaveBeenCalledTimes(2);
  });

  it('allows retrying a temporary TeX failure after leaving and re-entering the same formula',async()=>{
    mocks.renderTex.mockRejectedValueOnce(new Error('Temporary compiler failure'));
    select('x');await advance(650);expect(mocks.model!().status).toContain('Temporary compiler failure');
    emit({type:'formula',formula:formula('x')});await advance(1000);expect(mocks.renderTex).toHaveBeenCalledOnce();
    emit({type:'formula',formula:null});select('x');await advance(650);
    expect(mocks.renderTex).toHaveBeenCalledTimes(2);expect(popup().querySelector('img')).not.toBeNull();
  });

  it('does not delay a service cache hit behind cloud cooldown or show a loading banner',async()=>{
    await mocks.actions!.save({...mocks.settings,texBackend:'overleaf'});await flush();
    mocks.cooldownUntil=Date.now()+3000;
    select('x');await advance(649);expect(mocks.renderTex).not.toHaveBeenCalled();
    expect(popup().querySelector('svg')?.textContent).toBe('x');
    expect(popup().textContent).not.toMatch(/Rendering|Loading|正在/);
    await advance(1);expect(mocks.renderTex).toHaveBeenCalledOnce();
    expect(popup().querySelector('img')).not.toBeNull();
    expect(popup().querySelector('[data-opt-pending],[data-opt-loading]')).toBeNull();
  });

  it('keeps native previews suppressed after bridge failure and restores them only when disabled',async()=>{
    const native=document.createElement('div');native.className='ol-cm-math-tooltip-container';native.textContent='Native';document.body.append(native);
    select('x');emit({type:'error',message:'Bridge disconnected'});
    expect(popup().hidden).toBe(true);expect(getComputedStyle(native).display).toBe('none');
    select('y');expect(popup().hidden).toBe(true);
    emit({type:'ready'});select('y');expect(popup().hidden).toBe(false);
    await mocks.actions!.save({...mocks.settings,preview:false});await flush();
    expect(popup().hidden).toBe(true);expect(getComputedStyle(native).display).not.toBe('none');
  });
});
