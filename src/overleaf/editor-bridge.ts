import type { CommandEntry, Settings } from '../core/types';
import { isCodexSelection, sourcePath } from '../codex/types';
import { expandSnippet } from './snippet';
import { mountVisualMathBridge } from './visual-math-bridge';
import { resolveSourceLocation } from './source-location';
import { selectedSourcePath, sourceTabPath, sourceTabs, sourceTreeEntity, sourceTreeItems, sourceTreePath } from './source-path';

// Runs in MAIN world, using the host's CodeMirror instances. Never bundle a second CM runtime.
type Host = Record<string, any>;
const OUT = 'opt:editor';
const IN = 'opt:configuration';
let commands: CommandEntry[] = [];
let settings: Partial<Settings> = {};
let cm: Host;
const views = new Set<any>();
const bridgePlugins = new WeakMap<object, { plugin: any; ready: boolean }>();
const visualBridges = new Map<any, ReturnType<typeof mountVisualMathBridge>>();
const configurationMarkers = new WeakMap<object, any>();
let sequence = 0;
let publishedFormula: string | undefined;
const publishTimers = new WeakMap<object, ReturnType<typeof setTimeout>>();
const pendingDocuments = new WeakMap<object, { name: string; sourceReady: boolean; doc: object; fileId: string }>();
type DocumentOwner = { path: string; fileId: string };
const documentOwners = new WeakMap<object, DocumentOwner>();
const initialSourceDocuments = new WeakMap<object, { doc: object; path: string; fileId: string; generation: number }>();
let nativeSourceGeneration = 0;
let contextTransition: { path: string; fileId: string; view: any; doc: any; expires: number } | undefined;
let contextTransitionTimer: ReturnType<typeof setTimeout> | undefined;
const sessions = new WeakMap<object, { ranges: { from: number; to: number }[]; current: number }>();
const geometryFrames = new WeakMap<object, { id: number }>();
const geometryMeasureKeys = new WeakMap<object, object>();
const viewIds = new WeakMap<object, number>();
let nextViewId = 0;
let lastFocusedView: any | undefined;
let lastFocusedPath = '';
let selectionTimer: ReturnType<typeof setTimeout> | undefined;
// A click away dismisses the draft quote, but must not rewrite CodeMirror's
// selection. Keep that old range from being reattached by a later sidebar read.
const dismissedSelections = new WeakSet<object>();
// Returning to a historical quote is navigation, not a fresh composer quote.
// Keep its native selection visible until the next deliberate editor action.
const navigationSelections = new WeakSet<object>();
// A native tab may reactivate a cached view without a new mount or docChanged
// transaction. Correlate cross-file reveals with the actual view/document that
// was active before the click, rather than trusting the tab label alone.
const sourcePreparations = new Map<string, { path: string; view: any; doc: any; expires: number }>();
let assistantPointer = false;
let outsidePointer = false;
type Formula = { tex: string; display: boolean; location: string };
type PreviewAnchor = {
  left: number; top: number; bottom: number;
  editorTop: number; editorBottom: number; editorLeft: number; editorRight: number;
  viewportWidth: number; viewportHeight: number;
};
type Geometry = { formula: Formula | null; anchor: PreviewAnchor | null };

function send(payload: unknown) {
  window.dispatchEvent(new CustomEvent(OUT, { detail: JSON.stringify(payload) }));
}

function selectedFilename(): string {
  return selectedSourcePath();
}

function visibleEditor(dom: HTMLElement): boolean {
  if (!dom.isConnected || dom.closest('[hidden],[aria-hidden="true"]')) return false;
  for (let node: HTMLElement | null = dom; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  }
  return true;
}
function visibleView(view: any): boolean { return visibleEditor(view.dom); }

/** Discover the host surface independently of our registry: a lost bridge is
 * precisely the case where the current editor is absent from `views`. */
function connectionState(): 'connected' | 'detached' | 'unavailable' {
  const editors = [...document.querySelectorAll<HTMLElement>('.cm-editor')].filter(visibleEditor);
  const topLevel = editors.filter(editor => !editors.some(other => other !== editor && other.contains(editor)));
  const main = topLevel.filter(editor => editor.closest('#ide-redesign-editor-panel'));
  const candidates = main.length ? main : topLevel;
  const focused = candidates.filter(editor => editor.contains(document.activeElement));
  const surface = focused.length === 1 ? focused[0] : candidates.length === 1 ? candidates[0] : undefined;
  if (!surface) return 'unavailable';
  const view = [...views].find(candidate => candidate.dom === surface);
  const bridge = view && bridgePlugins.get(view);
  try { return view && bridge?.ready && view.plugin(bridge.plugin) ? 'connected' : 'detached'; }
  catch { return 'detached'; }
}

