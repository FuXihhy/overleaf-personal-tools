import { describe, expect, it, vi } from 'vitest';
import { buildCloudDocument, extractCloudPreamble } from '../src/preview/cloud-document';
import { DEFAULT_SETTINGS, type ProjectFile, type Settings } from '../src/core/types';

async function buildFixture(contents: Record<string, string>, settings: Partial<Settings> = {}, formula = String.raw`\pdv{f}{x}+\custom`, display = true) {
  const files: ProjectFile[] = Object.keys(contents).map((path, id) => ({ id: String(id), path, kind: 'doc' }));
  const result = await buildCloudDocument({ files, rootPath: 'main.tex', readFile: async file => contents[file.path], settings: { ...DEFAULT_SETTINGS, ...settings }, formula, display });
  return { ...result, entry: result.files.find(file => file.path === result.entryPath)!.content };
}

describe('cloud preamble extraction', () => {
  it('keeps the actual class, packages and complete definitions without copying body into the entry', async () => {
    const preamble = String.raw`\documentclass[11pt]{article}
\usepackage{physics}
\NewDocumentCommand\custom{O{\mathbb{R}} m}{\IfNoValueTF{#1}{#2}{#1+#2}}
`;
    const original = preamble + String.raw`\begin{document}ORIGINAL BODY MUST NOT COMPILE\end{document}`;
    const result = await buildFixture({ 'main.tex': original }, { extraFilesMode: 'none' });
    expect(result.entry).toContain(preamble);
    expect(result.entry).not.toContain('ORIGINAL BODY MUST NOT COMPILE');
    expect(result.files.find(file => file.path === 'main.tex')).toBeUndefined();
    expect(result.files.some(file => file.content.includes('ORIGINAL BODY MUST NOT COMPILE'))).toBe(false);
    expect(result.entry.indexOf('PassOptionsToPackage')).toBeLessThan(result.entry.indexOf('documentclass'));
    expect(result.entry.indexOf('RequirePackage{preview}')).toBeGreaterThan(result.entry.indexOf('NewDocumentCommand'));
    expect(result.entry).toContain('\\begin{preview}\n\\(\\displaystyle ');
  });

  it('ignores comments, nested macro bodies, verbatim and inline verbatim with percent characters', () => {
    const preamble = String.raw`% \begin{document}
\documentclass{article}
\newcommand\quoted[1]{\text{#1\begin{document}}}
\verb|% \begin{document}|
\begin{verbatim}
% { \begin{document}
\end{verbatim}
\string\begin{document}
\begingroup\def\ignored{\begin{document}}\endgroup
`;
    expect(extractCloudPreamble(preamble + String.raw`\begin{document}BODY`)).toBe(preamble);
  });

  it('allows whitespace and comments in the real document boundary', () => {
    const source = String.raw`\documentclass{article}
\newcommand\x{X}
\begin % comment
 {document}BODY`;
    expect(extractCloudPreamble(source)).toBe(source.slice(0, source.indexOf('\\begin %')));
  });

  it('skips literal false branches and rejects ambiguous conditional boundaries', () => {
    const preamble = String.raw`\documentclass{article}\iffalse\begin{document}FAKE\fi`;
    expect(extractCloudPreamble(preamble + String.raw`\begin{document}BODY`)).toBe(preamble);
    expect(() => extractCloudPreamble(String.raw`\documentclass{article}\ifdefined\flag\begin{document}\fi\begin{document}`)).toThrow('条件分支');
  });

  it('does not guess a class or a macro-generated document boundary', () => {
    expect(() => extractCloudPreamble(String.raw`\begin{document}BODY`)).toThrow('documentclass');
    expect(() => extractCloudPreamble(String.raw`\documentclass{article}\newcommand\start{\begin{document}}\start BODY`)).toThrow('顶层');
  });
});

