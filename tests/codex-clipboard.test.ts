// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyRenderedMathSelection, readRenderedSelection, writeClipboardText } from '../src/codex/clipboard';
import { getRenderedMathSource, renderAssistantMessage } from '../src/codex/message-renderer';

const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>x</text></svg>';
function message(source: string) {
  const transcript = document.createElement('div'), body = document.createElement('div'); body.className = 'opt-codex-message-body'; transcript.append(body); document.body.append(transcript);
  renderAssistantMessage(body, source, { renderMath: async () => svg }); return { transcript, body };
}
function copied(range: Range, transcript: HTMLElement) {
  document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
  const setData = vi.fn(), event = new Event('copy', { cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', { value: { setData } });
  const handled = copyRenderedMathSelection(event, transcript); return { handled, setData, event };
}
afterEach(() => { document.body.replaceChildren(); document.getSelection()?.removeAllRanges(); vi.unstubAllGlobals(); vi.restoreAllMocks(); delete (document as unknown as { execCommand?: unknown }).execCommand; });

describe('assistant LaTeX clipboard', () => {
  it('copies selected prose with hydrated formulas as original LaTeX and preserves the visible selection', async () => {
    const { transcript, body } = message('Before \\(x=1\\) and \\[\\frac{x}{2}\\] after.');
    await vi.waitFor(() => expect(body.querySelectorAll('svg')).toHaveLength(2));
    const range = document.createRange(); range.selectNodeContents(body);
    const { handled, setData, event } = copied(range, transcript);
    expect(handled).toBe(true); expect(event.defaultPrevented).toBe(true);
    expect(setData).toHaveBeenCalledExactlyOnceWith('text/plain', 'Before \\(x=1\\) and \\[\\frac{x}{2}\\] after.');
    expect(document.getSelection()!.getRangeAt(0).startContainer).toBe(body);
    expect(body.querySelectorAll('svg')).toHaveLength(2);
  });
  it('expands a selection inside an SVG glyph to the complete formula source', async () => {
    const { transcript, body } = message('\\(\\Omega_5\\)');
    await vi.waitFor(() => expect(body.querySelector('svg text')).not.toBeNull());
    const glyph = body.querySelector('svg text')!.firstChild!, range = document.createRange(); range.setStart(glyph, 0); range.setEnd(glyph, 1);
    expect(copied(range, transcript).setData).toHaveBeenCalledWith('text/plain', '\\(\\Omega_5\\)');
  });
  it('leaves ordinary prose copying alone and keeps a formula source current across delimiter changes', () => {
    const { transcript, body } = message('Plain prose.'); const range = document.createRange(); range.selectNodeContents(body);
    expect(copied(range, transcript).handled).toBe(false);
    renderAssistantMessage(body, '\\(x\\)'); const formula = body.querySelector('.opt-codex-math')!;
    renderAssistantMessage(body, '$x$'); expect(body.querySelector('.opt-codex-math')).toBe(formula);
    expect(getRenderedMathSource(formula)?.original).toBe('$x$');
  });
  it('falls back to a temporary copy buffer and restores the composer caret', async () => {
    const writeText = vi.fn(async () => { throw new Error('Clipboard API blocked'); }); vi.stubGlobal('navigator', { clipboard: { writeText } });
    const input = document.createElement('textarea'); input.value = 'A draft'; document.body.append(input); input.focus(); input.setSelectionRange(2, 5);
    const exec = vi.fn(() => { expect(document.querySelectorAll('textarea')[1].value).toBe('\\frac{x}{y}'); return true; });
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    await writeClipboardText('\\frac{x}{y}');
    expect(exec).toHaveBeenCalledExactlyOnceWith('copy'); expect(document.querySelectorAll('textarea')).toHaveLength(1);
    expect(document.activeElement).toBe(input); expect(input.selectionStart).toBe(2); expect(input.selectionEnd).toBe(5);
  });
});


describe('assistant answer quotation selection', () => {
  it('reads a selected prose substring without trimming selected spaces or changing the selection', () => {
    const { body } = message('Before **a chosen phrase** after.');
    const before = body.querySelector('p')!.firstChild!, after = body.querySelector('p')!.lastChild!;
    const range = document.createRange(); range.setStart(before, 6); range.setEnd(after, 6);
    document.getSelection()!.addRange(range);
    const actual = document.getSelection()!.getRangeAt(0);
    expect(readRenderedSelection(body)).toBe(' a chosen phrase after');
    expect(document.getSelection()!.getRangeAt(0)).toBe(actual);
    expect(actual.startContainer).toBe(before); expect(actual.startOffset).toBe(6);
    expect(actual.endContainer).toBe(after); expect(actual.endOffset).toBe(6);
  });
  it('preserves block boundaries and selected code whitespace without inventing a final newline', () => {
    const { body } = message('First paragraph.\n\n- List one\n- List two\n\n```tex\n  x = 1\n    y = 2\n```\n\nLast paragraph.');
    const range = document.createRange(); range.selectNodeContents(body);
    expect(readRenderedSelection(body, range)).toBe('First paragraph.\nList one\nList two\n  x = 1\n    y = 2\nLast paragraph.');
    const code = body.querySelector('pre code')!.firstChild!;
    range.setStart(code, 0); range.setEnd(code, 8);
    expect(readRenderedSelection(body, range)).toBe('  x = 1\n');
  });
  it('keeps inline code literal instead of interpreting it as a mathematical expression', () => {
    const { body } = message('Use `\\alpha + $x$` here.');
    const range = document.createRange(); range.selectNodeContents(body);
    expect(readRenderedSelection(body, range)).toBe('Use \\alpha + $x$ here.');
  });
  it('quotes selected hydrated formulas with their original delimiters without cloning SVG trees', async () => {
    const { body } = message('Before \\(x=1\\) and \\[\\frac{x}{2}\\] after.');
    await vi.waitFor(() => expect(body.querySelectorAll('svg')).toHaveLength(2));
    const range = document.createRange(); range.selectNodeContents(body);
    vi.spyOn(Range.prototype, 'cloneContents').mockImplementation(() => { throw new Error('Do not clone SVG DOM'); });
    expect(readRenderedSelection(body, range)).toBe('Before \\(x=1\\) and \\[\\frac{x}{2}\\] after.');
    expect(body.querySelectorAll('svg')).toHaveLength(2);
  });
  it('expands a partial SVG endpoint but leaves the caller range unchanged', async () => {
    const { body } = message('Before \\(\\Omega_5\\) after.');
    await vi.waitFor(() => expect(body.querySelector('svg text')).not.toBeNull());
    const glyph = body.querySelector('svg text')!.firstChild!, prose = body.querySelector('p')!.firstChild!;
    const range = document.createRange(); range.setStart(prose, 2); range.setEnd(glyph, 1);
    expect(readRenderedSelection(body, range)).toBe('fore \\(\\Omega_5\\)');
    expect(range.endContainer).toBe(glyph); expect(range.endOffset).toBe(1);
  });
  it('rejects selections crossing message boundaries, collapsed ranges, and whitespace-only text', () => {
    const first = message('First.'), second = message('Second.');
    const range = document.createRange(); range.setStart(first.body.querySelector('p')!.firstChild!, 2); range.setEnd(second.body.querySelector('p')!.firstChild!, 2);
    expect(readRenderedSelection(first.body, range)).toBeUndefined();
    range.selectNodeContents(first.body); range.collapse();
    expect(readRenderedSelection(first.body, range)).toBeUndefined();
    first.body.textContent = '  \n  '; range.selectNodeContents(first.body);
    expect(readRenderedSelection(first.body, range)).toBeUndefined();
  });
  it('rejects multiple browser ranges and unknown math nodes rather than quoting SVG glyph text', () => {
    const { body } = message('Text.'); const range = document.createRange(); range.selectNodeContents(body);
    vi.spyOn(document, 'getSelection').mockReturnValue({ rangeCount: 2, isCollapsed: false, getRangeAt: () => range, removeAllRanges() {} } as unknown as Selection);
    expect(readRenderedSelection(body)).toBeUndefined();
    body.innerHTML = '<span class="opt-codex-math"><svg><text>wrong glyph text</text></svg></span>';
    range.selectNodeContents(body); expect(readRenderedSelection(body, range)).toBeUndefined();
  });
  it('enforces the complete quote limit without silently clipping text or LaTeX', () => {
    const { body } = message('x'.repeat(64_000)); const range = document.createRange(); range.selectNodeContents(body);
    expect(readRenderedSelection(body, range)?.length).toBe(64_000);
    body.firstElementChild!.append('y'); range.selectNodeContents(body);
    expect(readRenderedSelection(body, range)).toBeUndefined();
    renderAssistantMessage(body, 'a \\(b\\)'); range.selectNodeContents(body);
    expect(readRenderedSelection(body, range, 6)).toBeUndefined();
    expect(readRenderedSelection(body, range, 7)).toBe('a \\(b\\)');
  });
});