window.addEventListener('opt:connection-request', ((event: CustomEvent<unknown>) => {
  if (typeof event.detail !== 'string' || event.detail.length > 200) return;
  try {
    const data = JSON.parse(event.detail);
    if (!data || typeof data.requestId !== 'string' || !/^[\w.-]{1,100}$/.test(data.requestId)) return;
    window.dispatchEvent(new CustomEvent('opt:connection-status', { detail: JSON.stringify({ requestId: data.requestId, state: connectionState() }) }));
  } catch { /* Ignore malformed page messages. */ }
}) as EventListener);

function activeView(): any | undefined {
  const connected = [...views].filter(visibleView);
  // Ignore auxiliary/diff editors and nested widget editors when a main editor
  // exists. Accessible labels are translated and are not stable identifiers.
  const main = connected.filter(view => view.dom.closest('#ide-redesign-editor-panel')
    && !connected.some(other => other !== view && other.dom.contains(view.dom)));
  const candidates = main.length ? main : connected;
  const focused = candidates.filter(view => view.hasFocus || view.contentDOM?.contains(document.activeElement));
  if (focused.length === 1) {
    lastFocusedView = focused[0]; lastFocusedPath = selectedFilename(); return focused[0];
  }
  if (candidates.length === 1) return candidates[0];
  // The sidebar takes focus while the same source selection stays attached.
  if (candidates.includes(lastFocusedView) && lastFocusedPath === selectedFilename()) return lastFocusedView;
  return undefined;
}

function selectedDocumentId(): string {
  return sourceTabs().find(tab => tab.getAttribute('aria-selected') === 'true')?.dataset.tabId
    || sourceTreeItems().map(item => item.getAttribute('aria-selected') === 'true' ? sourceTreeEntity(item) : undefined)
      .find(entity => entity?.dataset.fileType === 'doc')?.dataset.fileId || '';
}

function matchesOwner(owner: DocumentOwner | undefined, path: string, fileId: string): boolean {
  return !!owner && (owner.fileId && fileId ? owner.fileId === fileId : owner.path === path);
}

function rememberDocument(view: any, path: string, fileId = selectedDocumentId()): boolean {
  const previous = documentOwners.get(view.state.doc);
  if (previous && !matchesOwner(previous, path, fileId)) return false;
  documentOwners.set(view.state.doc, { path, fileId });
  return true;
}

function initialDocumentMatches(view: any, doc: object, path: string, fileId: string): boolean {
  const initial = initialSourceDocuments.get(view);
  if (!initial || initial.doc !== doc || initial.generation !== nativeSourceGeneration || !sourcePath(path)) return false;
  // Some hosts create CM before mounting their first file tab/tree. Preserve
  // this initial document's first identity; do not adopt later tab labels.
  if (!initial.path) { initial.path = path; initial.fileId = fileId; }
  return matchesOwner(initial, path, fileId);
}

function publishDocument(view: any, sourceReady = false) {
  if(activeView()!==view)return;
  const name=selectedFilename();
  if(!name)return;
  const previous = pendingDocuments.get(view);
  // A manual snapshot may coalesce with a real mount/edit, but must never by
  // itself claim that a just-activated tab has loaded its source document.
  const fileId = selectedDocumentId();
  if (initialDocumentMatches(view, view.state.doc, name, fileId)) rememberDocument(view, name, fileId);
  const pending = { name, doc: view.state.doc, fileId,
    sourceReady: sourceReady || !!previous?.sourceReady && previous.name === name && previous.doc === view.state.doc && previous.fileId === fileId };
  pendingDocuments.set(view, pending);
  clearTimeout(publishTimers.get(view));
  publishTimers.set(view,setTimeout(() => {
    pendingDocuments.delete(view);
    if (activeView()!==view || name!==selectedFilename() || pending.doc!==view.state.doc || fileId!==selectedDocumentId() || view.state.doc.length > 2_000_000) return;
    if (pending.sourceReady) rememberDocument(view, name, fileId);
    send({ type: 'document', name, text: view.state.doc.toString(), ...(pending.sourceReady ? { sourceReady: true } : {}) });
  }, 450));
}

function assistantOwnsInteraction(): boolean {
  return assistantPointer || !!document.activeElement?.closest('#opt-codex-panel');
}

