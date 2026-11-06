// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexSelection } from '../src/codex/types';
import { revealSource } from '../src/overleaf/source-navigation';
import { selectedSourcePath, sourceTreePath } from '../src/overleaf/source-path';

const quote = (path = 'main.tex'): CodexSelection => ({ path, text: 'quoted text', from: 0, to: 11, startLine: 1, endLine: 1, before: '', after: '' });
const listeners: Array<() => void> = [];
const loadedSources = new Set<string>();
function listen(name: string, handler: EventListener) {
  window.addEventListener(name, handler); listeners.push(() => window.removeEventListener(name, handler));
}
function reply(id: string, ok = true, message?: string) {
  window.dispatchEvent(new CustomEvent('opt:reveal-source-result', { detail: JSON.stringify({ id, ok, message }) }));
}
function documentReady(path: string) {
  loadedSources.add(path);
  window.dispatchEvent(new CustomEvent('opt:editor', { detail: JSON.stringify({ type: 'document', name: path, text: 'quoted text', sourceReady: true }) }));
}
function bridge(automatically = true) {
  const received: Array<{ id: string; selection: CodexSelection }> = [];
  listen('opt:prepare-source', (event => {
    const request = JSON.parse((event as CustomEvent<string>).detail);
    window.dispatchEvent(new CustomEvent('opt:prepare-source-result', { detail: JSON.stringify({ id: request.id, ok: true }) }));
  }) as EventListener);
  listen('opt:reveal-source', (event => {
    const request = JSON.parse((event as CustomEvent<string>).detail);
    if (request.prepared && !loadedSources.has(request.selection.path)) {
      window.dispatchEvent(new CustomEvent('opt:reveal-source-result', { detail: JSON.stringify({ id: request.id, ok: false, pending: true }) }));
      return;
    }
    received.push(request);
    if (automatically) reply(request.id);
  }) as EventListener);
  return received;
}
function flatFile(path: string, selected = false) {
  const item = document.createElement('button'); item.setAttribute('role', 'treeitem');
  item.setAttribute('aria-label', path.split('/').at(-1)!); item.setAttribute('aria-selected', String(selected)); item.textContent = path;
  document.body.append(item); return item;
}
function activate(item: Element) {
  document.querySelectorAll('[role="treeitem"]').forEach(node => node.setAttribute('aria-selected', String(node === item)));
}
function nativeItem(parent: Element, name: string, type: 'folder' | 'doc', id: string) {
  const li = document.createElement('li'); li.setAttribute('role', 'treeitem'); li.setAttribute('aria-label', name);
  li.innerHTML = `<div class="entity" data-file-id="${id}" data-file-type="${type}"><div class="entity-name"><${type === 'folder' ? 'button' : 'div'} class="file-tree-entity-button"><span class="item-name"></span></${type === 'folder' ? 'button' : 'div'}></div></div>`;
  li.querySelector('.item-name')!.textContent = name;
  if (type === 'folder') li.setAttribute('aria-expanded', 'false');
  parent.append(li); return li;
}
function folderChildren(folder: HTMLElement) {
  folder.setAttribute('aria-expanded', 'true');
  const ul = document.createElement('ul'); ul.className = 'file-tree-folder-list'; ul.setAttribute('role', 'tree');
  const inner = document.createElement('div'); inner.className = 'file-tree-folder-list-inner'; ul.append(inner); folder.after(ul); return inner;
}
function nativeTab(path: string, id: string, selected = false) {
  let editor = document.getElementById('ide-redesign-editor-panel');
  if (!editor) { editor = document.createElement('div'); editor.id = 'ide-redesign-editor-panel'; document.body.append(editor); }
  const tab = document.createElement('div'); tab.className = 'editor-file-tab'; tab.setAttribute('role', 'tab'); tab.dataset.tabId = id;
  tab.setAttribute('aria-selected', String(selected));
  const label = document.createElement('div'); label.className = 'editor-file-tab-path'; label.textContent = '\u200e' + path; tab.append(label); editor.append(tab); return tab;
}
function activateTab(tab: Element) {
  document.querySelectorAll('[role="tab"]').forEach(node => node.setAttribute('aria-selected', String(node === tab)));
}
beforeEach(() => { loadedSources.clear(); vi.useFakeTimers(); });
afterEach(() => {
  listeners.splice(0).forEach(remove => remove()); document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks();
});

