// Public DOM only: shared by the isolated content script and the MAIN-world
// editor bridge so a quote's file identity means the same thing on both sides.
export function displayedSourcePath(value: string | null | undefined): string {
  return (value || '').replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim();
}

export function sourceTreeEntity(item: Element): HTMLElement | undefined {
  return [...item.querySelectorAll<HTMLElement>('.entity[data-file-id]')]
    .find(entity => entity.closest('[role="treeitem"]') === item);
}

export function sourceTreeItems(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')]
    .filter(item => !!sourceTreeEntity(item) || item.matches('button[role="treeitem"]') && !item.querySelector('[role="treeitem"]'));
}

function parentFolder(item: Element): Element | null {
  const nested = item.parentElement?.closest('[role="treeitem"]');
  if (nested) return nested;
  // Overleaf puts an expanded folder's UL beside its LI, not inside it.
  const list = item.parentElement?.closest('ul.file-tree-folder-list');
  const sibling = list?.previousElementSibling;
  return sibling?.matches('[role="treeitem"]') && sourceTreeEntity(sibling)?.dataset.fileType === 'folder' ? sibling : null;
}

function treeName(item: Element): string {
  // The harness uses flat buttons whose visible text is the full path. Native
  // LI text also contains folder descendants, so never read it wholesale.
  if (item.matches('button[role="treeitem"]') && !sourceTreeEntity(item)) {
    return displayedSourcePath(item.textContent || item.getAttribute('aria-label'));
  }
  return displayedSourcePath(item.getAttribute('aria-label') || sourceTreeEntity(item)?.querySelector('.item-name')?.textContent);
}

export function sourceTreePath(item: Element): string {
  const parts = [treeName(item)];
  if (!parts[0]) return '';
  if (parts[0].includes('/')) return parts[0];
  const seen = new Set<Element>([item]);
  for (let parent = parentFolder(item); parent && !seen.has(parent); parent = parentFolder(parent)) {
    seen.add(parent);
    const name = treeName(parent);
    if (!name) return '';
    parts.unshift(name);
  }
  return parts.join('/');
}

export function sourceTabs(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('#ide-redesign-editor-panel [role="tab"], .editor-file-tab[role="tab"]')]
    .filter(tab => !!tab.querySelector('.editor-file-tab-path'));
}

export function sourceTabPath(tab: Element): string {
  const text = displayedSourcePath(tab.querySelector('.editor-file-tab-path')?.textContent);
  const id = tab.getAttribute('data-tab-id');
  if (id) {
    const item = sourceTreeItems().find(item => sourceTreeEntity(item)?.dataset.fileId === id);
    if (item) return sourceTreePath(item);
  }
  return text;
}

export function selectedSourcePath(): string {
  const tab = sourceTabs().find(tab => tab.getAttribute('aria-selected') === 'true');
  if (tab) return sourceTabPath(tab);
  const item = sourceTreeItems().find(item => item.getAttribute('aria-selected') === 'true' && sourceTreeEntity(item)?.dataset.fileType !== 'folder');
  return item ? sourceTreePath(item) : '';
}
