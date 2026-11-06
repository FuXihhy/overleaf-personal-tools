import { EditorState, StateEffect, StateField, type Extension, type Text } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view';

type MathRange = { from: number; to: number; source: string; display: boolean };
type SyntheticNode = { name: string; from: number; to: number; parent: null; type: { is(name: string): boolean } };
type SyntheticTree = { length: number; resolveInner(position: number): SyntheticNode };

// Deliberately a small, synthetic parser, not a second LaTeX parser. Unlike the
// old fixture it has stable tree identity until the document or parse state changes.
const rangesByDoc = new WeakMap<Text, MathRange[]>();
function mathRanges(doc: Text): MathRange[] {
  const cached = rangesByDoc.get(doc);
  if (cached) return cached;
  const source = doc.toString();
  const ranges: MathRange[] = [];
  const pattern = /\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\\begin\{(equation\*?|align\*?|gather\*?|math|displaymath)\}[\s\S]*?\\end\{\1\}|\$(?:\\.|[^$\n])*\$/g;
  for (const match of source.matchAll(pattern)) {
    const from = match.index!;
    const line = doc.lineAt(from);
    if (from > 0 && source[from - 1] === '\\' || line.text.slice(0, from - line.from).includes('%')) continue;
    const text = match[0];
    ranges.push({ from, to: from + text.length, source: text, display: text.startsWith('$$') || text.startsWith('\\[') || text.startsWith('\\begin{') && !text.startsWith('\\begin{math}') });
  }
  rangesByDoc.set(doc, ranges);
  return ranges;
}

class SyntheticMathWidget extends WidgetType {
  constructor(readonly range: MathRange) { super(); }
  eq(other: SyntheticMathWidget) { return other.range.from === this.range.from && other.range.source === this.range.source; }
  toDOM(view: EditorView): HTMLElement {
    const element = document.createElement(this.range.display ? 'div' : 'span');
    element.className = 'ol-cm-math fixture-visual-math';
    const native = document.createElement('mjx-container');
    native.textContent = this.range.display ? '∑ f(x) — synthetic display widget' : 'ƒ(x)';
    element.append(native);
    element.title = `Artificial native math widget: ${this.range.source}. Click to reveal its source.`;
    element.setAttribute('aria-label', `Synthetic formula ${this.range.source}`);
    element.addEventListener('mousedown', event => { event.preventDefault(); });
    element.addEventListener('mouseup', event => {
      event.preventDefault();
      // A real CM selection removes the replacement and exposes the source;
      // this is not a fake contenteditable or a popup made by the fixture.
      view.dispatch({ selection: { anchor: this.range.from + (this.range.source.startsWith('$') ? 1 : 2) } });
      view.focus();
    });
    return element;
  }
  ignoreEvent() { return true; }
  coordsAt(element: HTMLElement) { return element.getBoundingClientRect(); }
}

