import { describe, expect, it } from 'vitest';
import { buildProjectIndex } from '../src/core/project-index';
import { applyPreviewSources, getPreviewSources } from '../src/core/preview-sources';
import { DEFAULT_SETTINGS, type ProjectIndex, type PreviewSourceSetting } from '../src/core/types';

async function fixture(contents: Record<string, string>) {
  return buildProjectIndex({ files: Object.keys(contents).map((path, id) => ({ path, id: String(id), kind: 'doc' })), rootPath: 'main.tex',
    settings: DEFAULT_SETTINGS, readFile: async file => contents[file.path] });
}
function preferences(index: ProjectIndex, disabled: string[] = []): PreviewSourceSetting[] {
  return getPreviewSources(index, {}).map(source => ({ id: source.id, enabled: !disabled.includes(source.id) }));
}

describe('independent preview source selection', () => {
  it('catalogs main definitions, external packages and one identity for a local style package', async () => {
    const index = await fixture({ 'main.tex': String.raw`\def\root{R}\usepackage{physics,macros}\input{macros.sty}`, 'macros.sty': String.raw`\def\local{L}` });
    expect(index.previewSources).toEqual([
      expect.objectContaining({ id: 'file:main.tex', kind: 'file', name: 'main.tex' }),
      expect.objectContaining({ id: 'package:physics', kind: 'package', packageName: 'physics' }),
      expect.objectContaining({ id: 'file:macros.sty', kind: 'file', packageName: 'macros', path: 'macros.sty' }),
    ]);
    expect(applyPreviewSources(index, {})).toBe(index);
  });

  it('places local style definitions after their imported dependencies while preserving their original load tape', async () => {
    const index = await fixture({ 'main.tex': String.raw`\usepackage[option=a]{macros}`, 'macros.sty': String.raw`\RequirePackage{amsmath,physics}\def\local{L}` });
    expect(index.previewSources?.map(source => source.id)).toEqual(['package:amsmath', 'package:physics', 'file:macros.sty']);
    expect(index.previewSources?.at(-1)).toMatchObject({ packageName: 'macros', options: ['option=a'] });
    expect(index.previewEvents?.filter(event => event.type === 'package').map(event => event.package.name)).toEqual(['macros', 'amsmath', 'physics']);
    const replay = applyPreviewSources(index, { previewSources: preferences(index) });
    expect(replay.previewSourceOrder).toBeUndefined();
    expect(replay.packages.map(pkg => pkg.name)).toEqual(['macros', 'amsmath', 'physics']);
  });

  it('disables preview definitions and packages while retaining the complete completion index', async () => {
    const index = await fixture({ 'main.tex': String.raw`\usepackage{physics}\def\root{R}`, 'macros.sty': String.raw`\def\extra{E}` });
    const result = applyPreviewSources(index, { previewSources: preferences(index, ['package:physics', 'file:macros.sty']) });
    expect(result.packages).toEqual([]);
    expect(result.macros.map(macro => macro.name)).toEqual(['root']);
    expect(result.commands).toBe(index.commands);
    expect(index.macros.map(macro => macro.name)).toEqual(['root', 'extra']);
  });

  it('preserves interleaving and repeated input for no-op settings and disabling-only changes', async () => {
    const index = await fixture({ 'main.tex': String.raw`\def\choice{A}\input{part}\def\choice{C}\usepackage{physics}`, 'part.tex': String.raw`\def\choice{B}` });
    for (const disabled of [[], ['package:physics']]) {
      const result = applyPreviewSources(index, { previewSources: preferences(index, disabled) });
      expect(result.macros.find(macro => macro.name === 'choice')?.body).toBe('C');
      expect(result.previewSourceOrder).toBeUndefined();
    }
    const repeated = await fixture({ 'main.tex': String.raw`\input{part}\def\choice{C}\input{part}\usepackage{physics}`, 'part.tex': String.raw`\def\choice{B}` });
    expect(applyPreviewSources(repeated, { previewSources: preferences(repeated, ['package:physics']) }).macros.find(macro => macro.name === 'choice')?.body).toBe('B');
  });

  it('restores shadowed definitions when a later file is disabled or reordered', async () => {
    const index = await fixture({ 'main.tex': String.raw`\input{first}\input{second}`, 'first.tex': String.raw`\def\choice{A}`, 'second.tex': String.raw`\def\choice{B}` });
    expect(applyPreviewSources(index, { previewSources: preferences(index, ['file:second.tex']) }).macros[0].body).toBe('A');
    const result = applyPreviewSources(index, { previewSources: preferences(index).reverse() });
    expect(result.macros[0].body).toBe('A');
    expect(result.previewSourceOrder).toEqual(['file:second.tex', 'file:first.tex']);
    expect(index.macros[0].body).toBe('B');
  });

  it('replays provide and let semantics rather than filtering the final macro map', async () => {
    const index = await fixture({ 'main.tex': String.raw`\input{base}\input{fallback}`, 'base.tex': String.raw`\def\choice{A}`, 'fallback.tex': String.raw`\providecommand\choice{B}\let\snapshot\choice\def\choice{C}` });
    const result = applyPreviewSources(index, { previewSources: preferences(index, ['file:base.tex']) });
    expect(result.macros.find(macro => macro.name === 'snapshot')).toMatchObject({ body: 'B', supported: true });
    expect(result.macros.find(macro => macro.name === 'choice')?.body).toBe('C');
  });

  it('checks cycles through optional defaults and keeps possible builtin fallbacks usable', async () => {
    const index = await fixture({ 'main.tex': String.raw`\input{override}\input{derived}`, 'override.tex': String.raw`\def\alpha{custom}`, 'derived.tex': String.raw`\newcommand\show[1][\alpha]{#1}\newcommand\loop[1][\loop]{#1}` });
    const result = applyPreviewSources(index, { previewSources: preferences(index, ['file:override.tex']) });
    expect(result.macros.find(macro => macro.name === 'show')?.supported).toBe(true);
    expect(result.macros.find(macro => macro.name === 'loop')?.supported).toBe(false);
    expect(result.diagnostics.some(item => item.message.includes('同名内置'))).toBe(true);
  });

  it('treats listed dependencies independently and appends newly discovered sources', async () => {
    const index = await fixture({ 'main.tex': String.raw`\usepackage{parent}`, 'parent.sty': String.raw`\RequirePackage{physics}\def\parent{P}`, 'macros.sty': String.raw`\def\extra{E}` });
    const settings = { previewSources: [{ id: 'file:parent.sty', enabled: false }] };
    const sources = getPreviewSources(index, settings);
    expect(sources.map(source => [source.id, source.enabled])).toEqual([['file:parent.sty', false], ['package:physics', true], ['file:macros.sty', true]]);
    const result = applyPreviewSources(index, settings);
    expect(result.packages.map(pkg => pkg.name)).toEqual(['physics']);
    expect(result.macros.map(macro => macro.name)).toEqual(['extra']);
  });
});