function publishSelection(view: any, allowDOMSelection = false, clearEmpty = false) {
  if (activeView() !== view || navigationSelections.has(view)) return;
  let range = view.state.selection.main;
  const path = selectedFilename();
  if (dismissedSelections.has(view)) {
    send({ type: 'selection', selection: null, name: path, clear: true }); return;
  }
  if (range.empty && allowDOMSelection) {
    // Code and LaTeX Visual mode share the same CM source document. A browser
    // selection can arrive before CM's selection transaction; map both DOM
    // endpoints with its public API instead of treating rendered text as TeX.
    const selection = document.getSelection();
    const textEndpoint = (node: Node | null) => {
      const element = node?.nodeType === Node.ELEMENT_NODE ? node as Element : node?.parentElement;
      return !!node && view.contentDOM?.contains(node) && element?.closest('.cm-editor') === view.dom
        && !element?.closest('[contenteditable="false"]');
    };
    if (selection && !selection.isCollapsed && textEndpoint(selection.anchorNode) && textEndpoint(selection.focusNode)) {
      try {
        const anchor = view.posAtDOM(selection.anchorNode, selection.anchorOffset);
        const head = view.posAtDOM(selection.focusNode, selection.focusOffset);
        range = { from: Math.min(anchor, head), to: Math.max(anchor, head), empty: anchor === head };
      } catch { /* Non-source widgets cannot provide an exact source range. */ }
    }
  }
  if (!Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to) || range.from < 0 || range.to < range.from || range.to > view.state.doc.length) {
    send({ type: 'selection', selection: null, name: path, error: 'selection-unavailable' }); return;
  }
  if (range.empty) {
    send({ type: 'selection', selection: null, name: path, ...(clearEmpty && !assistantOwnsInteraction() ? { clear: true } : {}) }); return;
  }
  if (range.to - range.from > 64_000) { send({ type: 'selection', selection: null, error: 'selection-too-large' }); return; }
  // CM offsets count one character per line break. state.sliceDoc can instead
  // use a configured CRLF separator, violating the cross-world range contract.
  const slice = (from: number, to: number) => view.state.doc.sliceString(from, to, '\n');
  send({ type: 'selection', selection: {
    path, text: slice(range.from, range.to), from: range.from, to: range.to,
    startLine: view.state.doc.lineAt(range.from).number,
    endLine: view.state.doc.lineAt(Math.max(range.from, range.to - 1)).number,
    before: slice(Math.max(0, range.from - 8000), range.from),
    after: slice(range.to, Math.min(view.state.doc.length, range.to + 8000)),
  } });
}

function captureSelection(clearEmpty = false) {
  const active = activeView();
  if (active) publishSelection(active, true, clearEmpty);
  else send({ type: 'selection', selection: null, name: selectedFilename() });
}

function sourceRequest(event: CustomEvent<string>): any | undefined {
  if (typeof event.detail !== 'string' || event.detail.length > 1_000_000) return;
  let data: any;
  try { data = JSON.parse(event.detail); } catch { return; }
  if (!data || typeof data.id !== 'string' || !/^[\w.:-]{1,120}$/.test(data.id)) return;
  return data;
}

// Capture before the native handlers change the tab label or restore a cached
// EditorState. This is the same view/doc identity guard used by quote returns.
function observeNativeFileSwitch(event: Event) {
  if (event instanceof KeyboardEvent && !['Enter', ' '].includes(event.key)) return;
  if (event instanceof MouseEvent && event.button !== 0) return;
  if (!(event.target instanceof Element)) return;
  const tab = event.target.closest('[role="tab"]');
  const item = event.target.closest('[role="treeitem"]');
  const entity = item ? sourceTreeEntity(item) : undefined;
  const path = tab?.querySelector('.editor-file-tab-path') ? sourceTabPath(tab)
    : entity?.dataset.fileType === 'doc' ? sourceTreePath(item!) : '';
  if (!sourcePath(path) || path === selectedFilename()) return;
  nativeSourceGeneration++;
  const view = activeView();
  beginContextTransition(path, tab?.getAttribute('data-tab-id') || entity?.dataset.fileId || '', view);
}
document.addEventListener('pointerdown', observeNativeFileSwitch, true);
document.addEventListener('click', observeNativeFileSwitch, true);
document.addEventListener('keydown', observeNativeFileSwitch, true);

function verifyContextDocument(view: any, name: string, fileId: string): boolean {
  if (!view || !sourcePath(name)) return false;
  let verified = matchesOwner(documentOwners.get(view.state.doc), name, fileId);
  if (!verified && initialDocumentMatches(view, view.state.doc, name, fileId)) verified = rememberDocument(view, name, fileId);
  if (!verified && !documentOwners.has(view.state.doc) && contextTransition
    && contextTransition.expires > Date.now() && contextTransition.path === name
    && (!contextTransition.fileId || !fileId || contextTransition.fileId === fileId)
    && (contextTransition.view !== view || contextTransition.doc !== view.state.doc)) {
    verified = rememberDocument(view, name, fileId);
  }
  return verified;
}

