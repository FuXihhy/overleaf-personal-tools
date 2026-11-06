import { isCodexSelection, sourcePath, type CodexSelection } from '../codex/types';
import { selectedSourcePath, sourceTabPath, sourceTabs, sourceTreeEntity, sourceTreeItems, sourceTreePath } from './source-path';

interface RevealSourceOptions { signal?: AbortSignal; files?: readonly string[] }
const OPEN_TIMEOUT = 10_000;
const REPLY_TIMEOUT = 3_000;

function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason || new DOMException('Source navigation was cancelled.', 'AbortError');
}

function waitFor<T>(read: () => T | undefined, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { observer.disconnect(); signal.removeEventListener('abort', cancel); };
    const check = () => {
      try {
        aborted(signal);
        const value = read();
        if (value !== undefined) { cleanup(); resolve(value); }
      } catch (error) { cleanup(); reject(error); }
    };
    const cancel = () => { cleanup(); reject(signal.reason || new DOMException('Source navigation was cancelled.', 'AbortError')); };
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    signal.addEventListener('abort', cancel, { once: true });
    check();
  });
}

function targetPath(path: string, files: readonly string[] = []): string {
  if (!sourcePath(path)) throw new Error('This quote does not contain a valid source file.');
  if (path.includes('/') || files.includes(path) || !files.length) return path;
  const matches = [...new Set(files.filter(file => sourcePath(file) && file.split('/').at(-1) === path))];
  if (matches.length > 1) throw new Error('More than one source file has this name. The original quote needs its full file path.');
  return matches[0] || path;
}

function activeFile(path: string, files: readonly string[] = []): boolean {
  if (selectedSourcePath() !== path) return false;
  const tab = sourceTabs().find(tab => tab.getAttribute('aria-selected') === 'true');
  const id = tab?.dataset.tabId;
  const exactItem = sourceTreeItems().find(item => sourceTreePath(item) === path && sourceTreeEntity(item)?.dataset.fileType !== 'folder');
  const exactId = exactItem && sourceTreeEntity(exactItem)?.dataset.fileId;
  // A collapsed folder can leave a tab showing only a basename. Prefer the
  // document's public native ID when it is available, including at the root.
  if (id && !exactId && !path.includes('/') && files.some(file => file !== path && file.split('/').at(-1) === path)) return false;
  return !id || !exactId || id === exactId;
}

function matchingItem(path: string): HTMLElement | undefined {
  const matches = sourceTreeItems().filter(item => sourceTreePath(item) === path);
  if (matches.length > 1) throw new Error('The source file tree is ambiguous. Open the quoted file and try again.');
  return matches[0];
}

async function findFile(path: string, signal: AbortSignal): Promise<HTMLElement> {
  const parts = path.split('/');
  for (let index = 0; index < parts.length - 1; index++) {
    const folderPath = parts.slice(0, index + 1).join('/');
    // Flat trees already expose complete paths and have no folder rows.
    if (matchingItem(path)) break;
    const folder = await waitFor(() => matchingItem(folderPath), signal);
    const entity = sourceTreeEntity(folder);
    if (entity && entity.dataset.fileType !== 'folder') throw new Error('The quoted source folder could not be found.');
    if (folder.getAttribute('aria-expanded') === 'false') {
      const button = folder.querySelector<HTMLElement>('.file-tree-entity-button');
      if (!button) throw new Error('The quoted source folder could not be expanded.');
      aborted(signal);
      button.click();
    }
  }
  const file = await waitFor(() => matchingItem(path), signal);
  if (sourceTreeEntity(file)?.dataset.fileType === 'folder') throw new Error('The quoted location is a folder, not a source file.');
  return file;
}

function mountFileTree(path: string): () => void {
  // Most Overleaf layouts keep the tree mounted while its rail is closed. In
  // layouts that unmount it, use the native rail toggle once and restore it.
  if (matchingItem(path) || matchingItem(path.split('/')[0])) return () => {};
  const button = document.getElementById('ide-rail-tabs-tab-file-tree');
  if (!button || button.classList.contains('open-rail')) return () => {};
  const previous = document.querySelector<HTMLElement>('nav.ide-rail .ide-rail-tabs-wrapper button.open-rail:not(#opt-codex-tab)');
  button.click();
  return () => {
    // A user may choose another rail while the source loads. Preserve that
    // newer choice instead of forcibly reopening the old panel.
    if (!button.isConnected || !button.classList.contains('open-rail')) return;
    if (previous?.isConnected && previous !== button) previous.click();
    else button.click();
  };
}