describe('isolated cloud file bundle', () => {
  it('keeps an explicitly unchanged source configuration byte-for-byte equivalent to defaults', async () => {
    const contents = { 'main.tex': String.raw`\documentclass{article}\def\choice{A}\input{part}\def\choice{C}\begin{document}BODY`, 'part.tex': String.raw`\def\choice{B}` };
    const original = await buildFixture(contents, { extraFilesMode: 'none' });
    const configured = await buildFixture(contents, { extraFilesMode: 'none', previewSources: [{ id: 'file:main.tex', enabled: true }, { id: 'file:part.tex', enabled: true }] });
    expect(configured).toEqual(original);
  });

  it('keeps natural anchors when only disabling a package and filters a multi-package declaration', async () => {
    const contents = { 'main.tex': String.raw`\documentclass{article}\def\choice{A}\usepackage{physics,amsmath}\input{part}\def\choice{C}\begin{document}`, 'part.tex': String.raw`\def\choice{B}` };
    const result = await buildFixture(contents, { extraFilesMode: 'none', previewSources: [{ id: 'package:physics', enabled: false }] });
    expect(result.entry).toContain(String.raw`\usepackage{amsmath}`);
    expect(result.entry).not.toContain(String.raw`\usepackage{physics`);
    expect(result.entry).toContain('ver@physics.sty');
    expect(result.entry.indexOf('ver@physics.sty')).toBeLessThan(result.entry.indexOf('\\documentclass'));
    expect(result.entry.indexOf(String.raw`\def\choice{A}`)).toBeLessThan(result.entry.indexOf(String.raw`\input{part}`));
    expect(result.entry.indexOf(String.raw`\def\choice{C}`)).toBeGreaterThan(result.entry.indexOf(String.raw`\input{part}`));
  });

  it('turns a disabled local package into a scratch dependency shim, leaving enabled dependencies available', async () => {
    const contents = { 'main.tex': String.raw`\documentclass{article}\usepackage[choice=a]{local}\begin{document}`, 'local.sty': String.raw`\ProvidesPackage{local}\RequirePackage{amsmath}\input{child}\def\hidden{H}`, 'child.tex': String.raw`\def\child{C}` };
    const result = await buildFixture(contents, { extraFilesMode: 'none', previewSources: [{ id: 'file:local.sty', enabled: false }] });
    const local = result.files.find(file => file.path === 'local.sty')!.content;
    expect(local).toContain(String.raw`\RequirePackage{amsmath}`);
    expect(local).toContain(String.raw`\input{child}`);
    expect(local).not.toContain(String.raw`\def\hidden`);
    expect(local).toContain(String.raw`\DeclareOption*{}\ProcessOptions\relax`);
    expect(result.files.find(file => file.path === 'child.tex')?.content).toBe(contents['child.tex']);
    expect(contents['local.sty']).toContain(String.raw`\def\hidden{H}`);
  });

  it('reorders static source files once without rewriting newcommand or retaining old load anchors', async () => {
    const contents = { 'main.tex': String.raw`\documentclass{article}\input{first}\input{second}\begin{document}`, 'first.tex': String.raw`\newcommand\choice{A}`, 'second.tex': String.raw`\newcommand\choice{B}` };
    const result = await buildFixture(contents, { extraFilesMode: 'none', previewSources: [{ id: 'file:second.tex', enabled: true }, { id: 'file:first.tex', enabled: true }] });
    expect(result.entry.indexOf('\\input{second.tex}')).toBeLessThan(result.entry.indexOf('\\input{first.tex}'));
    expect(result.entry).not.toContain(String.raw`\input{first}`);
    expect(result.files.find(file => file.path === 'first.tex')?.content).toBe(contents['first.tex']);
    expect(result.files.find(file => file.path === 'second.tex')?.content).toBe(contents['second.tex']);
    expect(result.diagnostics.join(' ')).toContain('newcommand');
  });

  it('moves root definitions with their own source and does not copy the original document body', async () => {
    const contents = { 'main.tex': String.raw`\documentclass{article}\def\choice{A}\input{part}\def\choice{C}\begin{document}NEVER COPY THIS BODY`, 'part.tex': String.raw`\def\choice{B}` };
    const result = await buildFixture(contents, { extraFilesMode: 'none', previewSources: [{ id: 'file:part.tex', enabled: true }, { id: 'file:main.tex', enabled: true }] });
    expect(result.entry.indexOf('\\input{part.tex}')).toBeLessThan(result.entry.indexOf(String.raw`\def\choice{A}`));
    expect(result.entry.indexOf(String.raw`\def\choice{A}`)).toBeLessThan(result.entry.indexOf(String.raw`\def\choice{C}`));
    expect(result.entry).not.toContain('NEVER COPY');
  });

  it('rejects dynamic or conditional loads when controls would otherwise be silently ignored', async () => {
    const contents = { 'main.tex': String.raw`\documentclass{article}\def\root{R}\ifdefined\flag\usepackage{physics}\fi\begin{document}` };
    await expect(buildFixture(contents, { previewSources: [{ id: 'file:main.tex', enabled: false }] })).rejects.toThrow('无法安全应用自定义预览来源');
    await expect(buildFixture(contents)).resolves.toBeDefined();
  });

  it('does not promote a complete document found through an original-body input into the preview preamble', async () => {
    const contents = { 'main.tex': String.raw`\documentclass{article}\def\root{R}\begin{document}\input{other}`, 'other.tex': String.raw`\documentclass{book}\def\other{O}\begin{document}SECOND BODY` };
    const result = await buildFixture(contents, { previewSources: [{ id: 'file:other.tex', enabled: true }, { id: 'file:main.tex', enabled: true }] });
    expect(result.files.some(file => file.path === 'other.tex')).toBe(false);
    expect(result.diagnostics.join(' ')).toContain('无法应用其设置：file:other.tex');
  });

  it('diagnoses stale source choices instead of silently claiming they were applied', async () => {
    const result = await buildFixture({ 'main.tex': String.raw`\documentclass{article}\begin{document}` }, { previewSources: [{ id: 'package:missing', enabled: false }] });
    expect(result.diagnostics.join(' ')).toContain('无法应用其设置：package:missing');
  });

  it('fails explicitly if TeX has already loaded a package before its requested new position', async () => {
    const result = await buildFixture({ 'main.tex': String.raw`\documentclass{article}\usepackage{amsmath,physics}\begin{document}` }, { previewSources: [{ id: 'package:physics', enabled: true }, { id: 'package:amsmath', enabled: true }] });
    expect(result.entry).toContain('\\PackageError{opt-preview}{Requested preview source order cannot be enforced: amsmath already loaded}');
    expect(result.entry.indexOf('\\RequirePackage{physics}')).toBeLessThan(result.entry.indexOf('\\RequirePackage{amsmath}'));
  });

  it('preserves local package sources and their order; extras use runtime loading markers', async () => {
    const result = await buildFixture({
      'main.tex': String.raw`\documentclass{article}\usepackage[choice=a]{local}\input{setup}\begin{document}BODY`,
      'local.sty': String.raw`\ProvidesPackage{local}\RequirePackage{physics}\input{macros.sty}`,
      'setup.tex': String.raw`\newcommand\setup{S}`,
      'macros.sty': String.raw`\newcommand\custom[1][\mathbb{R}]{#1}`,
      'classes/custom.cls': String.raw`\ProvidesClass{custom}\LoadClass{article}`,
    });
    expect(result.files.find(file => file.path === 'local.sty')?.content).toBe(String.raw`\ProvidesPackage{local}\RequirePackage{physics}\input{macros.sty}`);
    const macroCopy = result.files.find(file => file.path === 'macros.sty')!.content;
    expect(macroCopy).toContain('\\expandafter\\gdef\\csname optpreviewloaded');
    expect(macroCopy.endsWith(String.raw`\newcommand\custom[1][\mathbb{R}]{#1}`)).toBe(true);
    expect(result.entry).toContain('\\ifcsname optpreviewloaded');
    expect(result.entry.indexOf('\\input{setup}')).toBeLessThan(result.entry.indexOf('\\ifcsname'));
    expect(result.entry.indexOf('\\ifcsname')).toBeLessThan(result.entry.indexOf('\\RequirePackage{preview}'));
    expect(result.files.some(file => file.path === 'classes/custom.cls')).toBe(false);
  });

  it('does not treat a reference in the omitted body as an already-loaded preamble file', async () => {
    const result = await buildFixture({
      'main.tex': String.raw`\documentclass{article}\begin{document}\input{macros.sty}ORIGINAL`,
      'macros.sty': String.raw`\def\custom{C}`,
    });
    expect(result.entry).not.toContain('ORIGINAL');
    expect(result.entry).toContain('\\RequirePackage{macros}');
    expect(result.entry).toContain('\\ifcsname');
  });

  it('has empty extras for none and missing automatic files, and diagnoses multiple automatic matches', async () => {
    const base = { 'main.tex': String.raw`\documentclass{article}\begin{document}BODY`, 'a/macros.sty': String.raw`\def\a{A}`, 'b/macros.sty': String.raw`\def\b{B}` };
    const ambiguous = await buildFixture(base);
    expect(ambiguous.entry).not.toContain('\\ifcsname');
    expect(ambiguous.diagnostics.join(' ')).toContain('多份');
    const none = await buildFixture(base, { extraFilesMode: 'none' });
    expect(none.entry).not.toContain('\\ifcsname');
    expect(none.files.find(file => file.path === 'a/macros.sty')).toBeUndefined();
    const missing = await buildFixture({ 'main.tex': base['main.tex'] });
    expect(missing.entry).not.toContain('\\ifcsname');
  });

  it('keeps manually declared extras in their configured order and allows safe Unicode/space paths', async () => {
    const result = await buildFixture({
      'main.tex': String.raw`\documentclass{article}\begin{document}BODY`,
      '定义/custom one.tex': String.raw`\def\one{1}`,
      'custom-two.sty': String.raw`\ProvidesPackage{custom-two}\newcommand\internal@name{2}`,
    }, { extraFilesMode: 'manual', extraFiles: ['custom-two.sty', '定义/custom one.tex'] });
    expect(result.entry).toContain('\\RequirePackage{custom-two}');
    expect(result.entry).not.toContain('\\input{custom-two.sty}');
    expect(result.entry.indexOf('\\RequirePackage{custom-two}')).toBeLessThan(result.entry.indexOf('\\input{定义/custom one.tex}'));
  });

  it('never overwrites an existing project path for the generated entry', async () => {
    const result = await buildFixture({ 'main.tex': String.raw`\documentclass{article}\begin{document}BODY`, 'opt-preview-1.tex': '% keep this' });
    expect(result.entryPath).toBe('opt-preview-2.tex');
    expect(result.files.find(file => file.path === 'opt-preview-1.tex')).toBeUndefined();
  });

  it('rejects full documents selected or directly loaded as extra preamble files', async () => {
    const contents = { 'main.tex': String.raw`\documentclass{article}\begin{document}BODY`, 'other.tex': String.raw`\documentclass{book}\begin{document}OTHER BODY` };
    await expect(buildFixture(contents, { extraFilesMode: 'manual', extraFiles: ['other.tex'] })).rejects.toThrow('完整文档');
    await expect(buildFixture({ ...contents, 'main.tex': String.raw`\documentclass{article}\input{other}\begin{document}BODY` }, { extraFilesMode: 'none' })).rejects.toThrow('完整文档');
  });

  it('rejects unsafe paths and missing explicit extra files before producing a bundle', async () => {
    await expect(buildFixture({ 'main.tex': String.raw`\documentclass{article}\begin{document}`, 'bad%name.sty': '' })).rejects.toThrow('路径');
    await expect(buildFixture({ 'main.tex': String.raw`\documentclass{article}\begin{document}` }, { extraFilesMode: 'manual', extraFiles: ['../outside.sty'] })).rejects.toThrow('项目内');
    await expect(buildFixture({ 'main.tex': String.raw`\documentclass{article}\begin{document}` }, { extraFilesMode: 'manual', extraFiles: ['missing.sty'] })).rejects.toThrow('额外宏文件不存在');
  });

  it('leaves complete math environments intact and distinguishes inline/display style', async () => {
    const contents = { 'main.tex': String.raw`\documentclass{article}\usepackage{amsmath}\begin{document}` };
    const environment = await buildFixture(contents, {}, String.raw`\begin{align*}a&=b\\c&=d\end{align*}`);
    expect(environment.entry).toContain('\\begin{preview}\n\\begin{align*}');
    expect(environment.entry).not.toContain('\\displaystyle');
    const inline = await buildFixture(contents, {}, 'x+1', false);
    expect(inline.entry).toContain('\\(x+1\\)');
    await expect(buildFixture(contents, {}, String.raw`\end{document}`)).rejects.toThrow('文档级边界');
  });

  it('enforces bounds on actual dependencies while ignoring unrelated project size', async () => {
    const many = Object.fromEntries(Array.from({ length: 201 }, (_, index) => ['file' + index + '.sty', '']));
    const independent = await buildFixture({ ...many, 'main.tex': String.raw`\documentclass{article}\begin{document}`, 'huge.sty': 'a'.repeat(2_000_001) });
    expect(independent.files).toHaveLength(1);
    await expect(buildFixture({ ...many, 'main.tex': '\\documentclass{article}\\usepackage{' + Object.keys(many).map(path => path.slice(0, -4)).join(',') + '}\\begin{document}' })).rejects.toThrow('文本文件');
    await expect(buildFixture({ 'main.tex': String.raw`\documentclass{article}\usepackage{huge}\begin{document}`, 'huge.sty': 'a'.repeat(2_000_001) })).rejects.toThrow('过大');
  });

  it('reads only the preamble dependency closure, explicit extras and the active formula', async () => {
    const contents: Record<string,string> = {
      'main.tex': String.raw`\documentclass{article}\input{setup}\begin{document}\input{chapter}\bibliography{references}PRIVATE BODY`,
      'setup.tex': String.raw`\RequirePackage{physics}\input{defs/nested}`,
      'defs/nested.tex': String.raw`\def\X{X}`,
      'formula.tex': String.raw`x+y`,
      'macros.sty': String.raw`\def\Y{Y}`,
      'chapter.tex': 'PRIVATE CHAPTER',
      'references.bib': 'PRIVATE BIBLIOGRAPHY',
      'unrelated.sty': 'UNRELATED',
    };
    const readFile = vi.fn(async (file: ProjectFile) => contents[file.path]);
    const files = Object.keys(contents).map((path, id) => ({id:String(id), path, kind:'doc' as const}));
    const result = await buildCloudDocument({files,rootPath:'main.tex',readFile,settings:DEFAULT_SETTINGS,formula:String.raw`\input{formula}`,display:true});
    expect(readFile.mock.calls.map(([file]) => file.path).sort()).toEqual(['defs/nested.tex','formula.tex','macros.sty','main.tex','setup.tex']);
    expect(result.files.map(file => file.path).sort()).toEqual(['defs/nested.tex','formula.tex','macros.sty',result.entryPath,'setup.tex'].sort());
    expect(JSON.stringify(result.files)).not.toContain('PRIVATE');
  });

  it('includes transitive local classes, class options and package dependencies without standard package copies', async () => {
    const result = await buildFixture({
      'main.tex': String.raw`\documentclass{classes/custom}\begin{document}`,
      'classes/custom.cls': String.raw`\ProvidesClass{custom}\LoadClassWithOptions{classes/base}\RequirePackageWithOptions{local}`,
      'classes/base.cls': String.raw`\ProvidesClass{base}\LoadClass{article}`,
      'local.sty': String.raw`\RequirePackage{amsmath}\InputIfFileExists{optional.cfg}{}{}\input{defs/actual}`,
      'optional.cfg': String.raw`\def\optional{O}`,
      'defs/actual.tex': String.raw`\def\actual{A}`,
      'unused.cls': '',
    }, {extraFilesMode:'none'});
    expect(result.files.map(file => file.path).sort()).toEqual(['classes/custom.cls','classes/base.cls','local.sty','optional.cfg','defs/actual.tex',result.entryPath].sort());
  });

  it('tracks explicit imports and reports source-relative fallback without rewriting paths', async () => {
    const result = await buildFixture({
      'main.tex': String.raw`\documentclass{article}\import{defs/}{setup.tex}\begin{document}`,
      'defs/setup.tex': String.raw`\subimport{inner/}{part.tex}\input{sibling}`,
      'defs/inner/part.tex': String.raw`\def\inner{I}`,
      'defs/sibling.tex': String.raw`\def\sibling{S}`,
    }, {extraFilesMode:'none'});
    expect(result.files.map(file => file.path)).toEqual(expect.arrayContaining(['defs/setup.tex','defs/inner/part.tex','defs/sibling.tex']));
    expect(result.diagnostics.join(' ')).toContain('按所在文件目录匹配');
    expect(result.files.find(file => file.path==='defs/setup.tex')?.content).toContain(String.raw`\input{sibling}`);
  });

  it('diagnoses dynamic and missing inputs without falling back to copying every file', async () => {
    const result = await buildFixture({
      'main.tex': String.raw`\documentclass{article}\input{\computed}\input{missing}\IfFileExists{absent.cfg}{}{}\begin{document}`,
      'not-selected.tex': String.raw`\def\unused{U}`,
    }, {extraFilesMode:'none'});
    expect(result.files).toHaveLength(1);
    expect(result.diagnostics.join(' ')).toContain('动态文件引用');
    expect(result.diagnostics.join(' ')).toContain('missing.tex');
    expect(result.diagnostics.join(' ')).not.toContain('absent.cfg');
  });

  it('omits false-branch and commented inputs, but conservatively includes literal macro dependencies', async () => {
    const result = await buildFixture({
      'main.tex': String.raw`\documentclass{article}
% \input{commented}
\iffalse\input{false-branch}\fi
\newcommand\formula{\input{nested}}
\begin{document}`,
      'commented.tex':'PRIVATE', 'false-branch.tex':'PRIVATE', 'nested.tex':'x+y',
    },{extraFilesMode:'none'},String.raw`\formula`);
    expect(result.files.map(file => file.path)).toEqual(['nested.tex', result.entryPath]);
  });

  it('rejects binary resources in the active formula and local font paths with a specific explanation', async () => {
    const contents = {'main.tex':String.raw`\documentclass{article}\begin{document}`};
    await expect(buildFixture(contents,{extraFilesMode:'none'},String.raw`\includegraphics{plot.pdf}`)).rejects.toThrow('二进制资源：plot.pdf');
    await expect(buildFixture({'main.tex':String.raw`\documentclass{article}\setmainfont{fonts/custom.otf}\begin{document}`})).rejects.toThrow('二进制资源：fonts/custom.otf');
    await expect(buildFixture({'main.tex':String.raw`\documentclass{article}\setmainfont{Custom}[Path=fonts/]\begin{document}`})).rejects.toThrow('二进制资源：Custom');
    await expect(buildFixture({'main.tex':String.raw`\documentclass{article}\newfontfamily\customfont[Path=fonts/]{Custom}\begin{document}`})).rejects.toThrow('二进制资源：Custom');
    await expect(buildFixture({'main.tex':String.raw`\documentclass{article}\setmainfont{Latin Modern Roman}\begin{document}`})).resolves.toBeDefined();
  });

  it('does not inspect documentation after a package endinput as an executable dependency', async () => {
    const result = await buildFixture({
      'main.tex':String.raw`\documentclass{article}\usepackage{local}\begin{document}`,
      'local.sty':String.raw`\ProvidesPackage{local}\def\real{R}\endinput
\documentclass{article}\includegraphics{documentation.png}\input{documentation}`,
      'documentation.tex':'UNRELATED',
    },{extraFilesMode:'none'});
    expect(result.files.map(file=>file.path)).toEqual(['local.sty',result.entryPath]);
    expect(result.diagnostics).toEqual([]);
  });

  it('prunes disabled reordered files and retains only shims needed for natural dependencies', async () => {
    const contents = {
      'main.tex':String.raw`\documentclass{article}\input{first}\input{second}\input{third}\begin{document}`,
      'first.tex':String.raw`\def\first{A}`, 'second.tex':String.raw`\def\second{B}`, 'third.tex':String.raw`\def\third{C}`,
    };
    const result = await buildFixture(contents,{extraFilesMode:'none',previewSources:[{id:'file:third.tex',enabled:true},{id:'file:second.tex',enabled:true},{id:'file:first.tex',enabled:false}]});
    expect(result.files.some(file=>file.path==='first.tex')).toBe(false);
    expect(result.files.some(file=>file.path==='second.tex')).toBe(true);
  });
});
