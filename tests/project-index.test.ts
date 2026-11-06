import { describe, expect, it } from 'vitest';
import { buildProjectIndex } from '../src/core/project-index';
import { DEFAULT_SETTINGS, type ProjectFile, type Settings } from '../src/core/types';

async function indexFixture(contents: Record<string, string>, settingOverrides: Partial<Settings> = {}) {
  const files: ProjectFile[] = Object.keys(contents).map((path, index) => ({ path, id: 'synthetic-' + index, kind: 'doc' }));
  const reads: string[] = [];
  const index = await buildProjectIndex({ files, rootPath: 'main.tex', settings: { ...DEFAULT_SETTINGS, ...settingOverrides }, readFile: async file => {
    reads.push(file.path); return contents[file.path];
  } });
  return { index, reads };
}

describe('project dependency indexing', () => {
  it('follows local packages and inputs in source order, then applies later overrides', async () => {
    const { index, reads } = await indexFixture({
      'main.tex': String.raw`\def\choice{before}\usepackage{local,physics}\input{sections/body}\renewcommand\choice{after}`,
      'local.sty': String.raw`\RequirePackage{amsmath}\def\choice{package}`,
      'sections/body.tex': String.raw`\def\choice{body}\newcommand\fromBody{B}`,
    }, { extraFilesMode: 'none' });
    expect(index.macros.find(macro => macro.name === 'choice')?.body).toBe('after');
    expect(index.packages.map(pkg => pkg.name)).toEqual(['local', 'amsmath', 'physics']);
    expect(reads).toEqual(['main.tex', 'local.sty', 'sections/body.tex']);
    expect(index.commands.find(command => command.name === 'fromBody')?.snippet).toBe('\\fromBody');
  });

  it('keeps normally loaded macros when extra-file mode is none', async () => {
    const { index } = await indexFixture({ 'main.tex': String.raw`\usepackage{macros}`, 'macros.sty': String.raw`\def\kept{K}` }, { extraFilesMode: 'none' });
    expect(index.macros.map(macro => macro.name)).toEqual(['kept']);
  });

  it('automatically adds only a uniquely named extra file', async () => {
    const single = await indexFixture({ 'main.tex': '', 'support/macros.sty': String.raw`\def\extra{E}` });
    expect(single.index.macros.map(macro => macro.name)).toEqual(['extra']);
    const multiple = await indexFixture({ 'main.tex': '', 'a/macros.sty': String.raw`\def\a{A}`, 'b/macros.sty': String.raw`\def\b{B}` });
    expect(multiple.index.macros).toEqual([]);
    expect(multiple.index.diagnostics.some(item => item.message.includes('多份'))).toBe(true);
    const missing = await indexFixture({ 'main.tex': '' });
    expect(missing.index.macros).toEqual([]);
  });

  it('uses only exact manual extra-file paths and does not guess basename matches', async () => {
    const { index } = await indexFixture({ 'main.tex': '', 'a/custom.sty': String.raw`\def\manual{M}`, 'b/custom.sty': String.raw`\def\wrong{W}` }, { extraFilesMode: 'manual', extraFiles: ['a/custom.sty', 'missing.sty'] });
    expect(index.macros.map(macro => macro.name)).toEqual(['manual']);
    expect(index.diagnostics.some(item => item.message.includes('missing.sty'))).toBe(true);
  });

  it('preserves providecommand semantics and captures known let targets', async () => {
    const { index } = await indexFixture({ 'main.tex': String.raw`\newcommand\target[1]{A#1}\providecommand\target{ignored}\let\saved\target\renewcommand\target[1]{B#1}` });
    expect(index.macros.find(macro => macro.name === 'saved')).toMatchObject({ body: 'A#1', args: 1, supported: true });
    expect(index.macros.find(macro => macro.name === 'target')?.body).toBe('B#1');
  });

  it('stops cyclic includes while retaining independent declarations', async () => {
    const { index, reads } = await indexFixture({ 'main.tex': String.raw`\input{a}\def\ok{O}`, 'a.tex': String.raw`\input{main}\def\inA{A}` });
    expect(reads).toEqual(['main.tex', 'a.tex']);
    expect(index.macros.map(macro => macro.name)).toEqual(['inA', 'ok']);
    expect(index.diagnostics.some(item => item.message.includes('循环文件'))).toBe(true);
  });

  it('flags recursive macro chains and unsupported dependency propagation', async () => {
    const { index } = await indexFixture({ 'main.tex': String.raw`\def\a{\b}\def\b{\a}\def\drawn{\tikz{}}\def\alias{\drawn}` });
    expect(index.macros.every(macro => !macro.supported)).toBe(true);
    expect(index.diagnostics.some(item => item.message.includes('循环依赖'))).toBe(true);
  });

  it('replays repeated input definitions but reads each file only once', async () => {
    const { index, reads } = await indexFixture({ 'main.tex': String.raw`\input{part}\def\value{middle}\input{part}`, 'part.tex': String.raw`\def\value{part}` });
    expect(reads).toEqual(['main.tex', 'part.tex']);
    expect(index.macros.find(macro => macro.name === 'value')?.body).toBe('part');
  });

  it('does not read oversized content or dynamically computed paths', async () => {
    const { index, reads } = await indexFixture({ 'main.tex': String.raw`\input{\computed}\input{large}`, 'large.tex': 'x'.repeat(1_000_001) });
    expect(reads).toEqual(['main.tex', 'large.tex']);
    expect(index.files).toEqual(['main.tex']);
    expect(index.diagnostics.some(item => item.message.includes('过大'))).toBe(true);
    expect(index.diagnostics.some(item => item.message.includes('静态解析'))).toBe(true);
  });

  it('reports unavailable root and file-read failures as diagnostics', async () => {
    const missing = await buildProjectIndex({ files: [], rootPath: 'missing.tex', settings: DEFAULT_SETTINGS, readFile: async () => '' });
    expect(missing.diagnostics.some(item => item.level === 'error')).toBe(true);
    const failed = await buildProjectIndex({ files: [{ id: 'x', path: 'main.tex', kind: 'doc' }], rootPath: 'main.tex', settings: DEFAULT_SETTINGS, readFile: async () => { throw new Error('unavailable'); } });
    expect(failed.diagnostics.some(item => item.message.includes('无法读取'))).toBe(true);
  });
});