describe('source file identity', () => {
  it('resolves native sibling folder lists recursively and matches the selected tab by document ID', () => {
    const appendix = nativeItem(document.body, 'Appendix', 'folder', 'folder-a');
    const details = nativeItem(folderChildren(appendix), 'Details', 'folder', 'folder-b');
    const file = nativeItem(folderChildren(details), 'notes.tex', 'doc', 'target');
    nativeItem(document.body, 'notes.tex', 'doc', 'root-duplicate');
    nativeTab('notes.tex', 'target', true);
    expect(sourceTreePath(file)).toBe('Appendix/Details/notes.tex');
    expect(selectedSourcePath()).toBe('Appendix/Details/notes.tex');
  });
  it('supports full tab paths and flat file buttons without treating basename labels as paths', () => {
    const file = flatFile('Appendix/notes.tex', true);
    expect(sourceTreePath(file)).toBe('Appendix/notes.tex');
    expect(selectedSourcePath()).toBe('Appendix/notes.tex');
    nativeTab('Sections/notes.tex', 'unmounted-tree', true);
    expect(selectedSourcePath()).toBe('Sections/notes.tex');
  });
  it('ignores document outline entries and a selected folder as source documents', () => {
    const outline = document.createElement('div'); outline.setAttribute('role', 'treeitem');
    outline.setAttribute('aria-selected', 'true'); outline.setAttribute('aria-label', 'main.tex'); document.body.append(outline);
    const folder = nativeItem(document.body, 'Appendix', 'folder', 'folder'); folder.setAttribute('aria-selected', 'true');
    expect(selectedSourcePath()).toBe('');
    flatFile('main.tex', true); expect(selectedSourcePath()).toBe('main.tex');
  });
});

