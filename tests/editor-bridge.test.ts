// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EditorState, EditorSelection, Prec, StateEffect, StateField, Compartment, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, keymap, Decoration, WidgetType } from '@codemirror/view';
import { autocompletion, CompletionContext, type CompletionSource } from '@codemirror/autocomplete';
import { history, undo } from '@codemirror/commands';
import { isCodexSelection, type CodexSelection } from '../src/codex/types';
import { createEditorConnection } from '../src/overleaf/editor-connection';

let view: EditorView | undefined;
const events: any[] = [];
const connectionCleanups: Array<() => void> = [];
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function syntaxTree(state: EditorState) {
  return { resolveInner(position: number) {
    const text = state.doc.toString();
    const line = state.doc.lineAt(position);
    const comment = line.text.indexOf('%');
    if (comment >= 0 && position >= line.from + comment) return { name: 'Comment', parent: null, type: { is: () => false } };
    const math = /\$\$[\s\S]*?\$\$|\$[^$\n]*\$|\\\[[\s\S]*?\\\]|\\\([^\n]*?\\\)/g;
    for (const match of text.matchAll(math)) if (position >= match.index! && position <= match.index! + match[0].length) {
      return { name: 'InlineMath', from: match.index!, to: match.index! + match[0].length, parent: null, type: { is: (name: string) => name === '$MathContainer' } };
    }
    return { name: 'Text', parent: null, type: { is: () => false } };
  } };
}
const host = { EditorView, EditorSelection, Prec, StateEffect, StateField, ViewPlugin, keymap, syntaxTree };
async function makeView(text: string, position = text.length, extra: Extension[] = [], mount: HTMLElement = document.body) {
  const extensions: Extension[] = [];
  window.dispatchEvent(new CustomEvent('UNSTABLE_editor:extensions', { detail: { CodeMirror: host, extensions } }));
  const parent = document.createElement('div'); mount.append(parent);
  view = new EditorView({ parent, state: EditorState.create({ doc: text, selection: { anchor: position }, extensions: [history(), autocompletion(), ...extensions, ...extra] }) });
  await new Promise(resolve => setTimeout(resolve, 25));
  return view;
}
function configure(completion = true, preview = true) {
  window.dispatchEvent(new CustomEvent('opt:configuration', { detail: JSON.stringify({ settings: { completion, preview }, commands: [
    { name: 'pdv', source: 'physics', signature: '\\pdv{f}{x}', snippet: '\\pdv{${1:f}}{${2:x}}', preview: 'supported' },
    { name: 'RR', source: 'custom.sty', snippet: '\\RR', preview: 'supported' },
  ] }) }));
}
const source = (v: EditorView) => v.state.languageDataAt<CompletionSource>('autocomplete', v.state.selection.main.head)[0];

beforeAll(async () => {
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  window.addEventListener('opt:editor', ((event: CustomEvent<string>) => { events.push(JSON.parse(event.detail)); }) as EventListener);
  await import('../src/overleaf/editor-bridge');
});
afterEach(() => { connectionCleanups.splice(0).forEach(cleanup => cleanup()); document.dispatchEvent(new Event('pointercancel')); view?.destroy(); view = undefined; document.body.replaceChildren(); events.length = 0; vi.restoreAllMocks(); });

function connectionStatus(requestId = 'connection-test') {
  let result: { requestId: string; state: string } | undefined;
  const listener = ((event: CustomEvent<string>) => { const data = JSON.parse(event.detail); if (data.requestId === requestId) result = data; }) as EventListener;
  window.addEventListener('opt:connection-status', listener);
  window.dispatchEvent(new CustomEvent('opt:connection-request', { detail: JSON.stringify({ requestId }) }));
  window.removeEventListener('opt:connection-status', listener);
  return result;
}

function editorGeometry(v: EditorView) {
  let anchor: DOMRect | null = new DOMRect(390, 126, 1, 19);
  vi.spyOn(v, 'inView', 'get').mockReturnValue(true);
  vi.spyOn(v, 'hasFocus', 'get').mockReturnValue(true);
  vi.spyOn(v, 'coordsAtPos').mockImplementation(() => anchor);
  vi.spyOn(v.scrollDOM, 'getBoundingClientRect').mockReturnValue(new DOMRect(216, 109, 600, 487));
  // Actual CodeMirror state/plugins, explicit geometry: jsdom has no layout or
  // IntersectionObserver. Test the adapter's host read/write lifecycle.
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    queueMicrotask(() => callback(0)); return 42;
  });
  vi.spyOn(v, 'requestMeasure').mockImplementation((request: any) => {
    if (request?.read) request.write?.(request.read(v), v);
  });
  return { setAnchor: (value: DOMRect | null) => { anchor = value; } };
}
const lastGeometry = () => events.filter(event => event.type === 'geometry').at(-1);
const lastFormula = () => events.filter(event => event.type === 'formula').at(-1)?.formula;
async function measure() { window.dispatchEvent(new Event('opt:measure')); await tick(); }

function sourceTab(path = 'Sections/notes.tex') {
  const panel = document.createElement('div'); panel.id = 'ide-redesign-editor-panel';
  const tab = document.createElement('div'); tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', 'true');
  const title = document.createElement('span'); title.className = 'editor-file-tab-path'; title.textContent = '\u200e' + path;
  tab.append(title); panel.append(tab); document.body.append(panel); return panel;
}
function savedQuote(source: string, text: string, path = 'Sections/notes.tex'): CodexSelection {
  const from = source.indexOf(text), to = from + text.length;
  return { path, text, from, to, startLine: source.slice(0, from).split('\n').length,
    endLine: source.slice(0, to - 1).split('\n').length, before: source.slice(0, from), after: source.slice(to) };
}
function revealSource(selection: CodexSelection, options: { id?: string; prepared?: boolean } = {}) {
  let result: { id: string; ok: boolean; message?: string; pending?: boolean } | undefined;
  const listener = ((event: CustomEvent<string>) => { result = JSON.parse(event.detail); }) as EventListener;
  window.addEventListener('opt:reveal-source-result', listener);
  window.dispatchEvent(new CustomEvent('opt:reveal-source', { detail: JSON.stringify({ id: 'reveal-test', selection, ...options }) }));
  window.removeEventListener('opt:reveal-source-result', listener);
  return result;
}
function prepareSource(id: string, path: string) {
  let result: { id: string; ok: boolean } | undefined;
  const listener = ((event: CustomEvent<string>) => { result = JSON.parse(event.detail); }) as EventListener;
  window.addEventListener('opt:prepare-source-result', listener);
  window.dispatchEvent(new CustomEvent('opt:prepare-source', { detail: JSON.stringify({ id, path }) }));
  window.removeEventListener('opt:prepare-source-result', listener);
  return result;
}
function requestDocumentContext(id = 'complete-context') {
  let result: { id: string; ok: boolean; name?: string; text?: string; pending?: boolean } | undefined;
  const listener = ((event: CustomEvent<string>) => { result = JSON.parse(event.detail); }) as EventListener;
  window.addEventListener('opt:document-context-result', listener);
  window.dispatchEvent(new CustomEvent('opt:request-document-context', { detail: JSON.stringify({ id }) }));
  window.removeEventListener('opt:document-context-result', listener);
  return result;
}