function bridgeRequest(kind: 'prepare' | 'reveal', payload: { id: string; path?: string; selection?: CodexSelection; prepared?: boolean }, signal: AbortSignal): Promise<'done' | 'pending'> {
  return new Promise((resolve, reject) => {
    const resultEvent = `opt:${kind}-source-result`;
    const cleanup = () => { clearTimeout(timer); window.removeEventListener(resultEvent, receive); signal.removeEventListener('abort', cancel); };
    const finish = (error?: unknown, result: 'done' | 'pending' = 'done') => { cleanup(); error ? reject(error) : resolve(result); };
    const cancel = () => finish(signal.reason || new DOMException('Source navigation was cancelled.', 'AbortError'));
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (typeof detail !== 'string' || detail.length > 10_000) return;
      let result: any;
      try { result = JSON.parse(detail); } catch { return; }
      if (!result || result.id !== payload.id || typeof result.ok !== 'boolean') return;
      if (kind === 'reveal' && !result.ok && result.pending === true) { finish(undefined, 'pending'); return; }
      finish(result.ok ? undefined : new Error(typeof result.message === 'string' ? result.message : 'The quoted passage could not be located.'));
    };
    const timer = setTimeout(() => finish(new Error('The source editor did not respond. Refresh Overleaf and try again.')), REPLY_TIMEOUT);
    window.addEventListener(resultEvent, receive);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) { cancel(); return; }
    window.dispatchEvent(new CustomEvent(`opt:${kind}-source`, { detail: JSON.stringify(payload) }));
  });
}

function retryDelay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); };
    const cancel = () => { cleanup(); reject(signal.reason); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, 75);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
}

/** Open the native source document and ask its CodeMirror bridge to reveal a
 * quote. Never reads private application state or modifies document contents. */
export async function revealSource(selection: CodexSelection, options: RevealSourceOptions = {}): Promise<void> {
  if (!isCodexSelection(selection)) throw new Error('This quote does not contain a valid source location.');
  const path = targetPath(selection.path, options.files);
  const controller = new AbortController();
  const signal = controller.signal;
  const cancel = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new Error('Overleaf did not finish opening the quoted source file. Open it manually and try again.')), OPEN_TIMEOUT);
  const id = `source-${crypto.randomUUID()}`;
  let prepared = false;
  let restoreRail = () => {};
  const open = async (target: HTMLElement) => {
    // Capture the actual CM view/document before changing the native tab.
    // Cached EditorStates need not emit an edit/mount event when restored.
    prepared = true;
    await bridgeRequest('prepare', { id, path }, signal);
    aborted(signal);
    target.click();
  };
  try {
    aborted(signal);
    if (!activeFile(path, options.files)) {
      const existingFile = matchingItem(path);
      const fileId = existingFile && sourceTreeEntity(existingFile)?.dataset.fileId;
      const ambiguousTabName = !path.includes('/') && options.files?.some(file => file !== path && file.split('/').at(-1) === path);
      const tab = sourceTabs().find(tab => tab.getAttribute('aria-selected') !== 'true'
        && (fileId ? tab.dataset.tabId === fileId : !ambiguousTabName && sourceTabPath(tab) === path));
      if (tab) await open(tab);
      else {
        restoreRail = mountFileTree(path);
        const file = await findFile(path, signal);
        aborted(signal);
        // Expanding the containing folder may establish that the quoted tab
        // was already active; in that case no loading event is necessary.
        if (!activeFile(path, options.files)) await open(sourceTreeEntity(file) || file);
      }
      await waitFor(() => activeFile(path, options.files) ? true : undefined, signal);
    }
    if (!prepared) clearTimeout(timer);
    aborted(signal);
    while (await bridgeRequest('reveal', { id, selection: { ...selection, path }, ...(prepared ? { prepared: true } : {}) }, signal) === 'pending') {
      if (!prepared) throw new Error('The source editor is not ready.');
      await retryDelay(signal);
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    controller.abort();
    if (prepared) window.dispatchEvent(new CustomEvent('opt:cancel-source', { detail: JSON.stringify({ id }) }));
    restoreRail();
  }
}