function beginContextTransition(path: string, fileId: string, view: any) {
  const transition = { path, fileId, view, doc: view?.state.doc, expires: Date.now() + 15_000 };
  contextTransition = transition;
  clearTimeout(contextTransitionTimer);
  // Revealing a cached native view may produce no mount/docChanged event.
  // Bind its proven identity while the switch is observable, not only when a
  // later question happens to request context within this short window.
  const settle = () => {
    contextTransitionTimer = undefined;
    if (contextTransition !== transition || transition.expires <= Date.now()) return;
    const name = selectedFilename(), id = selectedDocumentId();
    if (name === path && (!fileId || !id || id === fileId)
      && verifyContextDocument(activeView(), name, id)) return;
    // Navigation away destroyed the native source surface; no work remains.
    if (!sourceTabs().length && !sourceTreeItems().length) return;
    contextTransitionTimer = setTimeout(settle, 100);
  };
  // The native click/keyboard handler must first restore its tab and view.
  contextTransitionTimer = setTimeout(settle, 0);
}

window.addEventListener('opt:request-document-context', ((event: CustomEvent<string>) => {
  const data = sourceRequest(event); if (!data) return;
  const view = activeView(), name = selectedFilename(), fileId = selectedDocumentId();
  const ready = verifyContextDocument(view, name, fileId) && view.state.doc.length <= 2_000_000;
  window.dispatchEvent(new CustomEvent('opt:document-context-result', { detail: JSON.stringify(ready
    ? { id: data.id, ok: true, name, text: view.state.doc.toString() }
    : { id: data.id, ok: false, pending: true, message: 'The current editor document has not finished switching. Wait briefly and try again.' }) }));
}) as EventListener);

window.addEventListener('opt:prepare-source', ((event: CustomEvent<string>) => {
  const data = sourceRequest(event); if (!data) return;
  const valid = sourcePath(data.path);
  if (valid) {
    if (data.path !== selectedFilename()) nativeSourceGeneration++;
    const now = Date.now();
    for (const [id, entry] of sourcePreparations) if (entry.expires <= now) sourcePreparations.delete(id);
    while (sourcePreparations.size >= 16) sourcePreparations.delete(sourcePreparations.keys().next().value!);
    const view = activeView();
    sourcePreparations.set(data.id, { path: data.path, view, doc: view?.state.doc, expires: now + 15_000 });
    beginContextTransition(data.path, '', view);
  }
  window.dispatchEvent(new CustomEvent('opt:prepare-source-result', {
    detail: JSON.stringify({ id: data.id, ok: valid, ...(!valid ? { message: 'This quote does not contain a valid source file.' } : {}) }),
  }));
}) as EventListener);

window.addEventListener('opt:cancel-source', ((event: CustomEvent<string>) => {
  const data = sourceRequest(event); if (data) sourcePreparations.delete(data.id);
}) as EventListener);

window.addEventListener('opt:reveal-source', ((event: CustomEvent<string>) => {
  const data = sourceRequest(event); if (!data) return;
  const reply = (ok: boolean, message?: string, pending = false) => {
    if (!pending) sourcePreparations.delete(data.id);
    window.dispatchEvent(new CustomEvent('opt:reveal-source-result', {
      detail: JSON.stringify({ id: data.id, ok, ...(message ? { message } : {}), ...(pending ? { pending: true } : {}) }),
    }));
  };
  if (!isCodexSelection(data.selection) || !data.selection.path) {
    reply(false, 'This quote does not contain a valid source location.'); return;
  }
  const view = activeView();
  if (data.prepared === true) {
    const preparation = sourcePreparations.get(data.id);
    if (!preparation || preparation.expires <= Date.now() || preparation.path !== data.selection.path) {
      reply(false, 'This source navigation expired. Try returning to the quote again.'); return;
    }
    if (!view || selectedFilename() !== preparation.path
      || view === preparation.view && view.state.doc === preparation.doc) {
      reply(false, undefined, true); return;
    }
  }
  if (!view || !cm?.EditorSelection?.single) { reply(false, 'The source editor is not ready.'); return; }
  if (selectedFilename() !== data.selection.path) {
    reply(false, 'The quoted source file is not the active editor.'); return;
  }
  if (view.state.doc.length > 2_000_000) { reply(false, 'This source file is too large to locate safely.'); return; }
  const source = view.state.doc.sliceString(0, view.state.doc.length, '\n');
  const location = resolveSourceLocation(source, data.selection);
  if (!location.ok) {
    reply(false, location.reason === 'ambiguous'
      ? 'This passage occurs more than once and its original position could not be identified.'
      : 'The quoted passage is no longer present in this file.');
    return;
  }
  try {
    if (data.prepared === true) rememberDocument(view, data.selection.path);
    const selection = cm.EditorSelection.single(location.from, location.to);
    clearTimeout(selectionTimer); selectionTimer = undefined;
    navigationSelections.add(view);
    const transaction: any = { selection, userEvent: 'select.opt-reveal' };
    if (cm.EditorView?.scrollIntoView) transaction.effects = cm.EditorView.scrollIntoView(selection.main, { y: 'center' });
    else transaction.scrollIntoView = true;
    // Both Code and Visual use the same source positions. Native selection
    // reveals the passage, including formula widgets, without changing mode
    // or inserting DOM wrappers into the host-managed document.
    view.dispatch(transaction);
    view.focus();
    reply(true);
  } catch {
    navigationSelections.delete(view);
    reply(false, 'The editor could not reveal this passage.');
  }
}) as EventListener);

