import { describe, expect, it } from 'vitest';
import { emptyIndex, type ProjectIndex } from '../src/core/types';
import { enrichIndex } from '../src/packages';
import { expandSnippet } from '../src/overleaf/snippet';

function project(packages: string[]): ProjectIndex {
  return { ...emptyIndex(), packages: packages.map(name => ({ name, options: [], source: 'main.tex' })) };
}

describe('package completion catalog', () => {
  it('adds physics hints only for a project that uses the package', () => {
    expect(enrichIndex(project([])).commands.some(command => command.name === 'dv')).toBe(false);
    const result = enrichIndex(project(['physics']));
    for (const name of ['dv', 'pdv', 'qty', 'bra', 'ket', 'braket', 'derivative', 'vectorbold']) {
      expect(result.commands.find(command => command.name === name)?.preview).toBe('supported');
    }
    const derivative = result.commands.find(command => command.name === 'dv')!;
    expect(derivative.signature).toBe('\\dv[order]{f}{x}');
    expect(derivative.snippet).toBe('\\dv{${1:f}}{${2:x}}');
    expect(derivative.source).toBe('package:physics');
    expect(result.commands.every(command => !command.name.startsWith('\\'))).toBe(true);
  });

  it('expands package and fallback snippets with the actual editor insertion utility', () => {
    const index = project(['physics', 'mathtools', 'amsmath', 'bm']);
    index.macros.push({ name: 'custom', body: '#1+#2', args: 2, raw: '', kind: 'newcommand', source: 'macros.sty', offset: 0, supported: true });
    const result = enrichIndex(index);
    const pdv = expandSnippet(result.commands.find(command => command.name === 'pdv')!.snippet!);
    expect(pdv.text).toBe('\\pdv{f}{x}');
    expect(pdv.ranges.map(range => pdv.text.slice(range.from, range.to))).toEqual(['f', 'x']);
    expect(expandSnippet(result.commands.find(command => command.name === 'custom')!.snippet!).text).toBe('\\custom{arg1}{arg2}');
    for (const entry of result.commands) {
      expect(expandSnippet(entry.snippet!).text).not.toContain('${');
    }
  });

  it('keeps custom command metadata and precedence, without mutating its input', () => {
    const index = project(['physics']);
    index.commands.push({ name: 'qty', signature: '\\qty{x}', snippet: '\\qty{${x}}', source: 'macros.sty', preview: 'supported' });
    index.macros.push({ name: 'dv', body: '#1^2', args: 1, raw: '', kind: 'newcommand', source: 'macros.sty', offset: 0, supported: true });
    const before = JSON.stringify(index);
    const result = enrichIndex(index);
    expect(result.commands.find(command => command.name === 'qty')?.source).toBe('macros.sty');
    expect(result.commands.find(command => command.name === 'dv')?.source).toBe('macros.sty');
    expect(result.commands.filter(command => command.name === 'qty')).toHaveLength(1);
    expect(JSON.stringify(index)).toBe(before);
    expect(enrichIndex(result)).toEqual(result);
  });

  it('does not warn about layout packages or local macro files', () => {
    const index = project(['geometry', 'graphicx', 'hyperref', 'amsthm', 'xparse', 'macros']);
    index.files = ['main.tex', 'macros.sty'];
    expect(enrichIndex(index).diagnostics).toEqual([]);
  });

  it('distinguishes unsupported math packages from unrecognized package catalogs', () => {
    const result = enrichIndex(project(['bbm', 'slashed', 'customPackage']));
    expect(result.diagnostics.find(diagnostic => diagnostic.message.startsWith('bbm'))?.level).toBe('warning');
    expect(result.diagnostics.find(diagnostic => diagnostic.message.includes('customPackage'))?.level).toBe('info');
    expect(result.commands.some(command => command.name === 'mathbbm')).toBe(false);
  });

  it('flags physics option limitations and ambiguous qty without reporting ordinary options', () => {
    const index = project(['physics', 'siunitx']);
    index.packages[0].options = ['italicdiff', 'arrowdel', 'notrig'];
    const result = enrichIndex(index);
    expect(result.diagnostics.some(diagnostic => diagnostic.message.includes('notrig'))).toBe(true);
    expect(result.diagnostics.filter(diagnostic => /不支持选项/.test(diagnostic.message))[0].message).not.toContain('italicdiff');
    expect(result.commands.find(command => command.name === 'qty')?.preview).toBe('unsupported');
  });
});