describe('source quote navigation', () => {
  it('reveals an already active file without opening UI or disturbing the draft', async () => {
    const file = flatFile('main.tex', true); const click = vi.spyOn(file, 'click');
    const draft = document.createElement('textarea'); draft.value = 'unfinished question'; document.body.append(draft);
    const received = bridge();
    await revealSource(quote());
    expect(received).toHaveLength(1); expect(received[0].selection).toEqual(quote());
    expect(click).not.toHaveBeenCalled(); expect(draft.value).toBe('unfinished question');
  });

  it('opens nested native folders and only selects the exact document despite duplicate basenames', async () => {
    nativeTab('main.tex', 'main', true); nativeItem(document.body, 'main.tex', 'doc', 'main');
    const wrong = nativeItem(document.body, 'notes.tex', 'doc', 'wrong'); const wrongClick = vi.spyOn(wrong, 'click');
    const folder = nativeItem(document.body, 'Appendix', 'folder', 'folder-a');
    let opened = 0;
    folder.querySelector('button')!.onclick = () => {
      opened++;
      const details = nativeItem(folderChildren(folder), 'Details', 'folder', 'folder-b');
      details.querySelector('button')!.onclick = () => {
        opened++;
        const file = nativeItem(folderChildren(details), 'notes.tex', 'doc', 'target');
        file.querySelector<HTMLElement>('.entity')!.onclick = () => {
          opened++; activateTab(nativeTab('notes.tex', 'target'));
          setTimeout(() => documentReady('Appendix/Details/notes.tex'), 80);
        };
      };
    };
    const received = bridge(); const pending = revealSource(quote('Appendix/Details/notes.tex'));
    await vi.advanceTimersByTimeAsync(79); expect(received).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(76); await pending;
    expect(opened).toBe(3); expect(wrongClick).not.toHaveBeenCalled();
    expect(received[0].selection.path).toBe('Appendix/Details/notes.tex');
  });

  it('activates an exact open tab and waits for its source document, not merely the active label', async () => {
    nativeTab('main.tex', 'main', true); const tab = nativeTab('Sections/notes.tex', 'notes');
    tab.onclick = () => activateTab(tab);
    const received = bridge(); const pending = revealSource(quote('Sections/notes.tex'));
    await vi.advanceTimersByTimeAsync(0); documentReady('main.tex');
    // An immediate snapshot can still contain the old CM document even when
    // Overleaf has already changed the selected tab's name.
    window.dispatchEvent(new CustomEvent('opt:editor', { detail: JSON.stringify({ type: 'document', name: 'Sections/notes.tex', text: 'old document' }) }));
    await vi.advanceTimersByTimeAsync(1500); expect(received).toHaveLength(0);
    documentReady('Sections/notes.tex'); await vi.advanceTimersByTimeAsync(75); await pending;
    expect(received).toHaveLength(1);
  });

  it('prepares before native activation and reveals a cached tab without a mount or edit publication', async () => {
    nativeTab('main.tex', 'main', true); const tab = nativeTab('Sections/notes.tex', 'notes');
    const preparations: Array<{ id: string; source: string }> = [];
    const probes: Array<{ id: string; prepared?: boolean }> = [];
    const releases: string[] = [];
    listen('opt:prepare-source', (event => preparations.push({ id: JSON.parse((event as CustomEvent<string>).detail).id, source: selectedSourcePath() })) as EventListener);
    listen('opt:reveal-source', (event => probes.push(JSON.parse((event as CustomEvent<string>).detail))) as EventListener);
    listen('opt:cancel-source', (event => releases.push(JSON.parse((event as CustomEvent<string>).detail).id)) as EventListener);
    tab.onclick = () => {
      activateTab(tab);
      // Real Overleaf restores a cached EditorState without publishing a new
      // opt:editor document. MAIN can instead prove that its doc changed.
      setTimeout(() => loadedSources.add('Sections/notes.tex'), 120);
    };
    const received = bridge(); const pending = revealSource(quote('Sections/notes.tex'));
    await vi.advanceTimersByTimeAsync(75); expect(received).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(75); await pending;
    expect(preparations).toHaveLength(1); expect(preparations[0].source).toBe('main.tex');
    expect(probes.length).toBeGreaterThan(1); expect(probes.every(probe => probe.id === preparations[0].id && probe.prepared === true)).toBe(true);
    expect(received).toHaveLength(1); expect(releases).toEqual([preparations[0].id]);
  });

  it('does not click a native tab before its preparation is acknowledged', async () => {
    nativeTab('main.tex', 'main', true); const tab = nativeTab('Sections/notes.tex', 'notes'); const click = vi.spyOn(tab, 'click');
    const pending = revealSource(quote('Sections/notes.tex')); const rejected = expect(pending).rejects.toThrow('did not respond');
    await vi.advanceTimersByTimeAsync(3000); await rejected; expect(click).not.toHaveBeenCalled();
  });

  it('cancels an in-flight cached-editor probe without making another request', async () => {
    nativeTab('main.tex', 'main', true); const tab = nativeTab('Sections/notes.tex', 'notes'); tab.onclick = () => activateTab(tab);
    let attempts = 0; const releases: string[] = [];
    listen('opt:reveal-source', (() => { attempts++; }) as EventListener);
    listen('opt:cancel-source', (event => releases.push(JSON.parse((event as CustomEvent<string>).detail).id)) as EventListener);
    bridge(); const controller = new AbortController(); const pending = revealSource(quote('Sections/notes.tex'), { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0); expect(attempts).toBe(1); controller.abort(); await rejected;
    loadedSources.add('Sections/notes.tex'); await vi.advanceTimersByTimeAsync(500);
    expect(attempts).toBe(1); expect(releases).toHaveLength(1);
  });

  it('mounts an absent native file tree and restores the previously open native panel', async () => {
    document.body.innerHTML = '<nav class="ide-rail"><div class="ide-rail-tabs-wrapper"><button id="ide-rail-tabs-tab-file-tree"></button><button id="search" class="open-rail"></button><button id="opt-codex-tab" class="open-rail"></button></div></nav>';
    const fileTab = document.getElementById('ide-rail-tabs-tab-file-tree')!;
    const search = document.getElementById('search')!;
    const searchClick = vi.fn(() => { fileTab.classList.remove('open-rail'); search.classList.add('open-rail'); });
    search.onclick = searchClick;
    fileTab.onclick = () => {
      search.classList.remove('open-rail'); fileTab.classList.add('open-rail');
      setTimeout(() => {
        const file = flatFile('notes.tex');
        file.onclick = () => { activate(file); documentReady('notes.tex'); };
      }, 30);
    };
    const received = bridge(); const pending = revealSource(quote('notes.tex'));
    await vi.advanceTimersByTimeAsync(30); await pending;
    expect(received).toHaveLength(1); expect(searchClick).toHaveBeenCalledTimes(1);
    expect(search.classList.contains('open-rail')).toBe(true);
    expect(document.getElementById('opt-codex-tab')?.classList.contains('open-rail')).toBe(true);
  });

  it('does not restore an old rail after the user chooses a different one while loading', async () => {
    document.body.innerHTML = '<nav class="ide-rail"><div class="ide-rail-tabs-wrapper"><button id="ide-rail-tabs-tab-file-tree"></button><button id="search"></button></div></nav>';
    const fileTab = document.getElementById('ide-rail-tabs-tab-file-tree')!; let railClicks = 0;
    fileTab.onclick = () => {
      railClicks++; fileTab.classList.add('open-rail');
      const file = flatFile('notes.tex'); file.onclick = () => { activate(file); documentReady('notes.tex'); };
    };
    const received = bridge(false); const pending = revealSource(quote('notes.tex'));
    await vi.advanceTimersByTimeAsync(0);
    fileTab.classList.remove('open-rail'); document.getElementById('search')!.classList.add('open-rail');
    reply(received[0].id); await pending;
    expect(railClicks).toBe(1); expect(document.getElementById('search')!.classList.contains('open-rail')).toBe(true);
  });

  it('resolves an old basename quote only when the known project path is unique', async () => {
    flatFile('Appendix/notes.tex', true); const received = bridge();
    await revealSource(quote('notes.tex'), { files: ['main.tex', 'Appendix/notes.tex'] });
    expect(received[0].selection.path).toBe('Appendix/notes.tex');
    await expect(revealSource(quote('notes.tex'), { files: ['Appendix/notes.tex', 'Sections/notes.tex'] })).rejects.toThrow('More than one');
    expect(received).toHaveLength(1);
  });

  it('opens the real root file rather than an unresolved same-name tab from a collapsed folder', async () => {
    const root = nativeItem(document.body, 'notes.tex', 'doc', 'root');
    nativeTab('notes.tex', 'nested', true);
    root.querySelector<HTMLElement>('.entity')!.onclick = () => {
      activateTab(nativeTab('notes.tex', 'root')); documentReady('notes.tex');
    };
    const received = bridge();
    await revealSource(quote('notes.tex'), { files: ['notes.tex', 'Appendix/notes.tex'] });
    expect(received).toHaveLength(1);
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('data-tab-id')).toBe('root');
  });

  it('ignores stale and malformed bridge responses until the matching request succeeds', async () => {
    flatFile('main.tex', true); const received = bridge(false); let finished = false;
    const pending = revealSource(quote()); pending.then(() => { finished = true; });
    reply('an-earlier-request');
    window.dispatchEvent(new CustomEvent('opt:reveal-source-result', { detail: '{' }));
    window.dispatchEvent(new CustomEvent('opt:reveal-source-result', { detail: JSON.stringify({ id: received[0].id, ok: 'true' }) }));
    await vi.advanceTimersByTimeAsync(30); expect(finished).toBe(false);
    reply(received[0].id); await pending; expect(finished).toBe(true);
  });

  it('stops navigation after cancellation even when a delayed folder finishes loading', async () => {
    const folder = nativeItem(document.body, 'Appendix', 'folder', 'folder'); let fileClicks = 0;
    folder.querySelector('button')!.onclick = () => {
      folder.setAttribute('aria-expanded', 'true');
      setTimeout(() => {
        const file = nativeItem(folderChildren(folder), 'notes.tex', 'doc', 'file');
        file.querySelector<HTMLElement>('.entity')!.onclick = () => { fileClicks++; };
      }, 100);
    };
    const controller = new AbortController(); const received = bridge();
    const pending = revealSource(quote('Appendix/notes.tex'), { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0); controller.abort(); await rejected;
    await vi.advanceTimersByTimeAsync(200); expect(fileClicks).toBe(0); expect(received).toHaveLength(0);
  });

  it('times out a missing file without choosing another file with the same basename', async () => {
    const wrong = flatFile('Other/notes.tex'); const click = vi.spyOn(wrong, 'click'); bridge();
    const pending = revealSource(quote('Deleted/notes.tex'));
    const rejected = expect(pending).rejects.toThrow('did not finish opening');
    await vi.advanceTimersByTimeAsync(10_000); await rejected; expect(click).not.toHaveBeenCalled();
  });

  it('bounds a missing bridge response and forwards a stale-passage error without retrying', async () => {
    flatFile('main.tex', true); const received = bridge(false);
    const pending = revealSource(quote()); const rejected = expect(pending).rejects.toThrow('did not respond');
    await vi.advanceTimersByTimeAsync(3000); await rejected;
    const retry = revealSource(quote()); const stale = expect(retry).rejects.toThrow('no longer present');
    reply(received[1].id, false, 'The quoted passage is no longer present in this file.'); await stale;
    expect(received).toHaveLength(2);
  });

  it('does not dispatch or navigate an invalid quote or an already aborted request', async () => {
    flatFile('main.tex', true); const received = bridge();
    await expect(revealSource(quote('../main.tex'))).rejects.toThrow('valid source');
    const controller = new AbortController(); controller.abort();
    await expect(revealSource(quote(), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(received).toHaveLength(0);
  });
});
