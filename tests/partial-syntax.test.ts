// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { emptyIndex, type MacroDefinition } from '../src/core/types';
import { renderFormula } from '../src/preview/render';

const parse = (svg: string) => new DOMParser().parseFromString(svg, 'image/svg+xml');
const red = (node: Element) => !!node.closest('[fill="#c62828"], [color="#c62828"]');
const tolerant = (tex: string) => renderFormula(tex, emptyIndex(), false, { tolerant: true });
const glyph = (doc: Document, code: string) => doc.querySelector(`[data-c="${code}"]`)!;

describe('partial structural errors during typing', () => {
  it('only marks V_ red in the reported formula and keeps E_5 and partial_y typeset', async () => {
    const tex = String.raw`E_5=\partial_y-V_`;
    const result = await tolerant(tex);
    expect(result.fallbackText).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    const doc = parse(result.svg);
    for (const code of ['1D438', '35', '3D', '1D715', '1D466', '2212']) {
      expect(glyph(doc, code), code).not.toBeNull();
      expect(red(glyph(doc, code)), code).toBe(false);
    }
    expect(red(glyph(doc, '1D449'))).toBe(true);
    expect(red(glyph(doc, '5F'))).toBe(true);
    expect(doc.querySelectorAll('[data-mml-node="msub"]')).toHaveLength(2);
    expect((await renderFormula(tex, emptyIndex(), false)).svg).toBe('');
  });

  it.each([
    String.raw`a+{V_}+b`,
    String.raw`a+\frac{V_}{2}+b`,
    String.raw`a+\sqrt{V_}+b`,
    String.raw`a+\left(V_\right)+b`,
    String.raw`a+\begin{matrix}V_&x\\y&z\end{matrix}+b`,
    String.raw`a+\begin{matrix}x&V_\end{matrix}+b`,
    String.raw`a+\begin{aligned}V_&=x\\y&=z\end{aligned}+b`,
  ])('replays the boundary and keeps the surrounding valid formula: %s', async tex => {
    const result = await tolerant(tex);
    const doc = parse(result.svg);
    expect(result.svg).not.toBe('');
    expect(result.svg).not.toContain('merror');
    expect(result.fallbackText).toBeUndefined();
    expect(red(glyph(doc, '1D449'))).toBe(true);
    for (const code of ['1D44E', '1D44F']) expect(red(glyph(doc, code))).toBe(false);
    if (tex.includes('frac')) expect(doc.querySelector('[data-mml-node="mfrac"]')).not.toBeNull();
    if (tex.includes('begin')) expect(doc.querySelector('[data-mml-node="mtable"]')).not.toBeNull();
  });

  it.each([
    ['a+V^2_', '32'], ['a+V_2^', '32'], ["a+V'_", '2032'],
    [String.raw`a+\sum_{i=1}^`, '2211'], ['a+{V^}', '5E'],
  ])('preserves existing scripts and primes: %s', async (tex, retained) => {
    const result = await tolerant(tex);
    const doc = parse(result.svg);
    expect(result.svg).not.toBe('');
    expect(glyph(doc, retained)).not.toBeNull();
    expect(red(glyph(doc, '1D44E'))).toBe(false);
    expect(red(glyph(doc, retained))).toBe(true);
  });

  it.each(['a+V_', 'a+V_{', 'a+V_{i', 'a+V_{i+{j', 'a+{V', 'a+{{V'])('keeps a valid prefix while the next group is unfinished: %s', async tex => {
    const result = await tolerant(tex);
    const doc = parse(result.svg);
    expect(result.svg).not.toBe('');
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(red(glyph(doc, '1D44E'))).toBe(false);
    expect(red(glyph(doc, '1D449'))).toBe(true);
    if (tex.includes('{')) expect(red(glyph(doc, '7B'))).toBe(true);
  });

  it('restores the exact normal layout after completion, with no state shared with later renders', async () => {
    for (const tex of ['E_5=\\partial_y-V_', 'E_5=\\partial_y-V_{', 'E_5=\\partial_y-V_{i']) {
      expect((await tolerant(tex)).svg).toContain('#c62828');
    }
    const tex = String.raw`E_5=\partial_y-V_{i}`;
    const result = await tolerant(tex);
    expect(result.diagnostics).toEqual([]);
    expect(result.svg).not.toContain('#c62828');
    expect(result.svg).toBe((await renderFormula(tex, emptyIndex(), false)).svg);
    expect((await renderFormula('V_', emptyIndex(), false)).svg).toBe('');
  });

  it('recovers scripts in project macro expansions without changing their meaning', async () => {
    const macro: MacroDefinition = { name: 'unfinished', body: 'V_', args: 0, raw: '', kind: 'newcommand', source: 'macros.sty', offset: 0, supported: true };
    const index = { ...emptyIndex(), macros: [macro] };
    const result = await renderFormula(String.raw`a+{\unfinished}+b`, index, false, { tolerant: true });
    expect(result.svg).not.toBe('');
    expect(red(glyph(parse(result.svg), '1D449'))).toBe(true);
    expect((await renderFormula(String.raw`a+{\unfinished}+b`, index, false)).svg).toBe('');
  });

  it('keeps hard recovery limits and does not guess missing command arguments', async () => {
    const limited = await tolerant('a+' + '{V_}+'.repeat(65) + 'b');
    expect(limited.svg).toBe('');
    expect(limited.fallbackText).toBeUndefined();
    expect(limited.diagnostics.join(' ')).toContain('超过预览限制');
    for (const tex of [String.raw`a+\frac{x}`, String.raw`a+V_\frac{x}`]) {
      const result = await tolerant(tex);
      expect(result.svg).toBe('');
      expect(result.fallbackText).toBe(tex);
    }
  });
});
