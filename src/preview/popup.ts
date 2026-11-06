export interface PopupContent {
  key: string;
  pending: boolean;
  createBody(): HTMLElement;
}

/** All coordinates are CSS pixels relative to the viewport. */
export interface PopupAnchor {
  left: number;
  top: number;
  bottom: number;
  editorTop: number;
  editorBottom: number;
  editorLeft: number;
  editorRight: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface PreviewPopupState {
  enabled: boolean;
  content: PopupContent | null;
  anchor?: PopupAnchor | null;
  formulaTex?: string;
  formulaId?: string;
}

export const previewPopupStyles = `
  html[data-opt-preview-enabled] .ol-cm-math-tooltip-container{display:none!important}
  .opt-formula-popup{position:fixed;z-index:1050;box-sizing:border-box;width:max-content;padding:5px 7px;border:1px solid #d6d9dc;border-radius:4px;background:#fff;color:#222;box-shadow:0 2px 8px #0002;overflow:auto;font-family:var(--font-sans,var(--bs-body-font-family,var(--opt-interface-font,inherit)));font-size:14px;font-weight:400;line-height:1.4}
  .opt-formula-popup[hidden]{display:none!important}
  .opt-formula-popup .opt-formula-body{box-sizing:border-box;color:inherit;max-width:100%;overflow:auto}
  .opt-formula-popup .opt-preview-source{font-family:inherit;font-size:12px;font-weight:400;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere}
  .opt-formula-popup .opt-formula-body svg{max-width:none;vertical-align:middle}
  .opt-formula-popup .opt-formula-body img{display:block;max-width:none;background:white}
  .opt-formula-popup .opt-formula-body .opt-preview-message{font-size:12px;font-weight:400;line-height:18px;white-space:normal;max-width:440px;text-align:center;margin:0 auto;color:#71777d}
`;

/** Own the entire preview surface, independently of Overleaf's native tooltip. */
export function mountPreviewPopup(options: {
  document: Document;
  initial: PreviewPopupState;
}) {
  const document=options.document;
  const window=document.defaultView;
  let state=options.initial;
  let stopped=false;
  let body:HTMLElement|undefined;
  let bodyKey:string|undefined;
  const surface=document.createElement('div');
  surface.className='opt-formula-popup';
  surface.setAttribute('role','tooltip');
  surface.hidden=true;
  if(window)surface.style.setProperty('--opt-interface-font',window.getComputedStyle(document.body).fontFamily);
  document.body.append(surface);

  function conceal(clearBody=false) {
    surface.hidden=true;
    surface.style.visibility='hidden';
    delete surface.dataset.optPreview;
    if(clearBody){body?.remove();body=undefined;bodyKey=undefined;}
  }

  function bounds(anchor:PopupAnchor) {
    if(![anchor.left,anchor.top,anchor.bottom,anchor.editorTop,anchor.editorBottom,anchor.editorLeft,anchor.editorRight,anchor.viewportWidth,anchor.viewportHeight].every(Number.isFinite))return null;
    const left=Math.max(8,anchor.editorLeft+8);
    const right=Math.min(anchor.viewportWidth-8,anchor.editorRight-8);
    const top=Math.max(8,anchor.editorTop+8);
    const bottom=Math.min(anchor.viewportHeight-8,anchor.editorBottom-8);
    if(right-left<24 || bottom-top<24 || anchor.bottom<anchor.top || anchor.bottom<top || anchor.top>bottom)return null;
    const above=Math.max(0,anchor.top-top-6);
    const below=Math.max(0,bottom-anchor.bottom-6);
    if(Math.max(above,below)<16)return null;
    return{left,right,top,bottom,above,below};
  }

  function position() {
    const anchor=state.anchor;
    if(stopped || !state.enabled || !state.content || state.content.pending || !anchor || !body){conceal();return;}
    const box=bounds(anchor);
    if(!box){conceal();return;}
    // Size new content while invisible. Position and visibility are committed in
    // this same task, so no frame can contain new content at an old position.
    surface.style.visibility='hidden';
    surface.hidden=false;
    surface.style.maxWidth=Math.min(720,box.right-box.left)+'px';
    surface.style.maxHeight=Math.max(box.above,box.below)+'px';
    const rect=surface.getBoundingClientRect();
    const width=Math.min(rect.width,box.right-box.left);
    const height=Math.min(rect.height,Math.max(box.above,box.below));
    const above=height<=box.above || box.above>=box.below;
    const left=Math.max(box.left,Math.min(anchor.left,box.right-width));
    const top=above?anchor.top-height-6:anchor.bottom+6;
    surface.style.left=left+'px';
    surface.style.top=Math.max(box.top,Math.min(top,box.bottom-height))+'px';
    surface.dataset.optPlacement=above?'above':'below';
    surface.dataset.optPreview=state.content.key;
    surface.style.visibility='visible';
  }

  function sync() {
    if(stopped)return;
    document.documentElement.toggleAttribute('data-opt-preview-enabled',state.enabled);
    if(!state.enabled || !state.content || state.content.pending){conceal(true);return;}
    if(!state.anchor || !bounds(state.anchor)){conceal(true);return;}
    if(bodyKey!==state.content.key || !body) {
      conceal(true);
      const next=state.content.createBody();
      next.classList.add('opt-formula-body');
      body=next;bodyKey=state.content.key;
      surface.replaceChildren(next);
    }
    position();
  }

  const onLoad=(event:Event)=>{if(event.target instanceof Node && body?.contains(event.target))position();};
  surface.addEventListener('load',onLoad,true);
  // Images and fonts may settle after the initial synchronous layout. Observe
  // only our surface; native MathJax mutations cannot affect this lifecycle.
  const ResizeObserverClass=window?.ResizeObserver;
  const resizeObserver=ResizeObserverClass?new ResizeObserverClass(()=>position()):undefined;
  resizeObserver?.observe(surface);
  sync();
  return {
    update(next:PreviewPopupState){state=next;sync();},
    target(){return !surface.hidden?surface:undefined;},
    destroy(){
      stopped=true;resizeObserver?.disconnect();surface.removeEventListener('load',onLoad,true);surface.remove();
      document.documentElement.removeAttribute('data-opt-preview-enabled');
    },
  };
}