function scheduleSelection() {
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(() => {
    selectionTimer = undefined;
    if (!assistantOwnsInteraction()) {
      captureSelection(true);
      // Visual widgets reveal source after the host mouse/selection handlers.
      // Re-read the same CM document; rendered widget text is never TeX input.
      const active = activeView();
      if (active) { publishFormula(active); scheduleGeometry(active); }
    }
  }, 0);
}

function mathContainerAt(view: any): any | null {
  const range = view.state.selection.main;
  if (!range.empty) return null;
  const node = cm.syntaxTree(view.state).resolveInner(range.from, -1);
  for (let n = node; n; n = n.parent) {
    if (n.type.is('$MathContainer') || ['EquationEnvironment', 'EquationArrayEnvironment'].includes(n.name)) {
      return n;
    }
  }
  return null;
}

function formulaAt(view: any): Formula | null {
  const container = mathContainerAt(view);
  if (!container) return null;
  const source = view.state.doc.sliceString(container.from, container.to).trim();
  const location = String(viewIds.get(view)) + ':' + selectedFilename() + ':' + container.from;
  if (source.length > 32_000) return null;
  if (/^\\begin\{/.test(source)) {
    const env = /^\\begin\{([^}]+)\}/.exec(source)?.[1];
    if (env === 'math' || env === 'displaymath') {
      return { tex: source.replace(/^\\begin\{[^}]+\}/, '').replace(/\\end\{[^}]+\}$/, ''), display: env !== 'math', location };
    }
    return { tex: source, display: true, location };
  }
  if (source.startsWith('$$') && source.endsWith('$$')) return { tex: source.slice(2, -2), display: true, location };
  if (source.startsWith('$') && source.endsWith('$')) return { tex: source.slice(1, -1), display: false, location };
  if (source.startsWith('\\[') && source.endsWith('\\]')) return { tex: source.slice(2, -2), display: true, location };
  if (source.startsWith('\\(') && source.endsWith('\\)')) return { tex: source.slice(2, -2), display: false, location };
  return null;
}

function cancelGeometry(view: any): void {
  const frame = geometryFrames.get(view);
  if (!frame) return;
  geometryFrames.delete(view);
  window.cancelAnimationFrame(frame.id);
}

/** Read coordinates only inside the host CodeMirror measurement lifecycle. */
function readGeometry(view: any): Geometry {
  const formula = settings.preview && activeView() === view ? formulaAt(view) : null;
  if (!formula || !view.inView || !view.hasFocus) return { formula, anchor: null };
  const math = mathContainerAt(view);
  if (!math) return { formula, anchor: null };
  const source = view.state.doc.sliceString(math.from, math.to);
  const delimiterLength = source.startsWith('$$') || source.startsWith('\\(') || source.startsWith('\\[') ? 2 : source.startsWith('$') ? 1 : 0;
  const anchor = view.coordsAtPos(math.from + delimiterLength);
  if (!anchor) return { formula, anchor: null };
  const scroll = view.scrollDOM.getBoundingClientRect();
  const win = view.dom.ownerDocument.defaultView || window;
  const visible = {
    left: Math.max(0, scroll.left), right: Math.min(win.innerWidth, scroll.right),
    top: Math.max(0, scroll.top), bottom: Math.min(win.innerHeight, scroll.bottom),
  };
  if (![anchor.left, anchor.right, anchor.top, anchor.bottom, ...Object.values(visible)].every(Number.isFinite)
    || visible.right <= visible.left || visible.bottom <= visible.top || anchor.bottom <= anchor.top
    || anchor.top < visible.top || anchor.bottom > visible.bottom
    || anchor.left < visible.left || anchor.right > visible.right) return { formula, anchor: null };
  return { formula, anchor: {
    left: anchor.left, top: anchor.top, bottom: anchor.bottom,
    editorTop: visible.top, editorBottom: visible.bottom, editorLeft: visible.left, editorRight: visible.right,
    viewportWidth: win.innerWidth, viewportHeight: win.innerHeight,
  } };
}

