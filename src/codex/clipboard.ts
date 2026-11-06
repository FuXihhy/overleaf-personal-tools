import { getRenderedMathSource } from './message-renderer';

/** User-initiated writes need no extension clipboard permission on Overleaf. */
export async function writeClipboardText(value: string): Promise<void> {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); return; } } catch { /* Use the document's copy fallback. */ }
  const selection = document.getSelection(), ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const input = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement ? active : undefined;
  const caret = input ? { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection } : undefined;
  const buffer = document.createElement('textarea'); buffer.value = value; buffer.readOnly = true; buffer.tabIndex = -1;
  buffer.style.cssText = 'position:fixed;left:-10000px;top:0;opacity:0;'; document.body.append(buffer);
  let copied = false;
  try { buffer.select(); copied = document.execCommand?.('copy') === true; }
  finally {
    buffer.remove(); active?.focus({ preventScroll: true });
    if (selection) { selection.removeAllRanges(); for (const range of ranges) selection.addRange(range); }
    if (input && caret?.start != null && caret.end != null) input.setSelectionRange(caret.start, caret.end, caret.direction ?? undefined);
  }
  if (!copied) throw new Error('Clipboard access is unavailable.');
}

const enclosingElement = (value: Node) => value instanceof Element ? value : value.parentElement;
const blockTags = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'PRE', 'BLOCKQUOTE', 'ARTICLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

/** Read text directly, skipping hydrated SVG subtrees instead of cloning them. */
function serializeSelection(container: HTMLElement, selected: Range, maxLength: number): { text: string; hasMath: boolean } | undefined {
  if (selected.collapsed || !container.contains(selected.startContainer) || !container.contains(selected.endContainer)) return;
  const range = selected.cloneRange();
  const startMath = enclosingElement(range.startContainer)?.closest('.opt-codex-math');
  const endMath = enclosingElement(range.endContainer)?.closest('.opt-codex-math');
  // A glyph is not a meaningful LaTeX substring. Quote its complete expression,
  // while leaving the actual browser selection and the live DOM untouched.
  if (startMath) { if (!container.contains(startMath)) return; range.setStartBefore(startMath); }
  if (endMath) { if (!container.contains(endMath)) return; range.setEndAfter(endMath); }
  const parts: string[] = [];
  let length = 0, last = '', boundary = false, invalid = false, hasMath = false;
  function append(value: string) {
    if (!value || invalid) return;
    const separator = boundary && last !== '\n' && !value.startsWith('\n') ? '\n' : '';
    boundary = false;
    if (length + separator.length + value.length > maxLength) { invalid = true; return; }
    if (separator) parts.push(separator);
    parts.push(value); length += separator.length + value.length; last = value.at(-1)!;
  }
  function visit(node: Node): void {
    if (invalid || !range.intersectsNode(node)) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || '';
      append(text.slice(node === range.startContainer ? range.startOffset : 0, node === range.endContainer ? range.endOffset : text.length));
      return;
    }
    if (node instanceof Element) {
      if (node.tagName === 'BUTTON') return;
      if (node.classList.contains('opt-codex-math')) {
        const source = getRenderedMathSource(node);
        if (!source) { invalid = true; return; }
        hasMath = true; append(source.original); return;
      }
      if (node.tagName === 'BR') { append('\n'); return; }
    }
    const before = length;
    for (const child of node.childNodes) visit(child);
    // Defer separators until the next selected content. This preserves real
    // newlines in code while avoiding a fabricated final paragraph newline.
    if (node instanceof Element && blockTags.has(node.tagName) && length > before) boundary = true;
  }
  visit(container);
  if (invalid) return;
  const text = parts.join('');
  return text.trim() ? { text, hasMath } : undefined;
}

/** A bounded, read-only snapshot of a single selection inside one message body. */
export function readRenderedSelection(container: HTMLElement, range?: Range, maxLength = 64_000): string | undefined {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1) return;
  if (!range) {
    const selection = container.ownerDocument.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
    range = selection.getRangeAt(0);
  }
  return serializeSelection(container, range, maxLength)?.text;
}

/** Keep normal copy behavior unless the panel selection contains a formula. */
export function copyRenderedMathSelection(event: ClipboardEvent, transcript: HTMLElement): boolean {
  const selection = transcript.ownerDocument.getSelection();
  if (!event.clipboardData || !selection || selection.isCollapsed || selection.rangeCount !== 1) return false;
  const range = selection.getRangeAt(0);
  if (!enclosingElement(range.startContainer)?.closest('.opt-codex-message-body') || !enclosingElement(range.endContainer)?.closest('.opt-codex-message-body')) return false;
  const result = serializeSelection(transcript, range, Infinity);
  if (!result?.hasMath) return false;
  event.clipboardData.setData('text/plain', result.text);
  event.preventDefault(); return true;
}
