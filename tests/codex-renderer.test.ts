// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderAssistantMessage } from '../src/codex/message-renderer';
import { renderFormula } from '../src/preview/render';
import { emptyIndex } from '../src/core/types';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0L1 1"/></svg>';
const target = () => { const value = document.createElement('div'); document.body.append(value); return value; };
const realMath = async (source: string, display: boolean) => (await renderFormula(source, emptyIndex(), display, { tolerant: true })).svg;
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
afterEach(() => document.body.replaceChildren());

describe('streamed Codex Markdown and mathematics', () => {
  it('keeps multiline paragraph boundary scanning linear instead of rebuilding every accumulated prefix', () => {
    const element = target();
    const source = Array.from({ length: 1000 }, (_, i) => `Long prose line ${i}: \\(x_${i}\\), followed by \\(y_${i}\\).`).join('\n');
    const join = Array.prototype.join;
    let joinedCharacters = 0;
    // Count copied source rather than timing a machine-dependent CPU threshold.
    // The previous prefix scanner copied this 60k paragraph roughly 500 times.
    const spy = vi.spyOn(Array.prototype, 'join').mockImplementation(function(this: string[], separator?: string) {
      if (separator === '\n' && typeof this[0] === 'string' && this[0].startsWith('Long prose')) {
        joinedCharacters += this.reduce((length, line) => length + line.length, 0);
      }
      return join.call(this, separator);
    });
    try { renderAssistantMessage(element, source); } finally { spy.mockRestore(); }
    expect(element.querySelectorAll('.opt-codex-math')).toHaveLength(2000);
    expect(joinedCharacters).toBeLessThanOrEqual(source.length * 2);
  });

  it('tracks multiline math boundaries past blank lines and Markdown-looking math content', async () => {
    const element = target(), renderMath = vi.fn(async (_source:string, _display:boolean)=>svg);
    const source = String.raw`Start \(a+

-b=c\) then finish.

- A display in a continued list item:
  \[
  a+

  -b=c
  \]
- Next item.`;
    renderAssistantMessage(element, source, { renderMath }); await flush();
    expect(element.querySelectorAll('svg')).toHaveLength(2);
    expect(element.querySelectorAll('li')).toHaveLength(2);
    expect(renderMath.mock.calls).toEqual([['a+\n\n-b=c',false],['a+\n\n-b=c',true]]);
  });

  it('renders every formula in the real 87-expression long-answer regression, including the last bullet points', async () => {
    const element = target();
    const early = Array.from({length:80}, (_, i) => `- Formula \\(x_{${i}}\\).`).join('\n');
    const late = String.raw`- 选中段落之前的 “the reducing direction is \(E_5\)” 不准确。实施零模截断的是 \(K=\partial_y|_x\)；\(E_5\) 是进入正交标架计算的方向。
- 后面分隔线之后又保留了一套没有 \(1/\sqrt2\) 的公式。在 \(\sigma\)、几何向量 \(V\) 和 \(Q\psi=D\sigma\) 的约定都不变时，它不能直接与当前这套公式混用。`;
    const dispose = renderAssistantMessage(element, early + '\n' + late, { renderMath: realMath });
    await vi.waitFor(() => expect(element.querySelectorAll('.opt-codex-math svg')).toHaveLength(87), {timeout:5000,interval:10});
    expect([...element.querySelectorAll('.opt-codex-math')].slice(80).map(node=>node.getAttribute('aria-label')))
      .toEqual(['E_5','K=\\partial_y|_x','E_5','1/\\sqrt2','\\sigma','V','Q\\psi=D\\sigma']);
    expect(element.textContent).not.toContain('\\('); dispose();
  });

  it('preserves hydrated blocks and SVG identity when later stream chunks append text and math', async () => {
    const element = target(), renderMath = vi.fn(async (_source:string, _display:boolean) => svg), layout = vi.fn((mutate:()=>void)=>mutate());
    const dispose = renderAssistantMessage(element, 'Start \\(x\\).\n\n- Item', {renderMath,onLayout:layout}); await flush();
    const paragraph = element.firstChild, math = element.querySelector('.opt-codex-math'), image = element.querySelector('svg');
    dispose();
    renderAssistantMessage(element, 'Start \\(x\\).\n\n- Item grew with \\(y\\).', {renderMath,onLayout:layout}); await flush();
    expect(element.firstChild).toBe(paragraph); expect(element.querySelector('.opt-codex-math')).toBe(math);
    expect(element.querySelector('svg')).toBe(image); expect(element.querySelectorAll('svg')).toHaveLength(2);
    expect(renderMath.mock.calls.map(([source])=>source)).toEqual(['x','y']);
    expect(layout).toHaveBeenCalledTimes(4); // two block updates and two later math replacements
  });

  it('keeps an in-flight unchanged equation alive across rerenders without starting duplicate work', async () => {
    const element = target(); let resolve!: (value:string)=>void;
    const renderMath = vi.fn(() => new Promise<string>(done => { resolve = done; }));
    const dispose = renderAssistantMessage(element, 'Pending \\(x\\)', {renderMath});
    const math = element.querySelector('.opt-codex-math'); dispose();
    renderAssistantMessage(element, 'Pending \\(x\\) with more words', {renderMath});
    expect(renderMath).toHaveBeenCalledTimes(1); resolve(svg); await flush();
    expect(element.querySelector('.opt-codex-math')).toBe(math); expect(math!.querySelector('svg')).not.toBeNull();
  });

  it('does not hydrate detached or disposed equation nodes', async () => {
    const element = target(); let resolve!: (value:string)=>void;
    const dispose = renderAssistantMessage(element, '\\(x\\)', {renderMath:()=>new Promise(done=>{resolve=done;})});
    const old = element.querySelector('.opt-codex-math')!; dispose();
    renderAssistantMessage(element, 'Replacement'); resolve(svg); await flush();
    expect(old.querySelector('svg')).toBeNull(); expect(element.textContent).toBe('Replacement');
  });

  it('waits for matching streamed delimiters and preserves the containing paragraph', async () => {
    const element = target(), renderMath = vi.fn(async (_source:string, _display:boolean)=>svg);
    let dispose = renderAssistantMessage(element, 'Value \\(x_', {renderMath});
    const paragraph=element.firstChild; expect(renderMath).not.toHaveBeenCalled();
    dispose(); dispose=renderAssistantMessage(element, 'Value \\(x_1\\', {renderMath});
    expect(renderMath).not.toHaveBeenCalled(); dispose();
    renderAssistantMessage(element, 'Value \\(x_1\\) and $y$', {renderMath}); await flush();
    expect(element.firstChild).toBe(paragraph);
    expect(renderMath.mock.calls.map(([source])=>source)).toEqual(['x_1','y']);
    expect(element.querySelectorAll('svg')).toHaveLength(2);
  });

  it('renders multiline and display mathematics inside continued and nested list items', async () => {
    const element=target();
    const input=String.raw`- An inline equation \(a+
b=c\) continues on another line.
  With display math:
  \[
  \frac{1}{\sqrt{2}}V^\mu D_\mu X
  \]
  - Nested \(E_5\).
- The next item has $$x^2=1$$.`;
    renderAssistantMessage(element,input,{renderMath:realMath});
    await vi.waitFor(()=>expect(element.querySelectorAll('svg')).toHaveLength(4),{timeout:3000,interval:10});
    expect(element.querySelectorAll('li')).toHaveLength(3);
    expect(element.querySelectorAll('.opt-codex-math-display')).toHaveLength(2);
    expect(element.querySelector('ul ul')).not.toBeNull();
  });

  it('renders standalone AMS environments and protects code and raw HTML', async () => {
    const element=target();
    const input=[String.raw`\begin{align*}
a&=b\\
c&=d
\end{align*}`,
      'Inline code: `\\(do_not_render\\)`',
      '```latex\n\\[keep_source\\]\n```',
      '<img src=x onerror=alert(1)> [unsafe](javascript:alert) [safe](https://example.com/reference)',
    ].join('\n\n');
    const renderMath=vi.fn(realMath); renderAssistantMessage(element,input,{renderMath});
    await vi.waitFor(()=>expect(element.querySelectorAll('svg')).toHaveLength(1),{timeout:3000,interval:10});
    expect(renderMath).toHaveBeenCalledTimes(1);
    expect(element.querySelector('svg [data-mml-node="mtable"]')).not.toBeNull();
    expect(element.querySelector('pre code')!.textContent).toBe('\\[keep_source\\]');
    expect(element.querySelector('img')).toBeNull(); expect(element.querySelectorAll('a')).toHaveLength(1);
    expect(element.querySelector('a')!.rel).toBe('noopener noreferrer');
  });

  it('keeps an oversized single formula as source without preventing subsequent small formulas', async () => {
    const element=target(), renderMath=vi.fn(async (_source:string, _display:boolean)=>svg);
    renderAssistantMessage(element,'\\('+ 'x'.repeat(12_001)+'\\) then \\(y\\)',{renderMath}); await flush();
    expect(renderMath).toHaveBeenCalledTimes(1); expect(renderMath).toHaveBeenCalledWith('y',false);
    expect(element.querySelectorAll('svg')).toHaveLength(1); expect(element.textContent).toContain('x'.repeat(12_001));
  });
});