export function createVisualPreviewFixture(initialVisual = false) {
  const setMode = StateEffect.define<boolean>();
  const setParsed = StateEffect.define<boolean>();
  const mode = StateField.define<boolean>({
    create: () => initialVisual,
    update(value, transaction) { for (const effect of transaction.effects) if (effect.is(setMode)) value = effect.value; return value; },
  });
  const parsed = StateField.define<boolean>({
    create: () => true,
    update(value, transaction) { for (const effect of transaction.effects) if (effect.is(setParsed)) value = effect.value; return value; },
  });
  const trees = new WeakMap<Text, Map<boolean, SyntheticTree>>();
  function syntaxTree(state: EditorState): SyntheticTree {
    const ready = state.field(parsed, false) !== false;
    let variants = trees.get(state.doc);
    if (!variants) trees.set(state.doc, variants = new Map());
    let tree = variants.get(ready);
    if (!tree) {
      const ranges = ready ? mathRanges(state.doc) : [];
      tree = { length: ready ? state.doc.length : 0, resolveInner(position) {
        const line = state.doc.lineAt(position);
        const comment = line.text.indexOf('%');
        const fallback = (name: string): SyntheticNode => ({ name, from: line.from, to: line.to, parent: null, type: { is: () => false } });
        if (comment >= 0 && position >= line.from + comment) return fallback('Comment');
        for (const range of ranges) if (position >= range.from && position <= range.to) {
          return { name: range.source.startsWith('\\begin{') ? 'EquationEnvironment' : 'InlineMath', from: range.from, to: range.to, parent: null, type: { is: name => name === '$MathContainer' } };
        }
        return fallback('Text');
      } };
      variants.set(ready, tree);
    }
    return tree;
  }
  function decorations(state: EditorState): DecorationSet {
    if (!state.field(mode) || !state.field(parsed)) return Decoration.none;
    return Decoration.set(mathRanges(state.doc).filter(range => !state.selection.ranges.some(selection => selection.from <= range.to && selection.to >= range.from)).map(range => Decoration.replace({ widget: new SyntheticMathWidget(range), block: range.display }).range(range.from, range.to)), true);
  }
  const mathDecorations = StateField.define<DecorationSet>({
    create: decorations,
    update(value, transaction) {
      return transaction.docChanged || transaction.selection || transaction.effects.some(effect => effect.is(setMode) || effect.is(setParsed)) ? decorations(transaction.state) : value;
    },
    provide: field => EditorView.decorations.from(field),
  });
  let parseTimer: ReturnType<typeof setTimeout> | undefined;
  let typingTimer: ReturnType<typeof setTimeout> | undefined;
  let controls: HTMLElement | undefined;
  let status: HTMLElement | undefined;
  let modeButtons: HTMLButtonElement[] = [];
  const describe = (state: EditorState) => {
    const visual = state.field(mode), ready = state.field(parsed);
    if (controls) { controls.dataset.mode = visual ? 'visual' : 'code'; controls.dataset.parsed = String(ready); }
    if (status) status.textContent = `人工测试 · ${visual ? 'Visual' : 'Code'}; parser ${ready ? 'ready' : 'pending (400 ms)'}; source document and cursor unchanged by parse completion.`;
    for (const button of modeButtons) button.setAttribute('aria-pressed', String((button.dataset.mode === 'visual') === visual));
  };
  const extensions: Extension[] = [mode, parsed, mathDecorations,
    EditorView.editorAttributes.of(view => ({ class: view.state.field(mode) ? 'fixture-visual-mode ol-cm-parsed' : '' })),
    EditorView.contentAttributes.of(view => ({ 'aria-label': view.state.field(mode) ? 'Visual Editor editing' : 'Source Editor editing' })),
    EditorView.baseTheme({
      '&.fixture-visual-mode .cm-content': { padding: '14px 28px', fontFamily: 'Georgia, serif', lineHeight: '1.7' },
      '.fixture-visual-math': { background: '#edf3ef', borderRadius: '3px', padding: '0 5px', cursor: 'text', fontFamily: 'Georgia, serif', fontStyle: 'italic' },
      'div.fixture-visual-math': { padding: '16px', textAlign: 'center' },
    }),
    ViewPlugin.define(() => ({
      update(update) { if (update.transactions.some(transaction => transaction.effects.some(effect => effect.is(setMode) || effect.is(setParsed)))) describe(update.state); },
      destroy() { clearTimeout(parseTimer); clearTimeout(typingTimer); },
    })),
  ];
  function mount(view: EditorView) {
    const heading = document.querySelector('.editor-column .editor-heading > span');
    const toggle = document.createElement('span'); toggle.setAttribute('role', 'group'); toggle.setAttribute('aria-label', 'Synthetic editor mode');
    for (const visual of [false, true]) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'btn'; button.textContent = visual ? 'Visual' : 'Code'; button.dataset.mode = visual ? 'visual' : 'code';
      button.addEventListener('click', () => { view.dispatch({ effects: setMode.of(visual) }); view.focus(); });
      toggle.append(button); modeButtons.push(button);
    }
    heading?.replaceWith(toggle);
    controls = document.createElement('section'); controls.id = 'fixture-visual-controls'; controls.setAttribute('aria-label', 'Synthetic Visual preview controls');
    const help = document.createElement('p'); help.textContent = '人工测试 · Visual preview. Native-looking formula chips below are synthetic CM replacement widgets. Click one to reveal its editable source; the extension supplies the actual preview. No network or personal documents.';
    status = document.createElement('p'); status.id = 'fixture-visual-status'; status.setAttribute('role', 'status');
    const focusCustom = () => {
      const ranges = mathRanges(view.state.doc);
      const range = ranges.find(item => item.source.includes('\\RR')) ?? ranges[0];
      if (!range) return;
      view.dispatch({ selection: { anchor: range.from + 2 }, scrollIntoView: true }); view.focus();
    };
    const focus = document.createElement('button'); focus.type = 'button'; focus.className = 'btn'; focus.textContent = 'Focus custom formula'; focus.addEventListener('click', focusCustom);
    const delayed = document.createElement('button'); delayed.type = 'button'; delayed.className = 'btn'; delayed.textContent = 'Delayed parse-only update';
    delayed.addEventListener('click', () => {
      clearTimeout(parseTimer);
      focusCustom();
      view.dispatch({ effects: [setMode.of(true), setParsed.of(false)] });
      parseTimer = setTimeout(() => {
        parseTimer = undefined;
        // Crucial regression: only parser state changes, with no document or
        // selection transaction. An old docChanged-only bridge misses this.
        view.dispatch({ effects: setParsed.of(true) });
      }, 400);
    });
    const display = document.createElement('button'); display.type = 'button'; display.className = 'btn'; display.textContent = 'Add synthetic display formula';
    display.addEventListener('click', () => {
      const text = '\n\\[\\frac{1}{2} + \\RR^n\\]\n';
      const end = view.state.doc.toString().lastIndexOf('\\end{document}'); const from = end < 0 ? view.state.doc.length : end;
      view.dispatch({ changes: { from, insert: text }, selection: { anchor: from + 3 }, effects: setMode.of(true), scrollIntoView: true }); view.focus();
    });
    const typing = document.createElement('button'); typing.type = 'button'; typing.className = 'btn'; typing.textContent = 'Type near custom formula (synthetic)';
    const typingStatus = document.createElement('p'); typingStatus.id = 'fixture-visual-typing-status'; typingStatus.setAttribute('role','status');
    typing.addEventListener('click', () => {
      const original = mathRanges(view.state.doc).find(range => range.source.includes('\\cN'))?.source;
      if (!original) { typingStatus.textContent = '人工测试：当前文件没有 cN 公式。'; return; }
      typing.disabled = true; let steps = 0, covered = 0;
      const tick = () => {
        const range = mathRanges(view.state.doc).find(range => range.source === original);
        if (!range) { typingStatus.textContent = '人工测试已停止：公式源码发生变化。'; typing.disabled = false; return; }
        const from = steps % 2 ? Math.min(view.state.doc.length,range.to+1) : Math.max(0,range.from-1);
        const insert = steps % 2 ? ' more' : 'typed ';
        view.dispatch({changes:{from,insert},selection:{anchor:from+insert.length},effects:[setMode.of(true),setParsed.of(true)],scrollIntoView:true});
        // Registered after the bridge's source frame: cached supplements must
        // already be present before that frame paints, even with a new widget.
        requestAnimationFrame(() => {
          const widget = [...view.contentDOM.querySelectorAll<HTMLElement>('.ol-cm-math')].find(element => element.title.includes(original));
          const rendered = !!widget?.dataset.optVisualRendered && !!widget.querySelector('.opt-visual-math-body svg');
          steps++; if (rendered) covered++;
          typingStatus.textContent = `人工测试：${steps}/16 次公式前后输入；${covered}/${steps} 个 source frame 已渲染；公式源码保持 ${original}。`;
          if (steps < 16) typingTimer = setTimeout(tick,80);
          else { typing.disabled = false; typingTimer = undefined; }
        });
      };
      typingTimer = setTimeout(tick,0);
    });
    controls.append(help, focus, delayed, display, typing, typingStatus, status); document.getElementById('fixture-state')!.after(controls); describe(view.state);
  }
  return { extensions, syntaxTree, mount };
}
