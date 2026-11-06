import { describe, expect, it } from 'vitest';
import { emptyIndex } from '../src/core/types';
import { enrichIndex, PACKAGE_CATALOG } from '../src/packages';
import { expandSnippet } from '../src/overleaf/snippet';
import { renderFormula } from '../src/preview/render';

describe('supported package completion/rendering contract', () => {
  it.each(Object.keys(PACKAGE_CATALOG))('renders every supported %s completion with valid representative arguments', async packageName => {
    const index = enrichIndex({ ...emptyIndex(), packages: [{ name: packageName, options: [], source: 'main.tex' }] });
    const failures: string[] = [];
    for (const entry of PACKAGE_CATALOG[packageName]) {
      const completion = index.commands.find(command => command.name === entry.name)!;
      if (completion.preview !== 'supported') continue;
      const expanded = expandSnippet(completion.snippet!);
      let expression = expanded.text;
      // Dimension placeholders are labels, not valid TeX numbers. Other
      // placeholders remain exactly as inserted by the editor's snippet code.
      for (let i = expanded.ranges.length - 1; i >= 0; i--) {
        if (!['n', 'rows', 'columns'].includes(entry.args?.[i] ?? '')) continue;
        const range = expanded.ranges[i];
        expression = expression.slice(0, range.from) + '2' + expression.slice(range.to);
      }
      // Declarations are tested by using the command they just declared.
      if (entry.name === 'DeclareMathOperator') expression += '\\Op(x)';
      if (entry.name === 'DeclarePairedDelimiter') expression += '\\delim{x}';
      // Physics deliberately returns matrix cells for these commands; the
      // surrounding matrix environment is supplied by the author.
      if (/^(?:imat|identitymatrix|zmat|zeromatrix|xmat|xmatrix|pmat|paulimatrix|dmat|diagonalmatrix|admat|antidiagonalmatrix)$/.test(entry.name)) {
        expression = `\\mqty(${expression})`;
      }
      const result = await renderFormula(expression, index, false);
      if (!result.svg || result.diagnostics.length) failures.push(`${expression}: ${result.diagnostics.join('; ')}`);
    }
    expect(failures).toEqual([]);
  });
  it('preserves a two-row matrix example through completion insertion and rendering', async () => {
    const index = enrichIndex({ ...emptyIndex(), packages: [{ name: 'physics', options: [], source: 'main.tex' }] });
    const snippet = index.commands.find(command => command.name === 'mqty')!.snippet!;
    const expression = expandSnippet(snippet).text;
    expect(expression).toBe('\\mqty{a & b \\\\ c & d}');
    const result = await renderFormula(expression, index, false);
    expect(result.diagnostics).toEqual([]);
    expect([...result.svg.matchAll(/data-mml-node="mtr"/g)]).toHaveLength(2);
    expect([...result.svg.matchAll(/data-mml-node="mtd"/g)]).toHaveLength(4);
  });
});
