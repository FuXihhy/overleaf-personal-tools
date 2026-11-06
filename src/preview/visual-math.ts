import type { VisualFormula, VisualSnapshot } from '../overleaf/visual-math-bridge';

type Result = { svg?: string; diagnostics: string[]; unresolvedCommands?: string[] };
type Render = (tex: string, display: boolean) => Promise<Result>;
const ownedClass = 'opt-visual-math-body';
const styles = `
  .ol-cm-math[data-opt-visual-rendered]{height:auto!important}
  .ol-cm-math[data-opt-visual-rendered]>:not(.${ownedClass}){display:none!important}
  .ol-cm-math>.${ownedClass}{display:inline-block;color:inherit;line-height:normal;pointer-events:none}
  .ol-cm-math>.${ownedClass}>svg{max-width:none}
  div.ol-cm-math>.${ownedClass}{max-width:100%;overflow-x:auto;vertical-align:middle}
`;

function safeSVG(value: string): SVGElement | undefined {
  if (value.length > 2_000_000) return;
  const document = new DOMParser().parseFromString(value, 'image/svg+xml');
  const svg = document.documentElement;
  if (svg.localName !== 'svg' || document.querySelector('parsererror,script,foreignObject,image,iframe')) return;
  for (const element of [svg, ...svg.querySelectorAll('*')]) for (const attribute of element.attributes) {
    if (/^on/i.test(attribute.name) || /href$/i.test(attribute.name) && !attribute.value.startsWith('#')) return;
  }
  return svg as unknown as SVGElement;
}

/** Supplements native Visual widgets with the same project-aware renderer as
 * the caret popup. Original children and outer widget events remain intact. */
