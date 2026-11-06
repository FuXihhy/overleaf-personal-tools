/** MAIN-world adapter. Only map existing native math widgets through public CM
 * DOM positions and the host syntax tree; never infer TeX from rendered text. */
export interface VisualFormula { id: string; tex: string; display: boolean }
export interface VisualSnapshot { view: string; formulas: VisualFormula[] }
interface SourceChanges { mapPos(position: number, assoc?: number): number }
let sequence = 0;

export function sourceFormula(source: string): Omit<VisualFormula, 'id'> | undefined {
  if (source.length > 12_000) return;
  const pairs = [['$$', '$$', true], ['\\[', '\\]', true], ['\\(', '\\)', false], ['$', '$', false]] as const;
  for (const [open, close, display] of pairs) if (source.startsWith(open) && source.endsWith(close) && source.length >= open.length + close.length) {
    return { tex: source.slice(open.length, -close.length), display };
  }
  const environment = /^\\begin\{(equation\*?|align\*?|alignat\*?|gather\*?|multline\*?|flalign\*?|math|displaymath)\}/.exec(source);
  if (!environment || !source.endsWith(`\\end{${environment[1]}}`)) return;
  const inline = environment[1] === 'math', bare = inline || environment[1] === 'displaymath';
  return { tex: bare ? source.slice(environment[0].length, -(`\\end{${environment[1]}}`).length) : source, display: !inline };
}

export function mountVisualMathBridge(view: any, syntaxTree: (state: any) => any, enabled: () => boolean) {
  const id = `v${++sequence}`;
  const ids = new WeakMap<Element, string>();
  const marked = new Set<HTMLElement>();
  const ranges = new Map<string, { from: number; to: number; source: string }>();
  let current: VisualFormula[] = [];
  let next = 0, frame = 0, stopped = false, signature = '';
  const publish = (formulas: VisualFormula[]) => {
    current = formulas;
    const data: VisualSnapshot = { view: id, formulas };
    const text = JSON.stringify(data);
    if (text === signature) return;
    signature = text;
    window.dispatchEvent(new CustomEvent('opt:visual-math', { detail: text }));
  };
  function scan() {
    frame = 0;
    if (stopped) return;
    const retained = new Set<HTMLElement>(), formulas: VisualFormula[] = [], nextRanges = new Map<string, { from: number; to: number; source: string }>();
    if (enabled() && view.dom.isConnected && !view.dom.closest('[hidden],[aria-hidden="true"]')) {
      for (const element of view.contentDOM.querySelectorAll('.ol-cm-math') as NodeListOf<HTMLElement>) {
        if (formulas.length >= 96 || element.closest('.cm-editor') !== view.dom || !element.parentNode) continue;
        try {
          const parent = element.parentNode, offset = Array.prototype.indexOf.call(parent.childNodes, element);
          const from = view.posAtDOM(parent, offset), to = view.posAtDOM(parent, offset + 1);
          if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to > view.state.doc.length) continue;
          let node = syntaxTree(view.state).resolveInner(from, 1);
          while (node && !(node.from === from && (node.to === to || node.to + 1 === to && view.state.doc.sliceString(node.to, to) === '\n') && (node.type.is('$MathContainer') || ['EquationEnvironment', 'EquationArrayEnvironment'].includes(node.name)))) node = node.parent;
          if (!node) continue;
          // Block widgets can map the boundary after them past the line break.
          // Only accept that single verified newline; source remains tree-exact.
          const formula = sourceFormula(view.state.doc.sliceString(node.from, node.to));
          if (!formula) continue;
          let token = ids.get(element);
          if (!token) ids.set(element, token = `${id}-${++next}`);
          element.dataset.optVisualId = token;
          nextRanges.set(token, { from: node.from, to: node.to, source: view.state.doc.sliceString(node.from, node.to) });
          retained.add(element); marked.add(element);
          formulas.push({ id: token, ...formula });
        } catch { /* Unknown host widget mapping: leave its native rendering alone. */ }
      }
    }
    for (const element of marked) if (!retained.has(element)) { delete element.dataset.optVisualId; marked.delete(element); }
    ranges.clear(); for (const [token, range] of nextRanges) ranges.set(token, range);
    publish(formulas);
  }
  function schedule() {
    if (stopped || frame) return;
    // Code mode has no native Visual widgets. Avoid even a frame callback on
    // its normal keystrokes; the observer notices when Visual widgets mount.
    if (!marked.size && !view.contentDOM.querySelector('.ol-cm-math')) { publish([]); return; }
    frame = requestAnimationFrame(scan);
  }
  const observer = new MutationObserver(records => {
    if (records.some(record => {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      // Typesetting changes descendants only; they cannot change source mapping.
      return !target?.closest('.ol-cm-math');
    })) schedule();
  });
  observer.observe(view.contentDOM, { childList: true, subtree: true });
  const onMeasure = () => view.requestMeasure();
  window.addEventListener('opt:visual-math-measure', onMeasure);
  schedule();
  return {
    update(invalidate: boolean | SourceChanges = false) {
      // Clear an old result before a source change can reuse a native DOM node
      // for different mathematics. Caret-only changes keep unaffected widgets
      // rendered; released widgets are rejected by their disconnected identity.
      if (invalidate === true) publish([]);
      else if (invalidate) {
        // A nearby keystroke normally only shifts formula offsets. Publishing
        // an empty snapshot here flashes every native unknown command until
        // the next frame. Keep a widget only when the mapped source is exact;
        // an edit inside that formula still invalidates it synchronously.
        const retained = current.filter(formula => {
          const range = ranges.get(formula.id); if (!range) return false;
          const from = invalidate.mapPos(range.from, 1), to = invalidate.mapPos(range.to, -1);
          if (from < 0 || to < from || to > view.state.doc.length || view.state.doc.sliceString(from, to) !== range.source) return false;
          ranges.set(formula.id, { ...range, from, to }); return true;
        });
        publish(retained);
      }
      schedule();
    },
    destroy() {
      stopped = true; cancelAnimationFrame(frame); observer.disconnect();
      window.removeEventListener('opt:visual-math-measure', onMeasure);
      publish([]); for (const element of marked) delete element.dataset.optVisualId;
      marked.clear(); ranges.clear();
    },
  };
}