describe('CodeMirror editor bridge', () => {
  it('verifies the current live plugin and restores a lost host compartment without touching document, selection, undo or other plugins', async () => {
    const panel = sourceTab('reconnect.tex'); configure();
    const compartment = new Compartment();
    const otherPlugin = ViewPlugin.define(() => ({ marker: 'other extension' }));
    const collect = () => {
      const extensions: Extension[] = [otherPlugin];
      window.dispatchEvent(new CustomEvent('UNSTABLE_editor:extensions', { detail: { CodeMirror: host, extensions } }));
      return extensions;
    };
    const parent = document.createElement('div'); panel.append(parent);
    const v = view = new EditorView({ parent, state: EditorState.create({ doc: '$x$', selection: { anchor: 2 }, extensions: [history(), compartment.of(collect())] }) });
    await tick(); editorGeometry(v);
    const other = v.plugin(otherPlugin);
    v.dispatch({ changes: { from: 2, insert: '+y' }, selection: { anchor: 4 } });
    const doc = v.state.doc, selection = v.state.selection;
    expect(connectionStatus()?.state).toBe('connected');
    v.dispatch({ effects: compartment.reconfigure([otherPlugin]) });
    expect(connectionStatus()?.state).toBe('detached');
    const hostReconnect = () => v.dispatch({ effects: compartment.reconfigure(collect()) });
    window.addEventListener('editor:extension-loaded', hostReconnect);
    connectionCleanups.push(() => window.removeEventListener('editor:extension-loaded', hostReconnect));
    const client = createEditorConnection(); connectionCleanups.push(client.dispose);
    await client.reconnect(); await measure();
    expect(connectionStatus()?.state).toBe('connected');
    expect(lastFormula()?.tex).toBe('x+y'); expect(lastGeometry().anchor).not.toBeNull();
    expect(v.state.doc).toBe(doc); expect(v.state.selection.eq(selection)).toBe(true);
    expect(v.plugin(otherPlugin)).toBe(other);
    expect(undo(v)).toBe(true); expect(v.state.doc.toString()).toBe('$x$');
  });
  it('does not mistake a connected hidden editor for the current source editor', async () => {
    const panel = sourceTab('active.tex'); configure();
    const old = await makeView('$old$', 3, [], panel); old.dom.parentElement!.hidden = true;
    const parent = document.createElement('div'); panel.append(parent);
    view = new EditorView({ parent, state: EditorState.create({ doc: '$current$', selection: { anchor: 4 } }) });
    try {
      expect(connectionStatus('fresh-current')).toEqual({ requestId: 'fresh-current', state: 'detached' });
      parent.hidden = true;
      expect(connectionStatus('no-editor')).toEqual({ requestId: 'no-editor', state: 'unavailable' });
    } finally { old.destroy(); }
  });
  it('restores completion and Tab placeholders after the host replaces state on the same EditorView', async () => {
    const panel = sourceTab('reset.tex'); configure();
    const compartment = new Compartment();
    const collect = () => {
      const extensions: Extension[] = [];
      window.dispatchEvent(new CustomEvent('UNSTABLE_editor:extensions', { detail: { CodeMirror: host, extensions } })); return extensions;
    };
    const parent = document.createElement('div'); panel.append(parent);
    const v = view = new EditorView({ parent, state: EditorState.create({ doc: '\\p', selection: { anchor: 2 }, extensions: [history(), compartment.of(collect())] }) });
    await tick(); expect(source(v)).toBeTypeOf('function');
    v.setState(EditorState.create({ doc: '\\p', selection: { anchor: 2 }, extensions: [history(), compartment.of([])] }));
    expect(source(v)).toBeUndefined(); expect(connectionStatus()?.state).toBe('detached');
    const hostReconnect = () => v.dispatch({ effects: compartment.reconfigure(collect()) });
    window.addEventListener('editor:extension-loaded', hostReconnect);
    connectionCleanups.push(() => window.removeEventListener('editor:extension-loaded', hostReconnect));
    const client = createEditorConnection(); connectionCleanups.push(client.dispose);
    await client.reconnect();
    const sourceCount = v.state.languageDataAt('autocomplete', 2).length;
    expect(source(v)).toBeTypeOf('function'); expect(connectionStatus()?.state).toBe('connected');
    await client.reconnect();
    expect(v.state.languageDataAt('autocomplete', 2)).toHaveLength(sourceCount);
    const result = await source(v)(new CompletionContext(v.state, 2, true));
    const option = result!.options.find(item => item.label === '\\pdv')!;
    (option.apply as Function)(v, option, 0, 2);
    expect(v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to)).toBe('f');
    v.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true, cancelable: true }));
    expect(v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to)).toBe('x');
    expect(undo(v)).toBe(true); expect(v.state.doc.toString()).toBe('\\p');
  });
  it('does not confirm a bridge whose initial editor configuration failed', async () => {
    const panel = sourceTab('initial-failure.tex'); configure();
    const extensions: Extension[] = [];
    window.dispatchEvent(new CustomEvent('UNSTABLE_editor:extensions', { detail: { CodeMirror: host, extensions } }));
    const parent = document.createElement('div'); panel.append(parent);
    const v = view = new EditorView({ parent, state: EditorState.create({ doc: '$x$', selection: { anchor: 2 }, extensions }) });
    expect(connectionStatus()?.state).toBe('detached');
    vi.spyOn(v, 'dispatch').mockImplementationOnce(() => { throw new Error('host refused configuration'); });
    await tick();
    expect(events.some(event => event.type === 'error' && event.message.includes('host refused configuration'))).toBe(true);
    expect(connectionStatus()?.state).toBe('detached');
  });
  it.each(['Source Editor editing', 'Visual Editor editing'])('returns to an exact source quote in %s without editing or replacing a composer quote', async label => {
    const panel = sourceTab(); configure();
    const text = 'before\nchosen $\\cN$ passage\nafter';
    const quote = savedQuote(text, 'chosen $\\cN$ passage');
    class FormulaWidget extends WidgetType {
      toDOM() { const span = document.createElement('span'); span.textContent = 'N'; span.setAttribute('contenteditable', 'false'); return span; }
    }
    const formulaFrom = text.indexOf('$');
    const visual = label.startsWith('Visual') ? [EditorView.decorations.of(Decoration.set([
      Decoration.replace({ widget: new FormulaWidget() }).range(formulaFrom, formulaFrom + '$\\cN$'.length),
    ]))] : [];
    const v = await makeView(text, 0, [EditorView.contentAttributes.of({ 'aria-label': label }), ...visual], panel);
    v.dispatch({ selection: { anchor: text.indexOf('after'), head: text.length } });
    const latestQuote = events.filter(event => event.type === 'selection').at(-1).selection;
    expect(latestQuote.text).toBe('after');
    const scrolling = vi.spyOn(EditorView, 'scrollIntoView');
    events.length = 0;
    expect(revealSource(quote)).toEqual({ id: 'reveal-test', ok: true });
    await tick();
    expect(v.state.selection.main).toMatchObject({ from: quote.from, to: quote.to });
    expect(v.state.doc.toString()).toBe(text);
    expect(v.contentDOM.getAttribute('aria-label')).toBe(label);
    expect(scrolling).toHaveBeenCalledWith(expect.objectContaining({ from: quote.from, to: quote.to }), { y: 'center' });
    window.dispatchEvent(new Event('opt:request-selection'));
    expect(events.filter(event => event.type === 'selection')).toHaveLength(0);
    expect(undo(v)).toBe(false);
    // Native editor actions still establish new quotes after returning.
    v.contentDOM.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    v.dispatch({ selection: { anchor: 0, head: 6 } });
    v.contentDOM.dispatchEvent(new Event('pointerup', { bubbles: true })); await tick();
    expect(events.filter(event => event.type === 'selection').at(-1).selection.text).toBe('before');
  });
  it('relocates a source quote after preceding edits using current CodeMirror coordinates', async () => {
    sourceTab(); configure();
    const original = 'before\nchosen\nafter', quote = savedQuote(original, 'chosen');
    const v = await makeView('inserted\n' + original, 0);
    expect(revealSource(quote)).toMatchObject({ ok: true });
    expect(v.state.selection.main).toMatchObject({ from: quote.from + 9, to: quote.to + 9 });
    expect(v.state.doc.toString()).toBe('inserted\n' + original);
  });
  it('reveals a multiline quote with normalized offsets in a CRLF-configured editor', async () => {
    sourceTab(); configure();
    const text = 'before\nchosen\nnext\nafter', quote = savedQuote(text, 'chosen\nnext');
    const v = await makeView(text.replaceAll('\n', '\r\n'), 0, [EditorState.lineSeparator.of('\r\n')]);
    expect(revealSource(quote)).toMatchObject({ ok: true });
    expect(v.state.selection.main).toMatchObject({ from: quote.from, to: quote.to });
    expect(v.state.doc.sliceString(quote.from, quote.to, '\n')).toBe(quote.text);
    expect(v.state.sliceDoc()).toBe(text.replaceAll('\n', '\r\n'));
  });
  it('does not select a same-name file, ambiguous duplicate, or deleted quote', async () => {
    sourceTab(); configure();
    const v = await makeView('first chosen then chosen', 3);
    const before = v.state.selection;
    const quote = savedQuote('chosen', 'chosen');
    expect(revealSource({ ...quote, path: 'Other/notes.tex' })).toMatchObject({ ok: false, message: expect.stringContaining('active editor') });
    expect(revealSource(quote)).toMatchObject({ ok: false, message: expect.stringContaining('more than once') });
    expect(revealSource(savedQuote('removed', 'removed'))).toMatchObject({ ok: false, message: expect.stringContaining('no longer present') });
    expect(v.state.selection).toBe(before);
    expect(v.state.doc.toString()).toBe('first chosen then chosen');
  });
  it('rejects invalid ranges without dispatching an editor transaction', async () => {
    sourceTab(); configure(); const v = await makeView('chosen', 0);
    const dispatch = vi.spyOn(v, 'dispatch');
    expect(revealSource({ ...savedQuote('chosen', 'chosen'), to: 100 })).toMatchObject({ ok: false });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('waits while a new tab label still belongs to the previously active source view', async () => {
    const panel = sourceTab('old.tex'); configure(); const v = await makeView('old: quoted text', 0, [], panel);
    const quote = savedQuote('new: quoted text', 'quoted text', 'new.tex');
    const request = { id: 'prepared-new-file', prepared: true };
    expect(prepareSource(request.id, quote.path)).toEqual({ id: request.id, ok: true });
    panel.querySelector('.editor-file-tab-path')!.textContent = 'new.tex';
    // This exact text exists at the same offset in both documents. Trusting
    // the label or a relabelled snapshot would select the wrong source here.
    expect(revealSource(quote, request)).toEqual({ id: request.id, ok: false, pending: true });
    expect(v.state.selection.main.empty).toBe(true);
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: 'new: quoted text' } });
    expect(revealSource(quote, request)).toEqual({ id: request.id, ok: true });
    expect(v.state.selection.main).toMatchObject({ from: quote.from, to: quote.to });
  });
  it('reveals a cached target view without waiting for another mount or document edit', async () => {
    const panel = sourceTab('old.tex'); configure();
    const first = await makeView('old: quoted text', 0, [], panel);
    const cachedMount = document.createElement('div'); cachedMount.hidden = true; panel.append(cachedMount);
    try {
      const cached = await makeView('new: quoted text', 0, [], cachedMount);
      const quote = savedQuote('new: quoted text', 'quoted text', 'new.tex');
      const request = { id: 'prepared-cached-file', prepared: true };
      expect(prepareSource(request.id, quote.path)).toMatchObject({ ok: true });
      events.length = 0;
      panel.querySelector('.editor-file-tab-path')!.textContent = 'new.tex';
      first.dom.parentElement!.hidden = true; cachedMount.hidden = false;
      const documentBefore = cached.state.doc;
      expect(revealSource(quote, request)).toEqual({ id: request.id, ok: true });
      expect(cached.state.selection.main).toMatchObject({ from: quote.from, to: quote.to });
      expect(cached.state.doc).toBe(documentBefore);
      expect(first.state.selection.main.empty).toBe(true);
      expect(events.filter(event => event.type === 'document')).toHaveLength(0);
    } finally { first.destroy(); }
  });
  it('rejects late reveal probes after preparation cancellation or expiry', async () => {
    sourceTab(); configure(); const v = await makeView('quoted text', 0);
    const quote = savedQuote('quoted text', 'quoted text');
    prepareSource('cancelled-return', quote.path);
    window.dispatchEvent(new CustomEvent('opt:cancel-source', { detail: JSON.stringify({ id: 'cancelled-return' }) }));
    expect(revealSource(quote, { id: 'cancelled-return', prepared: true })).toMatchObject({ ok: false, message: expect.stringContaining('expired') });
    prepareSource('expired-return', quote.path);
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 15_001);
    expect(revealSource(quote, { id: 'expired-return', prepared: true })).toMatchObject({ ok: false, message: expect.stringContaining('expired') });
    expect(v.state.selection.main.empty).toBe(true);
  });
  it('publishes exact multiline selection and active file path even when the file tree is closed', async () => {
    document.body.innerHTML = '<div id="ide-redesign-editor-panel"><div role="tab" aria-selected="true"><span class="editor-file-tab-path">\u200eSections/notes.tex</span></div></div>';
    configure(); const v = await makeView('before\nchosen 😀\nnext\nafter', 0);
    v.dispatch({ selection: { anchor: 7, head: 21 } });
    const selection = events.filter(event => event.type === 'selection').at(-1).selection;
    expect(selection).toEqual({path:'Sections/notes.tex', text:'chosen 😀\nnext', from:7, to:21, startLine:2, endLine:3, before:'before\n', after:'\nafter'});
    events.length = 0;
    window.dispatchEvent(new Event('opt:request-selection'));
    expect(events.filter(event => event.type === 'selection').at(-1).selection).toEqual(selection);
    window.dispatchEvent(new Event('opt:request-document-now'));
    expect(events.filter(event => event.type === 'document').at(-1)).toMatchObject({name:'Sections/notes.tex',text:v.state.doc.toString()});
  });
  it('reports empty and oversized selections without sending the oversized source', async () => {
    configure(); const v = await makeView('x'.repeat(64_001), 0);
    v.dispatch({ selection: { anchor: 0, head: 64_001 } });
    expect(events.filter(event => event.type === 'selection').at(-1)).toMatchObject({selection:null,error:'selection-too-large'});
    v.dispatch({ selection: { anchor: 4 } });
    expect(events.filter(event => event.type === 'selection').at(-1).selection).toBeNull();
  });
  it.each(['Source Editor editing', 'Visual Editor editing'])('explicitly clears a collapsed range in %s', async label => {
    configure(); const v = await makeView('before chosen after', 0, [EditorView.contentAttributes.of({ 'aria-label': label })]);
    v.dispatch({ selection: { anchor: 7, head: 13 } });
    expect(events.filter(event => event.type === 'selection').at(-1).selection.text).toBe('chosen');
    v.dispatch({ selection: { anchor: 3 } });
    expect(events.filter(event => event.type === 'selection').at(-1)).toMatchObject({ selection: null, clear: true });
  });
  it('preserves the quote during a composer focus transition even if the editor collapses its range', async () => {
    configure(); const v = await makeView('chosen passage', 0);
    const panel = document.createElement('aside'); panel.id = 'opt-codex-panel';
    const question = document.createElement('textarea'); panel.append(question); document.body.append(panel);
    v.dispatch({ selection: { anchor: 0, head: 6 } });
    question.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    // A host can emit its blur transaction before the textarea receives focus.
    v.dispatch({ selection: { anchor: 6 } });
    expect(events.filter(event => event.type === 'selection').at(-1)).toEqual({ type: 'selection', selection: null, name: '' });
    question.focus(); question.dispatchEvent(new Event('pointerup', { bubbles: true }));
    await tick(); events.length = 0;
    document.dispatchEvent(new Event('selectionchange')); await tick();
    expect(events.filter(event => event.type === 'selection')).toHaveLength(0);
  });
  it('clears a DOM-only Visual selection when it collapses without a CodeMirror transaction', async () => {
    configure(); const v = await makeView('\\textbf{chosen}', 0, [
      EditorView.contentAttributes.of({ 'aria-label': 'Visual Editor editing' }),
      EditorView.decorations.of(Decoration.set([Decoration.replace({}).range(0, 8), Decoration.replace({}).range(14, 15)])),
    ]);
    const walker = document.createTreeWalker(v.contentDOM, NodeFilter.SHOW_TEXT);
    let next: Node | null, text: Node | undefined;
    while ((next = walker.nextNode())) if (next.textContent === 'chosen') text = next;
    expect(text).toBeDefined();
    vi.spyOn(document, 'getSelection').mockReturnValue({ isCollapsed: false, anchorNode: text, focusNode: text, anchorOffset: 0, focusOffset: 6 } as unknown as Selection);
    window.dispatchEvent(new Event('opt:request-selection'));
    expect(events.filter(event => event.type === 'selection').at(-1).selection.text).toBe('chosen');
    vi.mocked(document.getSelection).mockReturnValue({ isCollapsed: true, anchorNode: text, focusNode: text, anchorOffset: 2, focusOffset: 2 } as unknown as Selection);
    document.dispatchEvent(new Event('selectionchange')); await tick();
    expect(events.filter(event => event.type === 'selection').at(-1)).toMatchObject({ selection: null, clear: true });
  });
  it('dismisses a quote after clicking outside and does not reattach stale editor state on sidebar capture', async () => {
    configure(); const v = await makeView('chosen passage', 0);
    const outside = document.createElement('button'); document.body.append(outside);
    v.dispatch({ selection: { anchor: 0, head: 6 } }); const selected = v.state.selection;
    outside.dispatchEvent(new Event('pointerdown', { bubbles: true })); outside.focus();
    outside.dispatchEvent(new Event('pointerup', { bubbles: true })); await tick();
    expect(events.filter(event => event.type === 'selection').at(-1)).toMatchObject({ selection: null, clear: true });
    window.dispatchEvent(new Event('opt:request-selection'));
    expect(events.filter(event => event.type === 'selection').at(-1)).toMatchObject({ selection: null, clear: true });
    expect(v.state.selection).toBe(selected);
    v.contentDOM.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    v.dispatch({ selection: { anchor: 7, head: 14 } });
    v.contentDOM.dispatchEvent(new Event('pointerup', { bubbles: true })); await tick();
    expect(events.filter(event => event.type === 'selection').at(-1).selection.text).toBe('passage');
  });
  it('keeps source offsets valid even when the host exports selections using CRLF', async () => {
    configure(); const v = await makeView('first\r\nsecond\r\nthird', 0, [EditorState.lineSeparator.of('\r\n')]);
    v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } });
    expect(v.state.sliceDoc(0, v.state.doc.length)).toBe('first\r\nsecond\r\nthird');
    const selection = events.filter(event => event.type === 'selection').at(-1).selection;
    expect(selection.text).toBe('first\nsecond\nthird');
    expect(selection.to - selection.from).toBe(selection.text.length);
    expect(isCodexSelection(selection)).toBe(true);
  });
  it('captures the main editor with other editors mounted and preserves it when focus moves into Codex', async () => {
    document.body.innerHTML = '<div id="ide-redesign-editor-panel"><div role="tab" aria-selected="true"><span class="editor-file-tab-path">notes.tex</span></div><div role="region" aria-label="编辑器"></div></div><button id="opt-codex-tab">Codex</button><textarea id="question"></textarea>';
    configure(); const main = await makeView('source passage', 0, [], document.querySelector<HTMLElement>('[role="region"]')!);
    try {
      const other = await makeView('auxiliary editor', 0);
      main.dispatch({ selection: { anchor: 0, head: 6 } });
      expect(events.filter(event => event.type === 'selection').at(-1).selection).toMatchObject({ path: 'notes.tex', text: 'source' });
      events.length = 0;
      document.getElementById('opt-codex-tab')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      document.getElementById('question')!.focus();
      window.dispatchEvent(new Event('opt:request-selection'));
      expect(events.filter(event => event.type === 'selection').at(-1).selection).toMatchObject({ text: 'source', from: 0, to: 6 });
      other.dispatch({ selection: { anchor: 0, head: 9 } });
      expect(events.filter(event => event.type === 'selection').at(-1).selection.text).toBe('source');
    } finally { main.destroy(); }
  });
  it('captures real LaTeX ranges when switching between Code and decorated Visual mode', async () => {
    const mode = new Compartment(); configure();
    const v = await makeView('\\textbf{chosen}', 0, [mode.of(EditorView.contentAttributes.of({ 'aria-label': 'Source Editor editing' }))]);
    v.dispatch({ selection: { anchor: 8, head: 14 } });
    const before = events.filter(event => event.type === 'selection').at(-1).selection;
    v.dispatch({ effects: mode.reconfigure([
      EditorView.contentAttributes.of({ 'aria-label': 'Visual Editor editing' }),
      EditorView.decorations.of(Decoration.set([Decoration.replace({}).range(0, 8), Decoration.replace({}).range(14, 15)])),
    ]) });
    events.length = 0; window.dispatchEvent(new Event('opt:request-selection'));
    const selected = events.filter(event => event.type === 'selection').at(-1).selection;
    expect(selected).toEqual(before); expect(selected).toMatchObject({ text: 'chosen', from: 8, to: 14, before: '\\textbf{', after: '}' });
    expect(v.contentDOM.getAttribute('aria-label')).toBe('Visual Editor editing');
    expect(isCodexSelection(selected)).toBe(true);
    v.dispatch({ effects: mode.reconfigure(EditorView.contentAttributes.of({ 'aria-label': 'Source Editor editing' })) });
    window.dispatchEvent(new Event('opt:request-selection'));
    expect(events.filter(event => event.type === 'selection').at(-1).selection).toEqual(before);
  });
  it('maps a Visual DOM selection through CodeMirror before its state selection has caught up', async () => {
    configure(); const v = await makeView('\\textbf{chosen}', 0, [
      EditorView.contentAttributes.of({ 'aria-label': 'Visual Editor editing' }),
      EditorView.decorations.of(Decoration.set([Decoration.replace({}).range(0, 8), Decoration.replace({}).range(14, 15)])),
    ]);
    const walker = document.createTreeWalker(v.contentDOM, NodeFilter.SHOW_TEXT);
    let node: Node | null, text: Node | undefined;
    while ((node = walker.nextNode())) if (node.textContent === 'chosen') text = node;
    expect(text).toBeDefined();
    vi.spyOn(document, 'getSelection').mockReturnValue({ isCollapsed: false, anchorNode: text!, focusNode: text!, anchorOffset: 1, focusOffset: 5 } as unknown as Selection);
    const original = v.state.selection;
    window.dispatchEvent(new Event('opt:request-selection'));
    const selected = events.filter(event => event.type === 'selection').at(-1).selection;
    expect(selected).toMatchObject({ text: 'hose', from: 9, to: 13, before: '\\textbf{c', after: 'n}' });
    expect(isCodexSelection(selected)).toBe(true); expect(v.state.selection).toBe(original);
  });
  it('does not invent source ranges for rendered widgets, hidden source views, or sidebar text', async () => {
    class VisualWidget extends WidgetType { toDOM() { const el = document.createElement('span'); el.contentEditable = 'false'; el.setAttribute('contenteditable', 'false'); el.textContent = 'Rendered formula'; return el; } }
    configure(); const v = await makeView('$x$', 0, [EditorView.decorations.of(Decoration.set([Decoration.replace({ widget: new VisualWidget() }).range(0, 3)]))]);
    const text = v.contentDOM.querySelector('[contenteditable="false"]')!.firstChild!;
    vi.spyOn(document, 'getSelection').mockReturnValue({ isCollapsed: false, anchorNode: text, focusNode: text, anchorOffset: 0, focusOffset: 8 } as unknown as Selection);
    window.dispatchEvent(new Event('opt:request-selection'));
    expect(events.filter(event => event.type === 'selection').at(-1).selection).toBeNull();
    const sidebar = document.createElement('textarea'); document.body.append(sidebar); sidebar.focus();
    vi.mocked(document.getSelection).mockReturnValue({ isCollapsed: false, anchorNode: sidebar, focusNode: sidebar, anchorOffset: 0, focusOffset: 1 } as unknown as Selection);
    events.length = 0; document.dispatchEvent(new Event('selectionchange')); await tick();
    expect(events.filter(event => event.type === 'selection')).toHaveLength(0);
    const panel = document.createElement('aside'); panel.id = 'opt-codex-panel'; document.body.append(panel); panel.append(sidebar); sidebar.focus();
    // Chromium can retain the old editor DOM selection while a textarea owns
    // focus. Typing/clearing a quote must not silently attach it again.
    vi.mocked(document.getSelection).mockReturnValue({ isCollapsed: false, anchorNode: text, focusNode: text, anchorOffset: 0, focusOffset: 8 } as unknown as Selection);
    document.dispatchEvent(new Event('selectionchange')); await tick();
    expect(events.filter(event => event.type === 'selection')).toHaveLength(0);
    v.dom.parentElement!.hidden = true;
    events.length = 0; window.dispatchEvent(new Event('opt:request-selection'));
    expect(events.filter(event => event.type === 'selection')).toEqual([{ type: 'selection', selection: null, name: '' }]);
  });
  it('measures a focused formula without any native popup or native preview configuration', async () => {
    configure(); const v = await makeView('$x$', 2); editorGeometry(v);
    const reposition = vi.fn(); window.addEventListener('editor:repositionAllTooltips', reposition);
    const documentBefore = v.state.doc.toString();
    const selectionBefore = v.state.selection;
    try {
      await measure();
      expect(lastGeometry()).toEqual({ type: 'geometry', formula: { tex: 'x', display: false, location: expect.stringMatching(/^\d+::0$/) }, anchor: {
        left: 390, top: 126, bottom: 145, editorTop: 109, editorBottom: 596,
        editorLeft: 216, editorRight: 816, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
      } });
      expect(v.coordsAtPos).toHaveBeenCalledWith(1);
      expect(document.querySelector('.ol-cm-math-tooltip-container')).toBeNull();
      expect(reposition).not.toHaveBeenCalled();
      expect(v.state.doc.toString()).toBe(documentBefore);
      expect(v.state.selection).toBe(selectionBefore);
    } finally { window.removeEventListener('editor:repositionAllTooltips', reposition); }
  });
  it('publishes formula edits immediately and keeps their location stable until the user changes formula', async () => {
    configure(); const v = await makeView('$x$ and $y$', 2); editorGeometry(v);
    await measure();
    const first = lastGeometry().formula.location;
    events.length = 0;
    v.dispatch({ changes: { from: 2, insert: '+z' }, selection: { anchor: 4 } });
    expect(lastFormula()).toEqual({ tex: 'x+z', display: false, location: first });
    expect(events.filter(event => event.type === 'geometry')).toHaveLength(0);
    await tick();
    expect(lastGeometry().formula).toEqual(lastFormula());
    v.dispatch({ selection: { anchor: 12 } });
    expect(lastFormula().tex).toBe('y');
    expect(lastFormula().location).not.toBe(first);
    await tick();
    expect(lastGeometry().formula.location).toBe(lastFormula().location);
  });
  it('scrolls and resizes using only geometry events without restarting rendering or publishing documents', async () => {
    configure(); const v = await makeView('$x$', 2); const geometry = editorGeometry(v);
    await measure(); events.length = 0;
    geometry.setAnchor(new DOMRect(420, 240, 1, 19));
    v.scrollDOM.dispatchEvent(new Event('scroll')); await tick();
    expect(lastGeometry().anchor.top).toBe(240);
    const afterScroll = events.length;
    window.dispatchEvent(new Event('resize')); await tick();
    expect(events.length).toBeGreaterThan(afterScroll);
    expect(lastGeometry().anchor.top).toBe(240);
    const afterResize = events.length;
    await measure();
    expect(events.length).toBeGreaterThan(afterResize);
    expect(lastGeometry().anchor.top).toBe(240);
    // CodeMirror can independently observe another viewport/layout change.
    // Each update may publish geometry, but must not restart formula rendering.
    expect(events.filter(event => event.type !== 'geometry')).toHaveLength(0);
  });
  it('anchors multiline display math at its start instead of the later caret line', async () => {
    configure(); const v = await makeView('Text $$x+\ny$$ end', 11); const geometry = editorGeometry(v);
    await measure();
    expect(lastGeometry().formula).toMatchObject({ tex: 'x+\ny', display: true });
    expect(v.coordsAtPos).toHaveBeenLastCalledWith(7);
    geometry.setAnchor(new DOMRect(390, 90, 1, 19));
    await measure();
    expect(lastGeometry().anchor).toBeNull();
  });
  it('hides a clipped or unavailable math start on every editor boundary', async () => {
    configure(); const v = await makeView('$x$', 2); const geometry = editorGeometry(v);
    for (const clipped of [
      new DOMRect(390, 108, 1, 19), new DOMRect(390, 580, 1, 19),
      new DOMRect(215, 126, 1, 19), new DOMRect(816, 126, 1, 19),
      new DOMRect(390, 126, 1, 0), null,
    ]) {
      geometry.setAnchor(clipped); await measure();
      expect(lastGeometry().formula.tex).toBe('x');
      expect(lastGeometry().anchor).toBeNull();
    }
    geometry.setAnchor(new DOMRect(216, 109, 1, 19)); await measure();
    expect(lastGeometry().anchor).not.toBeNull();
    vi.mocked(v.scrollDOM.getBoundingClientRect).mockReturnValue(new DOMRect(0, 0, 0, 0));
    await measure(); expect(lastGeometry().anchor).toBeNull();
  });
  it('clips the editor bounds to the viewport and hides blurred or offscreen views', async () => {
    configure(); const v = await makeView('$x$', 2); editorGeometry(v);
    vi.mocked(v.scrollDOM.getBoundingClientRect).mockReturnValue(new DOMRect(-50, -60, 5000, 5000));
    await measure();
    expect(lastGeometry().anchor).toMatchObject({ editorLeft: 0, editorTop: 0, editorRight: window.innerWidth, editorBottom: window.innerHeight });
    vi.spyOn(v, 'hasFocus', 'get').mockReturnValue(false); await measure();
    expect(lastGeometry().formula.tex).toBe('x');
    expect(lastGeometry().anchor).toBeNull();
    vi.spyOn(v, 'hasFocus', 'get').mockReturnValue(true);
    vi.spyOn(v, 'inView', 'get').mockReturnValue(false); await measure();
    expect(lastGeometry().anchor).toBeNull();
  });
  it('coalesces measurements and ignores queued callbacks after disabling or destroying the view', async () => {
    configure(); const v = await makeView('$x$', 2); editorGeometry(v);
    // CM's own delayed DOM/font observer may call requestMeasure() with no
    // payload. Assert our scheduled read/write request and coordinate reads,
    // rather than treating that unrelated native lifecycle work as a failure.
    const bridgeMeasurements = () => vi.mocked(v.requestMeasure).mock.calls.filter(([request]) => request !== undefined);
    const frames: FrameRequestCallback[] = [];
    vi.mocked(window.requestAnimationFrame).mockImplementation(callback => { frames.push(callback); return frames.length; });
    for (let i = 0; i < 3; i++) window.dispatchEvent(new Event('opt:measure'));
    expect(frames).toHaveLength(1);
    events.length = 0;
    configure(true, false);
    frames.shift()!(0); await tick();
    expect(lastGeometry().anchor).toBeNull();
    expect(bridgeMeasurements()).toHaveLength(0);
    expect(v.coordsAtPos).not.toHaveBeenCalled();
    configure(); frames.shift()!(0); await tick();
    expect(lastGeometry().anchor).not.toBeNull();
    expect(v.requestMeasure).toHaveBeenCalledWith(expect.objectContaining({ read: expect.any(Function), write: expect.any(Function) }));
    window.dispatchEvent(new Event('opt:measure'));
    v.destroy(); view = undefined;
    vi.mocked(v.requestMeasure).mockClear(); vi.mocked(v.coordsAtPos).mockClear();
    frames.shift()!(0); await tick();
    expect(bridgeMeasurements()).toHaveLength(0);
    expect(v.coordsAtPos).not.toHaveBeenCalled();
    expect(lastGeometry().anchor).toBeNull();
  });
  it('rejects coordinates read for a different formula before the measurement write phase', async () => {
    configure(); const v = await makeView('$x$ and $y$', 2); editorGeometry(v);
    const requests: any[] = [];
    vi.mocked(v.requestMeasure).mockImplementation((request: any) => { if (request?.read) requests.push(request); });
    await measure();
    const oldRequest = requests.shift();
    const oldResult = oldRequest.read(v);
    v.dispatch({ selection: { anchor: 10 } });
    events.length = 0;
    oldRequest.write(oldResult, v);
    expect(events.filter(event => event.type === 'geometry')).toHaveLength(0);
    await tick();
    const current = requests.at(-1);
    current.write(current.read(v), v);
    expect(lastGeometry().formula.tex).toBe('y');
    const focusedResult = current.read(v);
    vi.spyOn(v, 'hasFocus', 'get').mockReturnValue(false);
    current.write(focusedResult, v);
    expect(lastGeometry().anchor).toBeNull();
  });
  it('replays the current formula on a receiver configuration handshake', async () => {
    configure(); const v = await makeView('$x$', 2); editorGeometry(v); await measure();
    const formula = lastFormula(); events.length = 0;
    configure(); await tick();
    expect(events.filter(event => event.type === 'formula').map(event => event.formula)).toEqual([formula]);
    events.length = 0; await measure();
    expect(events.filter(event => event.type === 'formula')).toHaveLength(0);
  });
  it('discovers Visual math when background parsing completes without a source or selection change', async () => {
    const originalSyntax = host.syntaxTree;
    let parsed = false;
    const emptyTree = { resolveInner: () => ({ name: 'Text', parent: null, type: { is: () => false } }) };
    vi.spyOn(host, 'syntaxTree').mockImplementation(state => parsed ? originalSyntax(state) : emptyTree);
    configure();
    const v = await makeView('$x+\\RR$', 3, [EditorView.contentAttributes.of({ 'aria-label': 'Visual Editor editing' })]);
    editorGeometry(v); await measure();
    expect(lastFormula()).toBeNull();
    const documentBefore = v.state.doc, selectionBefore = v.state.selection;
    events.length = 0;
    parsed = true;
    // A background parser can replace its tree independently of source edits.
    v.dispatch({});
    await tick();
    expect(lastFormula()).toMatchObject({ tex: 'x+\\RR', display: false });
    expect(lastGeometry().formula).toEqual(lastFormula());
    expect(lastGeometry().anchor).not.toBeNull();
    expect(v.state.doc).toBe(documentBefore); expect(v.state.selection).toBe(selectionBefore);
    expect(events.some(event => event.type === 'document')).toBe(false);
  });
  it('publishes newly available math before its measured anchor even after a geometry-only update', async () => {
    const originalSyntax = host.syntaxTree;
    let parsed = false;
    const emptyTree = { resolveInner: () => ({ name: 'Text', parent: null, type: { is: () => false } }) };
    vi.spyOn(host, 'syntaxTree').mockImplementation(state => parsed ? originalSyntax(state) : emptyTree);
    configure(); const v = await makeView('$x$', 2); editorGeometry(v); await measure();
    parsed = true; events.length = 0;
    await measure();
    const formulaIndex = events.findIndex(event => event.type === 'formula' && event.formula?.tex === 'x');
    const geometryIndex = events.findIndex(event => event.type === 'geometry' && event.anchor);
    expect(formulaIndex).toBeGreaterThanOrEqual(0); expect(geometryIndex).toBeGreaterThan(formulaIndex);
    events.length = 0;
    await measure(); await measure();
    expect(events.filter(event => event.type === 'formula')).toHaveLength(0);
  });
  it('reanchors after a Visual widget release effect and mode switch without restarting the formula', async () => {
    const mode = new Compartment(); const release = StateEffect.define<boolean>();
    configure(); const v = await makeView('$x$', 2, [mode.of(EditorView.contentAttributes.of({ 'aria-label': 'Visual Editor editing' }))]);
    const geometry = editorGeometry(v); await measure();
    const location = lastGeometry().formula.location;
    events.length = 0; geometry.setAnchor(new DOMRect(420, 260, 1, 19));
    v.dispatch({ effects: release.of(false) }); await tick();
    expect(lastGeometry().anchor.top).toBe(260);
    expect(lastGeometry().formula.location).toBe(location);
    expect(events.filter(event => event.type === 'formula')).toHaveLength(0);
    v.dispatch({ effects: mode.reconfigure(EditorView.contentAttributes.of({ 'aria-label': 'Source Editor editing' })) });
    await tick();
    expect(lastGeometry().formula.location).toBe(location);
    expect(events.filter(event => event.type === 'formula')).toHaveLength(0);
    expect(events.filter(event => event.type === 'document')).toHaveLength(0);
  });
  it('refreshes a revealed Visual formula after native pointer handling and hides it when disabled', async () => {
    const originalSyntax = host.syntaxTree;
    let parsed = false;
    const emptyTree = { resolveInner: () => ({ name: 'Text', parent: null, type: { is: () => false } }) };
    vi.spyOn(host, 'syntaxTree').mockImplementation(state => parsed ? originalSyntax(state) : emptyTree);
    configure(); const v = await makeView('$x$', 2); editorGeometry(v); await measure();
    parsed = true; events.length = 0;
    v.contentDOM.dispatchEvent(new Event('pointerup', { bubbles: true }));
    await tick(); await tick();
    expect(lastFormula()).toMatchObject({ tex: 'x' }); expect(lastGeometry().anchor).not.toBeNull();
    configure(true, false); await tick();
    expect(lastFormula()).toBeNull(); expect(lastGeometry().anchor).toBeNull();
  });
  it('publishes document snapshots initially and on edits or explicit request, but not on reconfiguration', async () => {
    document.body.innerHTML = '<aside role="tabpanel"><button role="treeitem" aria-selected="true" aria-label="main.tex">main.tex</button></aside>';
    configure(); const v = await makeView('$x$', 2);
    await new Promise(resolve => setTimeout(resolve, 460));
    expect(events.filter(event => event.type === 'document')).toEqual([{ type: 'document', name: 'main.tex', text: '$x$', sourceReady: true }]);
    events.length = 0;
    configure(); configure(true, false);
    await new Promise(resolve => setTimeout(resolve, 460));
    expect(events.filter(event => event.type === 'document')).toHaveLength(0);
    window.dispatchEvent(new Event('opt:request-document'));
    await new Promise(resolve => setTimeout(resolve, 460));
    expect(events.filter(event => event.type === 'document')).toEqual([{ type: 'document', name: 'main.tex', text: '$x$' }]);
    events.length = 0;
    window.dispatchEvent(new Event('opt:request-document-now'));
    expect(events.filter(event => event.type === 'document')).toEqual([{ type: 'document', name: 'main.tex', text: '$x$' }]);
    events.length = 0;
    v.dispatch({ changes: { from: 1, to: 2, insert: 'y' } });
    // A snapshot request arriving during the pending natural edit cannot erase
    // its readiness marker and strand cross-file quote navigation.
    window.dispatchEvent(new Event('opt:request-document'));
    await new Promise(resolve => setTimeout(resolve, 460));
    expect(events.filter(event => event.type === 'document')).toEqual([{ type: 'document', name: 'main.tex', text: '$y$', sourceReady: true }]);
  });
  it('does not mark an old source snapshot as loaded when the target tab activates first', async () => {
    const panel = sourceTab('old.tex'); configure(); await makeView('old source', 0, [], panel);
    panel.querySelector('.editor-file-tab-path')!.textContent = 'new.tex';
    events.length = 0;
    window.dispatchEvent(new Event('opt:request-document-now'));
    window.dispatchEvent(new Event('opt:request-document'));
    await new Promise(resolve => setTimeout(resolve, 460));
    const snapshots = events.filter(event => event.type === 'document');
    expect(snapshots).toHaveLength(2);
    expect(snapshots.every(snapshot => snapshot.name === 'new.tex' && snapshot.sourceReady !== true)).toBe(true);
  });
  it.each(['Source Editor editing', 'Visual Editor editing'])('captures proven complete source and immediate typing in %s', async label => {
    const panel = sourceTab('capture-source.tex'); configure();
    const v = await makeView('before $\\cN$ after', 0, [EditorView.contentAttributes.of({ 'aria-label': label })], panel);
    await new Promise(resolve => setTimeout(resolve, 460));
    const before = v.state.doc;
    expect(requestDocumentContext('full-1')).toEqual({ id: 'full-1', ok: true, name: 'capture-source.tex', text: 'before $\\cN$ after' });
    expect(v.state.doc).toBe(before);
    v.dispatch({ changes: { from: v.state.doc.length, insert: ' typed now' } });
    // Do not force a 450ms wait after ordinary keystrokes in a proven file.
    expect(requestDocumentContext('full-2')).toMatchObject({ id: 'full-2', ok: true, text: 'before $\\cN$ after typed now' });
  });
  it('binds the initial source when the first file identity mounts after CodeMirror', async () => {
    configure(); const v = await makeView('late initial complete source', 0);
    expect(requestDocumentContext()).toMatchObject({ ok: false, pending: true });
    const tab = sourceTab('late-initial.tex');
    // This matches the live harness order: CM and its mount microtask already
    // ran before the native tab/file tree supplied the first filename.
    window.dispatchEvent(new Event('opt:request-document'));
    expect(requestDocumentContext()).toMatchObject({ ok: true, name: 'late-initial.tex', text: 'late initial complete source' });
    tab.querySelector('.editor-file-tab-path')!.textContent = 'not-the-initial-file.tex';
    expect(requestDocumentContext()).toMatchObject({ ok: false, pending: true });
    expect(v.state.doc.toString()).toBe('late initial complete source');
  });
  it('does not late-bind the initial source after a native file switch started', async () => {
    configure(); await makeView('old initial complete source', 0);
    const panel = sourceTab('initial-before-switch.tex');
    const first = panel.querySelector<HTMLElement>('[role="tab"]')!;
    const target = document.createElement('button'); target.setAttribute('role', 'tab'); target.setAttribute('aria-selected', 'false');
    target.innerHTML = '<span class="editor-file-tab-path">initial-after-switch.tex</span>'; panel.append(target);
    target.onclick = () => { first.setAttribute('aria-selected', 'false'); target.setAttribute('aria-selected', 'true'); };
    target.click();
    expect(requestDocumentContext()).toMatchObject({ ok: false, pending: true });
  });
  it('refuses mislabeled old content until a native file switch really replaces the document', async () => {
    const panel = sourceTab('capture-old.tex'); configure(); const v = await makeView('old private source', 0, [], panel);
    await new Promise(resolve => setTimeout(resolve, 460));
    const oldTab = panel.querySelector<HTMLElement>('[role="tab"]')!;
    const target = document.createElement('div'); target.setAttribute('role', 'tab'); target.setAttribute('aria-selected', 'false');
    target.innerHTML = '<span class="editor-file-tab-path">capture-new.tex</span>'; panel.append(target);
    target.onclick = () => { oldTab.setAttribute('aria-selected', 'false'); target.setAttribute('aria-selected', 'true'); };
    target.click();
    window.dispatchEvent(new Event('opt:request-document-now'));
    expect(requestDocumentContext()).toMatchObject({ ok: false, pending: true });
    expect(requestDocumentContext()?.text).toBeUndefined();
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: 'new complete source' } });
    expect(requestDocumentContext()).toMatchObject({ ok: true, name: 'capture-new.tex', text: 'new complete source' });
  });
  it('captures cached native views without relying on mount or edit publications', async () => {
    const panel = sourceTab('capture-first.tex'); configure(); const first = await makeView('first complete source', 0, [], panel);
    await new Promise(resolve => setTimeout(resolve, 460));
    const firstTab = panel.querySelector<HTMLElement>('[role="tab"]')!;
    const cachedMount = document.createElement('div'); cachedMount.hidden = true; panel.append(cachedMount);
    try {
      await makeView('cached complete source', 0, [], cachedMount);
      const target = document.createElement('div'); target.setAttribute('role', 'tab'); target.setAttribute('aria-selected', 'false');
      target.innerHTML = '<span class="editor-file-tab-path">capture-cached.tex</span>'; panel.append(target);
      target.onclick = () => {
        firstTab.setAttribute('aria-selected', 'false'); target.setAttribute('aria-selected', 'true');
        first.dom.hidden = true; cachedMount.hidden = false;
      };
      events.length = 0; target.click();
      expect(requestDocumentContext()).toMatchObject({ ok: true, name: 'capture-cached.tex', text: 'cached complete source' });
      expect(events.filter(event => event.type === 'document')).toHaveLength(0);
      firstTab.onclick = () => {
        target.setAttribute('aria-selected', 'false'); firstTab.setAttribute('aria-selected', 'true');
        first.dom.hidden = false; cachedMount.hidden = true;
      };
      firstTab.click();
      expect(requestDocumentContext()).toMatchObject({ ok: true, name: 'capture-first.tex', text: 'first complete source' });
    } finally { first.destroy(); }
  });
  it('remembers a revealed cached view before the user asks after the switch window expires', async () => {
    const panel = sourceTab('settle-first.tex'); configure(); const first = await makeView('first source', 0, [], panel);
    const firstTab = panel.querySelector<HTMLElement>('[role="tab"]')!;
    firstTab.dataset.tabId = 'settle-first';
    const cachedMount = document.createElement('div'); cachedMount.hidden = true; panel.append(cachedMount);
    try {
      await makeView('cached source', 0, [], cachedMount);
      const target = document.createElement('div'); target.setAttribute('role', 'tab'); target.setAttribute('aria-selected', 'false');
      target.dataset.tabId = 'settle-cached';
      target.innerHTML = '<span class="editor-file-tab-path">settle-cached.tex</span>'; panel.append(target);
      target.onclick = () => {
        firstTab.setAttribute('aria-selected', 'false'); target.setAttribute('aria-selected', 'true');
        first.dom.hidden = true; cachedMount.hidden = false;
      };
      target.click();
      // No context request, mount or docChanged event occurs while this native
      // cached view becomes visible. The question is typed much later.
      await tick();
      const later = Date.now() + 16_000; vi.spyOn(Date, 'now').mockReturnValue(later);
      expect(requestDocumentContext()).toMatchObject({ ok: true, name: 'settle-cached.tex', text: 'cached source' });
    } finally { first.destroy(); }
  });
  it('does not settle a tab label onto the old document while its source is still loading', async () => {
    const panel = sourceTab('settle-old.tex'); configure(); await makeView('private old content', 0, [], panel);
    const firstTab = panel.querySelector<HTMLElement>('[role="tab"]')!;
    const target = document.createElement('div'); target.setAttribute('role', 'tab'); target.setAttribute('aria-selected', 'false');
    target.innerHTML = '<span class="editor-file-tab-path">settle-new.tex</span>'; panel.append(target);
    target.onclick = () => { firstTab.setAttribute('aria-selected', 'false'); target.setAttribute('aria-selected', 'true'); };
    target.click(); await tick();
    expect(requestDocumentContext()).toMatchObject({ ok: false, pending: true });
    expect(requestDocumentContext()?.text).toBeUndefined();
  });
  it('requires native document identity when two tab labels happen to be identical', async () => {
    const panel = sourceTab('same-name.tex'); const tab = panel.querySelector<HTMLElement>('[role="tab"]')!; tab.dataset.tabId = 'old-file';
    configure(); await makeView('old file content', 0, [], panel); await new Promise(resolve => setTimeout(resolve, 460));
    tab.dataset.tabId = 'new-file';
    expect(requestDocumentContext()).toMatchObject({ ok: false, pending: true });
    tab.dataset.tabId = 'old-file'; tab.querySelector('.editor-file-tab-path')!.textContent = 'renamed.tex';
    expect(requestDocumentContext()).toMatchObject({ ok: true, name: 'renamed.tex', text: 'old file content' });
  });
  it('adds a native autocomplete source without replacing other editor extensions', async () => {
    configure(); const v = await makeView('\\p');
    const result = await source(v)(new CompletionContext(v.state, v.state.doc.length, true));
    expect(result?.options.map(option => option.label)).toContain('\\pdv');
    expect(result?.options.find(option => option.label === '\\RR')?.detail).toBe('custom.sty');
    expect(events.some(event => event.type === 'ready')).toBe(true);
  });
  it('inserts a parameter template, advances Tab, and supports ordinary undo', async () => {
    configure(); const v = await makeView('\\p');
    const result = await source(v)(new CompletionContext(v.state, 2, true));
    const option = result!.options.find(item => item.label === '\\pdv')!;
    (option.apply as Function)(v, option, 0, 2);
    expect(v.state.doc.toString()).toBe('\\pdv{f}{x}');
    expect(v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to)).toBe('f');
    v.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true, cancelable: true }));
    expect(v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to)).toBe('x');
    expect(undo(v)).toBe(true);
    expect(v.state.doc.toString()).toBe('\\p');
  });
  it('does not complete in comments and respects its own disable switch', async () => {
    configure(); const v = await makeView('% \\p');
    expect(await source(v)(new CompletionContext(v.state, 4, true))).toBeNull();
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: '\\p' }, selection: { anchor: 2 } });
    configure(false);
    expect(await source(v)(new CompletionContext(v.state, 2, true))).toBeNull();
  });
  it('publishes the clicked formula but clears it when selection leaves math', async () => {
    configure(); const v = await makeView('Text $\\RR + x$ end', 9);
    expect(events.filter(event => event.type === 'formula').at(-1)?.formula).toEqual({ tex: '\\RR + x', display: false, location: expect.any(String) });
    v.dispatch({ selection: { anchor: 1 } });
    expect(events.filter(event => event.type === 'formula').at(-1)?.formula).toBeNull();
    v.dispatch({ selection: { anchor: 9 } });
    configure(true, false);
    expect(events.filter(event => event.type === 'formula').at(-1)?.formula).toBeNull();
  });
  it('does not publish a document or formula from an ambiguous pair of editors', async () => {
    document.body.innerHTML = '<aside role="tabpanel"><button role="treeitem" aria-selected="true" aria-label="main.tex">main.tex</button></aside>';
    configure();
    const first = await makeView('$x$', 2);
    try {
      await makeView('$y$', 2);
      configure();
      await new Promise(resolve => setTimeout(resolve, 480));
      expect(events.filter(event => event.type === 'document')).toHaveLength(0);
      expect(events.filter(event => event.type === 'formula').at(-1)?.formula).toBeNull();
      expect(lastGeometry().anchor).toBeNull();
    } finally { first.destroy(); }
  });
});