function scheduleGeometry(view: any): void {
  const active = activeView();
  if (!settings.preview || !active) {
    cancelGeometry(view);
    send({ type: 'geometry', formula: null, anchor: null });
    return;
  }
  if (active !== view || geometryFrames.has(view)) return;
  const frame = { id: -1 };
  geometryFrames.set(view, frame);
  frame.id = window.requestAnimationFrame(() => {
    if (geometryFrames.get(view) !== frame) return;
    geometryFrames.delete(view);
    const current = () => views.has(view) && activeView() === view && settings.preview;
    if (!current()) return;
    let key = geometryMeasureKeys.get(view);
    if (!key) geometryMeasureKeys.set(view, key = {});
    view.requestMeasure({
      key,
      read: () => current() ? readGeometry(view) : { formula: null, anchor: null },
      write: (geometry: Geometry) => {
        if (!current()) return;
        // A document/selection update may occur between CodeMirror's read and
        // write phases. Never attach a new formula to stale coordinates.
        if (JSON.stringify(geometry.formula) !== JSON.stringify(formulaAt(view))) { scheduleGeometry(view); return; }
        // Parsing and Visual decoration changes can finish without a document
        // or selection transaction. Publish the matching formula before its
        // geometry so the content script cannot discard the first valid anchor.
        publishResolvedFormula(geometry.formula);
        if (!view.hasFocus || !view.inView) geometry = { ...geometry, anchor: null };
        send({ type: 'geometry', ...geometry });
      },
    });
  });
}

function measurePreviewGeometry(): void {
  const active = activeView();
  if (!active || !settings.preview) { send({ type: 'geometry', formula: null, anchor: null }); return; }
  scheduleGeometry(active);
}

function publishResolvedFormula(formula: Formula | null) {
  const signature = JSON.stringify(formula);
  // Geometry-only updates and caret moves within one formula must not restart
  // rendering or the existing TeX typing debounce.
  if (signature === publishedFormula) return;
  publishedFormula = signature;
  send({ type: 'formula', sequence: ++sequence, formula });
}

function publishFormula(view: any) {
  const active = activeView();
  if (active !== view) { if (!active) publishResolvedFormula(null); return; }
  publishResolvedFormula(settings.preview ? formulaAt(view) : null);
}

function movePlaceholder(view: any, direction: number): boolean {
  const session = sessions.get(view);
  if (!session) return false;
  session.current += direction;
  if (session.current < 0 || session.current >= session.ranges.length) {
    sessions.delete(view);
    return false;
  }
  const r = session.ranges[session.current];
  view.dispatch({ selection: cm.EditorSelection.single(r.from, r.to), scrollIntoView: true });
  return true;
}

function completionSource(context: any) {
  if (!settings.completion) return null;
  const match = context.matchBefore(/\\[A-Za-z@]*$/);
  if (!match) return null;
  const node = cm.syntaxTree(context.state).resolveInner(context.pos, -1);
  for (let n = node; n; n = n.parent) if (/Comment|Verbatim|Listing/.test(n.name)) return null;
  if (match.from > 0 && context.state.doc.sliceString(match.from - 1, match.from) === '\\') return null;
  return {
    from: match.from,
    validFor: /^\\[A-Za-z@]*$/,
    options: commands.map(command => ({
      label: '\\' + command.name,
      type: 'function',
      detail: command.source,
      info: [command.signature, command.description, command.preview === 'unsupported' ? '此命令暂不支持公式预览' : ''].filter(Boolean).join('\n'),
      boost: command.source.endsWith('.sty') || command.source.endsWith('.tex') ? 5 : 1,
      apply(view: any, _completion: unknown, from: number, to: number) {
        const expanded = expandSnippet(command.snippet || '\\' + command.name);
        const ranges = expanded.ranges.map(r => ({ from: from + r.from, to: from + r.to }));
        const first = ranges[0] || { from: from + expanded.text.length, to: from + expanded.text.length };
        sessions.delete(view);
        view.dispatch({ changes: { from, to, insert: expanded.text }, selection: cm.EditorSelection.single(first.from, first.to), userEvent: 'input.complete' });
        if (ranges.length) {
          const end=from+expanded.text.length;
          ranges.push({from:end,to:end});
          sessions.set(view, { ranges, current: 0 });
        }
      },
    })),
  };
}