export function mountVisualMathRenderer(options: { enabled(): boolean; render: Render }) {
  const snapshots = new Map<string, VisualSnapshot>();
  const cache = new Map<string, Result>();
  const active = new Map<string, { element: HTMLElement; body: HTMLElement; key: string }>();
  const style = document.createElement('style'); style.textContent = styles; document.head.append(style);
  let stopped = false, generation = 0, frame = 0, running = false, dirty = false;
  const observe = () => observer.observe(document.documentElement, {
    childList: true, subtree: true,
    // The MAIN-world mapper and native widget can finish in different frames.
    // Observe only our identity/visibility markers, not every host attribute.
    attributes: true, attributeFilter: ['data-opt-visual-id', 'data-opt-visual-rendered'],
  });
  function mutate(action: () => void) {
    observer.disconnect();
    try { action(); } finally { if (!stopped) observe(); }
  }
  function restore(id: string) {
    const item = active.get(id); if (!item) return;
    delete item.element.dataset.optVisualRendered; item.body.remove(); active.delete(id);
  }
  const requested = () => new Map([...snapshots.values()].flatMap(snapshot => snapshot.formulas.map(formula => [formula.id, formula] as const)));
  const formulaKey = (formula: VisualFormula) => `${Number(formula.display)}:${formula.tex}`;
  function currentElement(formula: VisualFormula) {
    const element = document.querySelector<HTMLElement>(`.cm-editor .ol-cm-math[data-opt-visual-id="${formula.id}"]`);
    if (!element || [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())) return;
    return element;
  }
  function reconcile() {
    const requests = requested();
    mutate(() => {
      for (const [id, item] of active) if (!options.enabled() || !item.element.isConnected || item.element.dataset.optVisualId !== id || formulaKey(requests.get(id) ?? {id, tex:'',display:false}) !== item.key) restore(id);
    });
  }
  function schedule(sourceReady = false) {
    if (stopped) return;
    dirty = true;
    // Source snapshots already arrive from the bridge's animation frame.
    // Reuse cached SVGs in that frame, rather than exposing the native unknown
    // macro for an extra paint whenever nearby typing replaces a widget.
    if (sourceReady && !running) { cancelAnimationFrame(frame); frame = 0; void process(); return; }
    if (!frame && !running) frame = requestAnimationFrame(() => { frame = 0; void process(); });
  }
  async function yieldToBrowser() {
    const scheduler = (globalThis as typeof globalThis & { scheduler?: { yield?(): Promise<void> } }).scheduler;
    if (scheduler?.yield) await scheduler.yield();
    else await new Promise(resolve => setTimeout(resolve, 0));
  }
  async function process() {
    if (stopped || running) return;
    running = true; dirty = false;
    const version = generation;
    try {
      if (!style.isConnected) mutate(() => document.head?.append(style));
      reconcile();
      if (!options.enabled()) return;
      let deadline = performance.now() + 30;
      for (const formula of requested().values()) {
        if (stopped || version !== generation || !options.enabled()) break;
        const element = currentElement(formula); if (!element) continue;
        const key = formulaKey(formula), previous = active.get(formula.id);
        if (previous?.key === key && previous.body.parentElement === element && element.dataset.optVisualRendered) continue;
        let result = cache.get(key);
        if (!result) {
          try { result = await options.render(formula.tex, formula.display); }
          catch { result = { diagnostics: ['render-failed'] }; }
          if (stopped || version !== generation) break;
          if (cache.size >= 96) cache.delete(cache.keys().next().value!);
          cache.set(key, result);
        }
        // Every await is followed by identity checks: a caret click can remove
        // this widget or reuse its node while the renderer module is loading.
        const stillRequested = requested().get(formula.id);
        if (!options.enabled() || !stillRequested || formulaKey(stillRequested) !== key || currentElement(formula) !== element) continue;
        if (result.svg && !result.diagnostics.length && !result.unresolvedCommands?.length) {
          const svg = safeSVG(result.svg);
          if (svg) {
            const body = document.createElement('span'); body.className = ownedClass;
            body.append(document.importNode(svg, true));
            mutate(() => {
              restore(formula.id);
              element.append(body); element.dataset.optVisualRendered = 'true';
              active.set(formula.id, { element, body, key });
            });
            window.dispatchEvent(new Event('opt:visual-math-measure'));
          }
        }
        // Formula parsing is synchronous within each await. Bound batches and
        // yield explicitly; Promise microtasks alone do not allow a repaint.
        if (performance.now() >= deadline) { await yieldToBrowser(); deadline = performance.now() + 30; }
      }
    } finally { running = false; if (dirty && !stopped) schedule(); }
  }
  function onSnapshot(event: Event) {
    try {
      const text = (event as CustomEvent).detail;
      if (typeof text !== 'string' || text.length > 1_300_000) return;
      const data = JSON.parse(text) as VisualSnapshot;
      if (!/^v\d+$/.test(data.view) || !Array.isArray(data.formulas) || data.formulas.length > 96 || data.formulas.some(formula => !formula || !new RegExp(`^${data.view}-\\d+$`).test(formula.id) || typeof formula.tex !== 'string' || formula.tex.length > 12_000 || typeof formula.display !== 'boolean')) return;
      if (data.formulas.length) { if (!snapshots.has(data.view) && snapshots.size >= 8) return; snapshots.set(data.view, data); } else snapshots.delete(data.view);
      reconcile(); schedule(true);
    } catch { /* Ignore malformed page-world data. */ }
  }
  const observer = new MutationObserver(records => {
    if (!style.isConnected && document.head) { schedule(); return; }
    if (records.some(record => {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      return target?.closest('.ol-cm-math') || [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element && (node.matches('.ol-cm-math') || node.querySelector('.ol-cm-math')));
    })) schedule();
  });
  observe(); window.addEventListener('opt:visual-math', onSnapshot);
  return {
    refresh() { generation++; cache.clear(); mutate(() => { for (const id of active.keys()) restore(id); }); schedule(); },
    destroy() {
      stopped = true; generation++; cancelAnimationFrame(frame); observer.disconnect();
      window.removeEventListener('opt:visual-math', onSnapshot);
      for (const id of active.keys()) restore(id);
      style.remove(); snapshots.clear(); cache.clear();
    },
  };
}
