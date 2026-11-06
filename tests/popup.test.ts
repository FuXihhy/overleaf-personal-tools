// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountPreviewPopup, previewPopupStyles, type PreviewPopupState, type PopupAnchor, type PopupContent } from '../src/preview/popup';

const anchor=(patch:Partial<PopupAnchor>={}):PopupAnchor=>({left:200,top:200,bottom:220,editorTop:0,editorBottom:600,editorLeft:0,editorRight:800,viewportWidth:1000,viewportHeight:700,...patch});
const content=(key:string,text:string,width=180,height=40):PopupContent=>({key,pending:false,createBody(){const body=document.createElement('div');body.textContent=text;body.dataset.width=String(width);body.dataset.height=String(height);return body;}});
const surface=()=>document.querySelector<HTMLElement>('.opt-formula-popup')!;
const native=()=>{const node=document.createElement('div');node.className='ol-cm-math-tooltip-container';node.innerHTML='<div class="ol-cm-math-tooltip">Native preview</div>';document.body.append(node);return node;};

describe('extension-owned formula popup',()=>{
  let controller:ReturnType<typeof mountPreviewPopup>|undefined;
  let style:HTMLStyleElement;
  const measurements:Array<{visibility:string;key?:string}>=[];
  const mount=(initial:PreviewPopupState)=>controller=mountPreviewPopup({document,initial});
  beforeEach(()=>{
    document.body.replaceChildren();measurements.length=0;
    style=document.createElement('style');style.textContent=previewPopupStyles;document.head.append(style);
    vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){
      if(!this.classList.contains('opt-formula-popup'))return new DOMRect();
      measurements.push({visibility:this.style.visibility,key:this.dataset.optPreview});
      const body=this.firstElementChild as HTMLElement|null;
      return new DOMRect(0,0,Math.min(Number(body?.dataset.width)||0,parseFloat(this.style.maxWidth)||Infinity),Math.min(Number(body?.dataset.height)||0,parseFloat(this.style.maxHeight)||Infinity));
    });
  });
  afterEach(()=>{controller?.destroy();controller=undefined;style.remove();document.body.replaceChildren();vi.restoreAllMocks();vi.useRealTimers();});

  it('creates its own surface without a native tooltip and hides only native math previews while enabled',()=>{
    mount({enabled:true,anchor:anchor(),content:content('x','Our formula')});
    expect(controller!.target()).toBe(surface());expect(surface().textContent).toBe('Our formula');
    expect(surface().style.left).toBe('200px');expect(surface().style.top).toBe('154px');expect(surface().dataset.optPlacement).toBe('above');
    const original=native();expect(getComputedStyle(original).display).toBe('none');
    const unrelated=document.createElement('div');unrelated.className='cm-tooltip';document.body.append(unrelated);
    expect(getComputedStyle(unrelated).display).not.toBe('none');
    controller!.update({enabled:false,content:null});
    expect(surface().hidden).toBe(true);expect(document.documentElement.hasAttribute('data-opt-preview-enabled')).toBe(false);
    expect(getComputedStyle(original).display).not.toBe('none');expect(original.textContent).toBe('Native preview');
  });

  it('measures new content invisibly and commits its final placement synchronously',()=>{
    mount({enabled:true,anchor:anchor({top:32,bottom:52}),content:content('x','New formula',180,70)});
    expect(measurements).toEqual([{visibility:'hidden',key:undefined}]);
    expect(surface().hidden).toBe(false);expect(surface().style.visibility).toBe('visible');
    expect(surface().style.top).toBe('58px');expect(surface().dataset.optPlacement).toBe('below');
  });

  it('repositions the same key without recreating its body',()=>{
    const result=content('x','Formula');const create=vi.spyOn(result,'createBody');
    mount({enabled:true,anchor:anchor(),content:result});const body=surface().firstElementChild;
    controller!.update({enabled:true,anchor:anchor({left:450,top:300,bottom:320}),content:result});
    expect(create).toHaveBeenCalledOnce();expect(surface().firstElementChild).toBe(body);
    expect(surface().style.left).toBe('450px');expect(surface().style.top).toBe('254px');
  });

  it('clamps a long formula to editor and viewport bounds and uses the available vertical space',()=>{
    mount({enabled:true,anchor:anchor({left:760,top:360,bottom:380,editorLeft:100,editorRight:780,editorBottom:450}),content:content('long','Long formula',1400,1000)});
    expect(surface().style.maxWidth).toBe('664px');expect(surface().style.left).toBe('108px');
    expect(surface().style.maxHeight).toBe('346px');expect(surface().style.top).toBe('8px');
    expect(surface().dataset.optPlacement).toBe('above');
    controller!.update({enabled:true,anchor:anchor({left:950,top:10,bottom:30,editorRight:2000,editorBottom:2000,viewportHeight:400}),content:content('small','Small',100,40)});
    expect(surface().style.left).toBe('892px');expect(surface().style.top).toBe('36px');
  });

  it('clears a previous formula immediately while the next result is pending, without any loading text',()=>{
    mount({enabled:true,anchor:anchor(),content:content('x','OLD FORMULA')});
    const factory=vi.fn(()=>{const body=document.createElement('div');body.textContent='Rendering preview…';return body;});
    controller!.update({enabled:true,anchor:anchor(),content:{key:'pending:y',pending:true,createBody:factory}});
    expect(factory).not.toHaveBeenCalled();expect(surface().hidden).toBe(true);expect(surface().textContent).toBe('');expect(controller!.target()).toBeUndefined();
    controller!.update({enabled:true,anchor:anchor(),content:content('y','NEW FORMULA')});
    expect(surface().textContent).toBe('NEW FORMULA');expect(surface().hidden).toBe(false);
  });

  it('never reveals native output on null content, bridge loss, a delayed native render or extension failure',async()=>{
    vi.useFakeTimers();const original=native();
    mount({enabled:true,anchor:anchor(),content:content('x','Our formula')});
    controller!.update({enabled:true,content:null,anchor:null});
    original.innerHTML='<mjx-container jax="SVG"><svg><g data-mml-node="mi"></g></svg></mjx-container>';
    await vi.advanceTimersByTimeAsync(1000);
    expect(surface().hidden).toBe(true);expect(surface().textContent).toBe('');expect(getComputedStyle(original).display).toBe('none');
    controller!.update({enabled:true,anchor:anchor(),content:content('error','Extension error')});
    expect(surface().textContent).toBe('Extension error');expect(getComputedStyle(original).display).toBe('none');
    expect(document.querySelector('[data-opt-native-fallback],[data-opt-fallback-native]')).toBeNull();
  });

  it('waits for valid current geometry without rendering stale or offscreen content',()=>{
    const result=content('x','Formula');const create=vi.spyOn(result,'createBody');
    mount({enabled:true,content:result,anchor:null});expect(surface().hidden).toBe(true);expect(create).not.toHaveBeenCalled();
    controller!.update({enabled:true,content:result,anchor:anchor()});expect(surface().hidden).toBe(false);
    controller!.update({enabled:true,content:result,anchor:anchor({top:610,bottom:630})});expect(surface().hidden).toBe(true);expect(surface().textContent).toBe('');
    controller!.update({enabled:true,content:result,anchor:anchor({left:NaN})});expect(surface().hidden).toBe(true);
    controller!.update({enabled:true,content:result,anchor:anchor()});expect(surface().textContent).toBe('Formula');
  });

  it('repositions a loaded image and ignores a late load belonging to a removed formula',()=>{
    const result=content('image','',100,20);const factory=result.createBody;
    result.createBody=()=>{const body=factory();body.append(document.createElement('img'));return body;};
    mount({enabled:true,anchor:anchor({top:40,bottom:60}),content:result});
    const body=surface().firstElementChild as HTMLElement;const image=body.querySelector('img')!;
    expect(surface().dataset.optPlacement).toBe('above');
    body.dataset.height='100';image.dispatchEvent(new Event('load'));
    expect(surface().dataset.optPlacement).toBe('below');expect(surface().style.top).toBe('66px');
    controller!.update({enabled:true,anchor:anchor(),content:content('new','Current formula')});const count=measurements.length;
    image.dispatchEvent(new Event('load'));
    expect(measurements).toHaveLength(count);expect(surface().textContent).toBe('Current formula');
  });

  it('replaces same-text revisions by key and removes the surface and native hiding flag on teardown',()=>{
    const original=native();mount({enabled:true,anchor:anchor(),formulaTex:'x',formulaId:'rev1:x',content:content('rev1:x','Old rendering')});
    controller!.update({enabled:true,anchor:anchor(),formulaTex:'x',formulaId:'rev2:x',content:content('rev2:x','Current rendering')});
    expect(surface().textContent).toBe('Current rendering');
    controller!.destroy();controller=undefined;
    expect(document.querySelector('.opt-formula-popup')).toBeNull();expect(getComputedStyle(original).display).not.toBe('none');
  });
});