window.addEventListener(IN, ((event: CustomEvent<string>) => {
  try {
    const data = JSON.parse(event.detail);
    if (!Array.isArray(data.commands) || data.commands.length > 10000) return;
    commands = data.commands.filter((c: CommandEntry) => typeof c.name === 'string' && /^[A-Za-z@]+$/.test(c.name) && typeof c.source==='string' && (c.snippet===undefined||typeof c.snippet==='string'));
    settings = data.settings || {};
    for (const bridge of visualBridges.values()) bridge.update(true);
    // Configuration is also the isolated receiver's recovery handshake. It may
    // have forgotten its current formula while this MAIN-world view survived.
    publishedFormula = undefined;
    for (const view of views) publishFormula(view);
    measurePreviewGeometry();
    if (views.size) send({ type: 'ready' });
  } catch { /* Ignore malformed cross-world messages. */ }
}) as EventListener);

window.addEventListener('UNSTABLE_editor:extensions', ((event: CustomEvent) => {
  cm = event.detail?.CodeMirror;
  if (!cm?.ViewPlugin || !cm?.StateEffect || !Array.isArray(event.detail.extensions)) {
    send({ type: 'error', message: '当前 Overleaf 编辑器接口不兼容，扩展已停止接入。' });
    return;
  }
  const plugin = cm.ViewPlugin.define((view: any) => {
    views.add(view);
    const connection = { plugin, ready: false };
    bridgePlugins.set(view, connection);
    initialSourceDocuments.set(view, { doc: view.state.doc, path: selectedFilename(), fileId: selectedDocumentId(), generation: nativeSourceGeneration });
    const visualBridge = mountVisualMathBridge(view, state => cm.syntaxTree(state), () => !!settings.preview);
    visualBridges.set(view, visualBridge);
    viewIds.set(view, ++nextViewId);
    let syntax = cm.syntaxTree(view.state);
    const onGeometry = () => measurePreviewGeometry();
    view.scrollDOM.addEventListener('scroll', onGeometry, { passive: true });
    window.addEventListener('resize', onGeometry);
    queueMicrotask(() => {
      try {
      if (!views.has(view) || bridgePlugins.get(view) !== connection) return;
      const State = view.state.constructor;
      let marker = configurationMarkers.get(view);
      if (!marker && cm.StateField) {
        marker = cm.StateField.define({ create: () => true, update: (value: boolean) => value });
        configurationMarkers.set(view, marker);
      }
      // A host may reuse this EditorView with a completely new EditorState.
      // Check the current state's config, not whether this view was configured
      // sometime in the past. The marker covers completion and keymaps together.
      const configured = marker ? view.state.field(marker, false)
        : view.state.languageDataAt('autocomplete', view.state.selection.main.head).includes(completionSource);
      if (State.languageData && !configured) {
        view.dispatch({ effects: cm.StateEffect.appendConfig.of([
          ...(marker ? [marker] : []),
          State.languageData.of(() => [{ autocomplete: completionSource }]),
          cm.Prec.highest(cm.keymap.of([
            { key: 'Tab', run: (v: any) => movePlaceholder(v, 1) },
            { key: 'Shift-Tab', run: (v: any) => movePlaceholder(v, -1) },
            { key: 'Escape', run: (v: any) => { sessions.delete(v); return false; } },
          ])),
        ]) });
      }
      publishDocument(view, true);
      publishSelection(view);
      publishFormula(view);
      scheduleGeometry(view);
      connection.ready = true;
      send({ type: 'ready' });
      }catch(error){connection.ready=false;send({type:'error',message:'编辑器接入失败，原编辑器继续工作。'+(error instanceof Error?error.message:String(error))});}
    });
    return {
      update(update: any) {
        const nextSyntax = cm.syntaxTree(update.state);
        const syntaxChanged = nextSyntax !== syntax;
        syntax = nextSyntax;
        // Visual mode and mouse-release effects can replace rendered widgets
        // while leaving the source and selection untouched. Coalesce their
        // layout reads into the host's next measurement phase.
        const effectsChanged = update.transactions?.some((transaction: any) => transaction.reconfigured || transaction.effects?.length) ?? false;
        if (update.docChanged || update.selectionSet || syntaxChanged || effectsChanged || update.viewportChanged || update.geometryChanged) visualBridge.update(update.docChanged ? update.changes : false);
        const session = sessions.get(view);
        if (session && update.docChanged) {
          session.ranges = session.ranges.map(r => ({ from: update.changes.mapPos(r.from, -1), to: update.changes.mapPos(r.to, 1) }));
        }
        if (session && update.selectionSet && !update.docChanged) {
          const cursor = update.state.selection.main;
          if (!session.ranges.some(r => cursor.from >= r.from && cursor.to <= r.to)) sessions.delete(view);
        }
        if (update.docChanged) {
          const name = selectedFilename(), fileId = selectedDocumentId();
          // Ordinary typing preserves a proven document identity immediately;
          // a native tab-label change does not relabel the old source object.
          if (matchesOwner(documentOwners.get(update.startState?.doc), name, fileId)
            || initialDocumentMatches(view, update.startState?.doc, name, fileId)) rememberDocument(view, name, fileId);
          navigationSelections.delete(view); publishDocument(view, true);
        }
        if (update.selectionSet && view.hasFocus && !assistantOwnsInteraction()) dismissedSelections.delete(view);
        if (update.docChanged || update.selectionSet || update.focusChanged && view.hasFocus) {
          publishSelection(view, false, update.selectionSet || update.docChanged && view.hasFocus);
        }
        if (update.docChanged || update.selectionSet || update.focusChanged || syntaxChanged || effectsChanged) publishFormula(view);
        if (update.docChanged || update.selectionSet || update.focusChanged || syntaxChanged || effectsChanged || update.geometryChanged || update.viewportChanged) scheduleGeometry(view);
      },
      destroy() {
        visualBridge.destroy(); visualBridges.delete(view);
        clearTimeout(publishTimers.get(view));
        pendingDocuments.delete(view);
        view.scrollDOM.removeEventListener('scroll', onGeometry);
        window.removeEventListener('resize', onGeometry);
        cancelGeometry(view);
        views.delete(view); sessions.delete(view);
        if (bridgePlugins.get(view) === connection) bridgePlugins.delete(view);
        if (lastFocusedView === view) { lastFocusedView = undefined; lastFocusedPath = ''; }
        measurePreviewGeometry();
      },
    };
  });
  event.detail.extensions.push(plugin);
}) as EventListener);

