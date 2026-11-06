/** SVG glyphs do not receive the browser's native text-selection paint. Keep
 * the real Selection intact and paint the existing formula wrapper instead. */
export const mathFeedbackStyles = `
#opt-codex-panel .opt-codex-message-body::selection,
#opt-codex-panel .opt-codex-message-body ::selection { background:Highlight; color:HighlightText; }
#opt-codex-panel .opt-codex-math[data-selected=true] { background:Highlight; color:HighlightText; box-shadow:none; border-radius:0; }
#opt-codex-panel .opt-codex-copy-toast { position:fixed; inset:auto; margin:0; width:max-content; max-width:min(220px,calc(100vw - 16px)); padding:4px 8px; border:1px solid var(--opt-codex-border,#354252); border-radius:5px; background:var(--opt-codex-bg,#202a35); color:var(--opt-codex-fg,#f1f3f5); font:inherit; font-size:12px; line-height:18px; box-shadow:0 1px 5px #0002; pointer-events:none; user-select:none; opacity:0; transition:opacity 100ms,display 100ms allow-discrete,overlay 100ms allow-discrete; }
#opt-codex-panel .opt-codex-copy-toast:popover-open,
#opt-codex-panel .opt-codex-copy-toast[data-fallback-open=true] { opacity:1; }
#opt-codex-panel .opt-codex-copy-toast::backdrop { background:transparent; pointer-events:none; }
@starting-style { #opt-codex-panel .opt-codex-copy-toast:popover-open { opacity:0; } }
@media(prefers-reduced-motion:reduce) { #opt-codex-panel .opt-codex-copy-toast { transition:none; } }
`;

export function createMathSelectionFeedback(transcript: HTMLElement, options: { enabled?: () => boolean } = {}) {
  const document = transcript.ownerDocument, view = document.defaultView!;
  let frame = 0, destroyed = false, dirty = true;
  let formulas: HTMLElement[] = [];
  const selected = new Set<HTMLElement>();
  function refresh() {
    if (destroyed) return;
    if (frame) view.cancelAnimationFrame(frame); frame = 0;
    const selection = document.getSelection();
    const ranges: Range[] = [];
    if (transcript.isConnected && (options.enabled?.() ?? true) && selection && !selection.isCollapsed) {
      for (let i = 0; i < selection.rangeCount; i++) {
        const range = selection.getRangeAt(i);
        if (!range.collapsed) ranges.push(range);
      }
    }
    if (dirty) { formulas = [...transcript.querySelectorAll<HTMLElement>('.opt-codex-math')]; dirty = false; }
    const next = new Set<HTMLElement>();
    for (const formula of formulas) {
      if (!ranges.length || !transcript.contains(formula)) continue;
      try { if (ranges.some(range => range.intersectsNode(formula))) next.add(formula); }
      catch { /* A detached range cannot select a live formula. */ }
    }
    for (const formula of selected) if (!next.has(formula)) { delete formula.dataset.selected; selected.delete(formula); }
    for (const formula of next) if (!selected.has(formula)) { formula.dataset.selected = 'true'; selected.add(formula); }
  }
  function schedule() { if (!destroyed && !frame) frame = view.requestAnimationFrame(refresh); }
  const observer = new MutationObserver(() => { dirty = true; schedule(); });
  // Only content changes matter: ignoring attributes avoids observing our own
  // selection marker and prevents a frame loop while an answer streams.
  observer.observe(transcript, { childList:true, subtree:true, characterData:true });
  document.addEventListener('selectionchange', schedule);
  transcript.addEventListener('pointerup', schedule);
  transcript.addEventListener('keyup', schedule);
  refresh();
  return {
    refresh,
    destroy() {
      destroyed = true; observer.disconnect(); if (frame) view.cancelAnimationFrame(frame);
      document.removeEventListener('selectionchange', schedule);
      transcript.removeEventListener('pointerup', schedule);
      transcript.removeEventListener('keyup', schedule);
      for (const formula of selected) delete formula.dataset.selected;
      selected.clear(); formulas = [];
    },
  };
}

/** Optional visual acknowledgement. The existing copy live-region supplies its
 * accessible announcement, so this short, noninteractive popover stays silent. */
export function createFormulaCopyToast(panel: HTMLElement) {
  const document = panel.ownerDocument, view = document.defaultView!;
  const element = document.createElement('div');
  element.className = 'opt-codex-copy-toast'; element.setAttribute('popover', 'manual');
  element.setAttribute('aria-hidden', 'true'); element.hidden = true; panel.append(element);
  let timer: ReturnType<typeof setTimeout> | undefined, destroyed = false;
  function hide() {
    clearTimeout(timer); timer = undefined;
    if (typeof element.hidePopover === 'function') { try { element.hidePopover(); } catch { /* Already hidden/detached. */ } }
    element.hidden = true; delete element.dataset.fallbackOpen;
  }
  document.addEventListener('scroll', hide, true);
  document.addEventListener('pointerdown', hide, true);
  view.addEventListener('resize', hide);
  return {
    show(anchor: HTMLElement, text: string) {
      hide();
      if (destroyed || !panel.isConnected || panel.hidden || !anchor.isConnected || !panel.contains(anchor)) return;
      element.textContent = text; element.hidden = false;
      if ('popover' in element && typeof element.showPopover === 'function') {
        try { element.showPopover(); } catch { element.hidden = true; return; }
      } else element.dataset.fallbackOpen = 'true';
      const source = anchor.getBoundingClientRect(), tip = element.getBoundingClientRect();
      const left = Math.max(8, Math.min(source.left + (source.width - tip.width) / 2, view.innerWidth - tip.width - 8));
      const top = source.bottom + tip.height + 6 <= view.innerHeight - 8 ? source.bottom + 6 : Math.max(8, source.top - tip.height - 6);
      element.style.left = `${left}px`; element.style.top = `${top}px`;
      timer = setTimeout(hide, 1150);
    },
    hide,
    destroy() {
      destroyed = true; hide(); element.remove();
      document.removeEventListener('scroll', hide, true);
      document.removeEventListener('pointerdown', hide, true);
      view.removeEventListener('resize', hide);
    },
  };
}