// Also supports enabling the extension after an editor has already been constructed.
window.dispatchEvent(new Event('editor:extension-loaded'));
window.addEventListener('opt:measure', measurePreviewGeometry);
window.addEventListener('opt:request-document', () => { const active = activeView(); if (active) publishDocument(active); });
window.addEventListener('opt:request-selection', () => captureSelection());
// Browser selection changes, visual decorations and focus transitions need not
// produce a distinct CM selectionSet transaction. Read after native handlers.
document.addEventListener('selectionchange', () => {
  if (assistantOwnsInteraction()) return;
  const selection = document.getSelection();
  // A user editing the question or clearing its quote must not reattach an old
  // editor selection. Only selection changes inside an editor trigger a read.
  if ([...views].some(view => view.contentDOM?.contains(selection?.anchorNode)
    || view.contentDOM?.contains(document.activeElement))) scheduleSelection();
});
document.addEventListener('pointerup', event => {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('.cm-editor')) scheduleSelection();
  else if (outsidePointer && !target?.closest('#opt-codex-panel,#opt-codex-tab')) {
    clearTimeout(selectionTimer); selectionTimer = undefined;
    const active = activeView();
    if (active) dismissedSelections.add(active);
    send({ type: 'selection', selection: null, name: selectedFilename(), clear: true });
  }
  outsidePointer = false;
  // Defer past the host's focus/blur handlers in this pointer event.
  setTimeout(() => { assistantPointer = false; }, 0);
});
document.addEventListener('keyup', event => {
  if (event.target instanceof Element && event.target.closest('.cm-editor')) {
    for (const view of views) if (view.dom.contains(event.target)) { dismissedSelections.delete(view); navigationSelections.delete(view); }
    scheduleSelection();
  }
});
document.addEventListener('pointerdown', event => {
  const target = event.target instanceof Element ? event.target : null;
  assistantPointer = !!target?.closest('#opt-codex-panel,#opt-codex-tab');
  outsidePointer = !assistantPointer && !target?.closest('.cm-editor');
  if (target?.closest('.cm-editor')) {
    for (const view of views) if (view.dom.contains(target)) { dismissedSelections.delete(view); navigationSelections.delete(view); }
  }
  if (target?.closest('#opt-codex-tab')) captureSelection();
}, true);
document.addEventListener('pointercancel', () => { assistantPointer = false; outsidePointer = false; });
window.addEventListener('blur', () => { assistantPointer = false; outsidePointer = false; });
window.addEventListener('opt:request-document-now', () => {
  const active = activeView(); const name = selectedFilename();
  if (active && name && active.state.doc.length <= 2_000_000) send({ type: 'document', name, text: active.state.doc.toString() });
});
