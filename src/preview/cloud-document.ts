import { maskComments, parseTex } from '../core/parser';
import { buildProjectIndex } from '../core/project-index';
import { getPreviewSources, previewSourcesReordered } from '../core/preview-sources';
import type { ProjectFile, Settings } from '../core/types';

export interface CloudDocumentOptions {
  files: ProjectFile[];
  rootPath: string;
  readFile: (file: ProjectFile) => Promise<string>;
  settings: Settings;
  formula: string;
  display: boolean;
}
export interface CloudDocumentBundle {
  files: Array<{ path: string; content: string }>;
  entryPath: string;
  diagnostics: string[];
}

const MAX_FILES = 200;
const MAX_FILE_CHARACTERS = 2_000_000;
const MAX_TOTAL_CHARACTERS = 8_000_000;
const TEXT_EXTENSION = /\.(?:tex|sty|cls|ltx|def|cfg|clo|tikz|bib|txt|bbx|cbx|lbx|bst|fd|enc|map)$/i;
const LITERAL_ENVIRONMENTS = new Set(['verbatim', 'verbatim*', 'Verbatim', 'lstlisting', 'minted', 'comment', 'filecontents', 'filecontents*']);
const NON_PRIMITIVE_IF_MACROS = new Set(['ifthenelse', 'ifboolexpr', 'ifdef', 'ifcsdef', 'ifstrequal', 'ifblank', 'ifstrempty', 'ifundef', 'ifcsundef', 'ifdefempty', 'ifcsvoid']);

function safePath(path: string): string {
  // Braced \input paths can contain spaces and Unicode. TeX-active characters,
  // quotes, controls, absolute paths and traversal are deliberately rejected.
  if (!path || path.length > 512 || path.startsWith('/') || /[\\{}%#$&^~":\u0000-\u001f\u007f]/u.test(path)) {
    throw new Error('TeX 预览不能安全表示项目路径：' + path);
  }
  const parts = path.split('/');
  if (parts.some(part => part === '..' || part === '')) throw new Error('TeX 预览路径必须位于项目内：' + path);
  return parts.filter(part => part !== '.').join('/');
}

interface Group { value: string; end: number }
function skipSpace(text: string, at: number): number {
  while (at < text.length) {
    if (/\s/.test(text[at])) at++;
    else if (text[at] === '%') { while (at < text.length && text[at] !== '\n' && text[at] !== '\r') at++; }
    else break;
  }
  return at;
}
function removeComments(text: string): string {
  let output = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && i + 1 < text.length) output += text[i] + text[++i];
    else if (text[i] === '%') {
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
      if (text[i] === '\r' && text[i + 1] === '\n') i++;
    } else output += text[i];
  }
  return output;
}
function readControl(text: string, at: number): { name: string; end: number } | undefined {
  if (text[at] !== '\\' || at + 1 >= text.length) return;
  let end = at + 1;
  if (/[A-Za-z@]/.test(text[end])) { while (end < text.length && /[A-Za-z@]/.test(text[end])) end++; }
  else end++;
  return { name: text.slice(at + 1, end), end };
}
function readGroup(text: string, at: number, open = '{', close = '}'): Group | undefined {
  at = skipSpace(text, at);
  if (text[at] !== open) return;
  const start = at + 1;
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '%') { while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++; continue; }
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return { value: removeComments(text.slice(start, i)), end: i + 1 };
  }
}

interface Structure { documentStart?: number; documentEnd?: number; classCount: number; unresolvedBoundary: boolean }

/** Finds literal, top-level document boundaries without evaluating TeX macros. */
function documentStructure(source: string): Structure {
  const text = source;
  let depth = 0;
  const conditions: Array<boolean | undefined> = [];
  const result: Structure = { classCount: 0, unresolvedBoundary: false };
  const state = () => conditions.includes(false) ? false : conditions.includes(undefined) ? undefined : true;
  for (let i = 0; i < text.length;) {
    if (text[i] === '%') { while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++; continue; }
    if (text[i] === '{') { depth++; i++; continue; }
    if (text[i] === '}') { depth = Math.max(0, depth - 1); i++; continue; }
    const token = readControl(text, i);
    if (!token) { i++; continue; }
    const start = i;
    i = token.end;
    const name = token.name;
    if (name === 'verb') {
      if (text[i] === '*') i++;
      const delimiter = text[i++];
      const end = delimiter ? text.indexOf(delimiter, i) : -1;
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (name === 'string' || name === 'noexpand') {
      i = skipSpace(text, i);
      i = readControl(text, i)?.end ?? Math.min(i + 1, text.length);
      continue;
    }
    if (name === 'newif') { i = readControl(text, skipSpace(text, i))?.end ?? i; continue; }
    if (name === 'let') {
      i = readControl(text, skipSpace(text, i))?.end ?? i;
      i = skipSpace(text, i); if (text[i] === '=') i = skipSpace(text, i + 1);
      i = readControl(text, i)?.end ?? Math.min(i + 1, text.length);
      continue;
    }
    if (name === 'begin') {
      const environment = readGroup(text, i);
      if (environment && LITERAL_ENVIRONMENTS.has(environment.value.trim())) {
        const endToken = '\\end{' + environment.value.trim() + '}';
        const end = text.indexOf(endToken, environment.end);
        if (end < 0) throw new Error('代码或注释环境未闭合，无法安全提取导言区。');
        i = end + endToken.length;
        continue;
      }
    }
    if (name === 'begingroup' || name === 'bgroup') { depth++; continue; }
    if (name === 'endgroup' || name === 'egroup') { depth = Math.max(0, depth - 1); continue; }
    if (depth !== 0) continue;
    if (name.startsWith('if') && !NON_PRIMITIVE_IF_MACROS.has(name)) {
      conditions.push(name === 'iftrue' ? true : name === 'iffalse' ? false : undefined);
      continue;
    }
    if (name === 'else' && conditions.length) {
      const last = conditions.length - 1;
      if (conditions[last] !== undefined) conditions[last] = !conditions[last];
      continue;
    }
    if (name === 'fi') { conditions.pop(); continue; }
    if (name === 'endinput' && state() === true) return result;
    if (name === 'documentclass' && state() !== false) {
      if (state() === undefined) result.unresolvedBoundary = true;
      else result.classCount++;
    }
    if (name !== 'begin' && name !== 'end') continue;
    const environment = readGroup(text, i);
    if (environment?.value.trim() !== 'document' || state() === false) continue;
    if (state() === undefined) { result.unresolvedBoundary = true; continue; }
    if (name === 'begin') { result.documentStart = start; return result; }
    result.documentEnd = start;
    return result;
  }
  return result;
}

/** Exported for focused tests and diagnostics; preserves the original source verbatim. */
export function extractCloudPreamble(source: string): string {
  const structure = documentStructure(source);
  if (structure.unresolvedBoundary) throw new Error('文档边界或 documentclass 位于无法静态判断的条件分支中，不能安全生成预览文档。');
  if (structure.documentStart === undefined) throw new Error('主文件中找不到明确的顶层 \\begin{document}；不能安全分离原正文。');
  if (structure.classCount !== 1) throw new Error('主文件导言区必须包含唯一明确的 \\documentclass；不会猜测文档模板。');
  return source.slice(0, structure.documentStart);
}

function chooseEntryPath(paths: ReadonlySet<string>): string {
  for (let index = 1; index <= 1000; index++) {
    const candidate = 'opt-preview-' + index + '.tex';
    if (!paths.has(candidate)) return candidate;
  }
  throw new Error('无法为 TeX 预览选择不冲突的主文件名。');
}

function formulaBody(formula: string, display: boolean): string {
  const clean = formula.trim();
  if (!clean || clean.length > 32_000 || clean.includes('\0')) throw new Error('公式为空或超过 TeX 预览大小上限。');
  const structure = documentStructure(clean);
  if (structure.documentStart !== undefined || structure.documentEnd !== undefined || structure.classCount || structure.unresolvedBoundary) {
    throw new Error('公式片段中不能包含文档级边界或 documentclass。');
  }
  // The editor bridge keeps equation/align environments intact and strips bare
  // math delimiters. Do not wrap a complete environment in another math mode.
  if (/^\\begin\s*\{/.test(maskComments(clean).trim())) return clean;
  if ((clean.startsWith('\\[') && clean.endsWith('\\]')) || (clean.startsWith('\\(') && clean.endsWith('\\)')) || (clean.startsWith('$') && clean.endsWith('$'))) return clean;
  return '\\(' + (display ? '\\displaystyle ' : '') + clean + '\\)';
}

/** Apply explicit controls to scratch text only; no TeX declaration is rewritten. */
async function controlledPreamble(options: CloudDocumentOptions, sources: Map<string, string>, preamble: string, extraPaths: string[], diagnostics: string[]): Promise<{ preamble: string; reordered: boolean } | undefined> {
  if (!options.settings.previewSources?.length) return;
  const index = await buildProjectIndex({ ...options,
    files: [...sources.keys()].map((path, id) => ({ id: String(id), path, kind: 'doc' as const })),
    readFile: async file => sources.get(file.path)!,
  });
  const catalog = getPreviewSources(index, options.settings);
  const knownIds = new Set(catalog.map(source => source.id));
  for (const setting of options.settings.previewSources) {
    if (!knownIds.has(setting.id)) diagnostics.push('预览来源已不在当前静态索引中，无法应用其设置：' + setting.id);
  }
  const reordered = previewSourcesReordered(index, options.settings);
  if (!reordered && catalog.every(source => source.enabled)) return;
  const byId = new Map(catalog.map(source => [source.id, source]));
  const disabled = new Set(catalog.filter(source => !source.enabled).map(source => source.id));
  const originals = new Map(sources);
  const transformed = new Map<string, string>();
  const visiting = new Set<string>();
  const rootDefinitions: string[] = [];
  const rootPath = safePath(options.rootPath);
  const fail = (path: string, detail: string): never => {
    throw new Error('无法安全应用自定义预览来源（' + path + '）：' + detail + '。请恢复默认来源顺序，或把相关加载/定义改为明确的顶层声明。');
  };
  const resolve = (raw: string, from: string, extension: string): string | undefined => {
    if (/[\\#{}]/.test(raw)) return;
    const path = safePath(/\.[^/]+$/.test(raw) ? raw : raw + extension);
    if (originals.has(path)) return path;
    const directory = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '';
    return originals.has(directory + path) ? directory + path : undefined;
  };
  const packageLoad = (name: string, settings: string[] = []) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) || name.includes('..')) return fail(rootPath, '宏包名称不能静态表示：' + name);
    return '\\RequirePackage' + (settings.length ? '[' + settings.join(',') + ']' : '') + '{' + name + '}';
  };

  function rewrite(path: string, depth = 0): string {
    if (transformed.has(path)) return transformed.get(path)!;
    if (visiting.has(path) || depth > 32) return fail(path, '存在循环文件引用或依赖深度超过上限');
    const text = path === rootPath ? preamble : originals.get(path);
    if (text === undefined) return fail(path, '找不到来源文本');
    if (path !== rootPath) {
      const structure = documentStructure(text);
      if (structure.documentStart !== undefined || structure.documentEnd !== undefined || structure.classCount || structure.unresolvedBoundary) return fail(path, '来源包含完整文档或条件文档边界');
    }
    visiting.add(path);
    const edits: Array<{ start: number; end: number; replacement: string }> = [];
    const dependencies: string[] = [];
    const inspectedOffsets = new Set<number>();
    const isDisabled = disabled.has('file:' + path);
    const events = parseTex(text, path).events;
    for (const event of events) {
      if (inspectedOffsets.has(event.offset)) continue;
      inspectedOffsets.add(event.offset);
      if (event.type === 'macro') {
        if (/\\(?:input|include|usepackage|RequirePackage|import|subimport)\b/.test(maskComments(event.macro.raw))) return fail(path, '宏定义内部动态加载了文件或宏包');
        if (path === rootPath && reordered && !isDisabled) rootDefinitions.push(event.macro.raw);
        edits.push({ start: event.offset, end: event.offset + event.macro.raw.length, replacement: isDisabled || (path === rootPath && reordered) ? '' : event.macro.raw });
        continue;
      }
      const token = readControl(text, event.offset)!;
      let at = token.end;
      if (event.type === 'package') {
        const optionGroup = readGroup(text, at, '[', ']');
        if (optionGroup) at = optionGroup.end;
        const names = readGroup(text, at);
        if (!names) return fail(path, '宏包声明无法静态解析');
        const trailing = readGroup(text, names.end, '[', ']');
        const end = trailing?.end ?? names.end;
        const retained: string[] = [];
        for (const name of names.value.split(',').map(value => value.trim()).filter(Boolean)) {
          if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) || name.includes('..')) return fail(path, '宏包名称包含动态内容');
          const target = resolve(name, path, '.sty');
          if (target) rewrite(target, depth + 1);
          const id = target ? 'file:' + target : 'package:' + name;
          // Disabled local packages become dependency-only shims in the natural-order case.
          if (reordered && byId.has(id)) continue;
          if (!target && disabled.has(id)) continue;
          retained.push(name);
        }
        const command = retained.length ? '\\' + token.name + (optionGroup ? '[' + optionGroup.value + ']' : '') + '{' + retained.join(',') + '}' + (trailing ? '[' + trailing.value + ']' : '') : '';
        dependencies.push(command);
        edits.push({ start: event.offset, end, replacement: command });
      } else {
        const group = readGroup(text, at);
        let end = group?.end;
        if (end === undefined) {
          at = skipSpace(text, at);
          const bare = /^[^\s{}\\]+/.exec(text.slice(at));
          if (bare) end = at + bare[0].length;
        }
        if (end === undefined) return fail(path, '文件引用无法静态解析');
        const target = resolve(event.path, path, '.tex');
        if (!target) return fail(path, '文件引用不在项目文本中或包含动态内容：' + event.path);
        rewrite(target, depth + 1);
        const command = reordered && byId.has('file:' + target) ? '' : text.slice(event.offset, end);
        dependencies.push(command);
        edits.push({ start: event.offset, end, replacement: command });
      }
    }
    // Anything the scanner could not safely identify remains here, including
    // conditional/scoped declarations and computed import commands.
    let residual = text;
    for (const edit of [...edits].sort((a, b) => b.start - a.start)) residual = residual.slice(0, edit.start) + ' '.repeat(edit.end - edit.start) + residual.slice(edit.end);
    if (/\\(?:if[A-Za-z@]*|else|fi|csname|expandafter|catcode|ExplSyntaxOn|string|noexpand|global|long|outer|protected|afterassignment|futurelet|usepackage|RequirePackage|input|include|import|subimport|InputIfFileExists|IfFileExists|def|gdef|edef|xdef|let|newcommand|renewcommand|providecommand|DeclareRobustCommand|NewDocumentCommand|RenewDocumentCommand|ProvideDocumentCommand|DeclareDocumentCommand|DeclareDocumentEnvironment|NewDocumentEnvironment|newenvironment|renewenvironment|DeclareMathOperator)\b/.test(maskComments(residual))) {
      return fail(path, '含有条件、动态或未解析的加载/定义');
    }
    let result = text;
    for (const edit of [...edits].sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
    if (isDisabled && path !== rootPath) {
      const packageShim = path.endsWith('.sty') ? '\\DeclareOption*{}\\ProcessOptions\\relax\n' : '';
      result = '% This source is disabled only in the isolated preview workspace.\n' + packageShim + dependencies.filter(Boolean).join('\n') + '\n';
    }
    visiting.delete(path); transformed.set(path, result);
    return result;
  }

  let base = rewrite(rootPath);
  for (const path of extraPaths) rewrite(path);
  if (reordered) for (const source of catalog) if (source.path && source.path !== rootPath) rewrite(source.path);
  for (const [path, text] of transformed) if (path !== rootPath) sources.set(path, text);

  // Prevent an explicitly disabled external package from being reintroduced by a
  // class or another installed package. This marker affects only the generated entry.
  const disabledPackages = catalog.filter(source => !source.enabled && source.kind === 'package');
  const suppression = disabledPackages.map(source => {
    const name = source.packageName ?? source.name;
    packageLoad(name);
    return '\\expandafter\\def\\csname ver@' + name + '.sty\\endcsname{9999/12/31 disabled for preview}\n'
      + '\\expandafter\\def\\csname opt@' + name + '.sty\\endcsname{' + (source.options ?? []).join(',') + '}';
  }).join('\n');
  if (suppression) base = suppression + '\n' + base;

  if (reordered) {
    const commands: string[] = [];
    for (const source of catalog.filter(item => item.enabled)) {
      if (source.path === rootPath) {
        if (rootDefinitions.length) commands.push('\\makeatletter\n' + rootDefinitions.join('\n') + '\n\\makeatother');
      } else if (source.kind === 'package' || source.path?.endsWith('.sty')) {
        const name = source.packageName ?? (source.path ? source.path.slice(0, -4) : source.name);
        packageLoad(name, source.options);
        commands.push('\\ifcsname ver@' + name + '.sty\\endcsname\n\\PackageError{opt-preview}{Requested preview source order cannot be enforced: ' + name + ' already loaded}{A class or dependency loaded this source before its selected position. Restore the natural order or move this package earlier.}\n\\fi\n' + packageLoad(name, source.options));
      } else if (source.path) commands.push('\\input{' + safePath(source.path) + '}');
    }
    diagnostics.push('预览来源按指定顺序各加载一次；TeX 保留原始声明语义，重复 newcommand 或依赖顺序冲突会报告编译错误。');
    return { preamble: base + '\n' + commands.join('\n'), reordered: true };
  }
  // In the natural-order branch retain the original extra-file marker mechanism.
  // A disabled extra still uses its shim so individually enabled dependencies run.
  return { preamble: base, reordered: false };
}

interface FileDependency { raw: string; extension: string; optional?: boolean; resource?: boolean; nested?: boolean }

/** Conservative token scan: literal loads inside macro bodies are included too.
 * TeX can calculate file names, so this is a dependency closure, not a TeX interpreter.
 */
function fileDependencies(text: string, from: string, diagnostics: string[]): FileDependency[] {
  const dependencies: FileDependency[] = [];
  const macroRanges = parseTex(text, from).events.filter(event => event.type === 'macro').map(event => [event.macro.offset, event.macro.offset + event.macro.raw.length]);
  const conditions: Array<boolean | undefined> = [];
  const nested = (offset: number) => macroRanges.some(([start, end]) => offset > start && offset < end);
  const warn = (message: string) => { if (!diagnostics.includes(message)) diagnostics.push(message); };
  for (let i = 0; i < text.length;) {
    if (text[i] === '%') { while (i < text.length && !/[\r\n]/.test(text[i])) i++; continue; }
    const token = readControl(text, i);
    if (!token) { i++; continue; }
    const start = i, name = token.name;
    i = token.end;
    if (name === 'verb') {
      if (text[i] === '*') i++;
      const delimiter = text[i++];
      const end = delimiter ? text.indexOf(delimiter, i) : -1;
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (name === 'string' || name === 'noexpand') { i = skipSpace(text, i); i = readControl(text, i)?.end ?? i + 1; continue; }
    if (name === 'begin') {
      const group = readGroup(text, i);
      if (group && LITERAL_ENVIRONMENTS.has(group.value.trim())) {
        const endToken = '\\end{' + group.value.trim() + '}';
        const end = text.indexOf(endToken, group.end);
        i = end < 0 ? text.length : end + endToken.length;
        continue;
      }
    }
    // A definition of a conditional is not an execution of that conditional.
    if (name === 'newif') { i = readControl(text, skipSpace(text, i))?.end ?? i; continue; }
    if (name.startsWith('if') && !NON_PRIMITIVE_IF_MACROS.has(name) && !nested(start)) {
      conditions.push(name === 'iftrue' ? true : name === 'iffalse' ? false : undefined); continue;
    }
    if (name === 'else' && conditions.length && !nested(start)) {
      const last = conditions.length - 1;
      if (conditions[last] !== undefined) conditions[last] = !conditions[last];
      continue;
    }
    if (name === 'fi' && conditions.length && !nested(start)) { conditions.pop(); continue; }
    if (conditions.includes(false)) continue;
    if (name === 'endinput' && !nested(start) && !conditions.includes(undefined)) break;
    let extension = '', optional = false, resource = false;
    if (['usepackage', 'RequirePackage', 'RequirePackageWithOptions'].includes(name)) extension = '.sty';
    else if (['documentclass', 'LoadClass', 'LoadClassWithOptions'].includes(name)) extension = '.cls';
    else if (['input', 'include', 'InputIfFileExists', 'IfFileExists'].includes(name)) {
      extension = '.tex'; optional = name === 'InputIfFileExists' || name === 'IfFileExists';
    } else if (['import', 'subimport', 'inputfrom', 'subinputfrom', 'includefrom', 'subincludefrom'].includes(name)) {
      const directory = readGroup(text, i), file = directory && readGroup(text, directory.end);
      if (!directory || !file) { warn('无法静态跟踪文件导入（' + from + '）：\\' + name + '；请将依赖加入额外定义文件。'); continue; }
      const prefix = name.startsWith('sub') && from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '';
      dependencies.push({ raw: prefix + directory.value + file.value, extension: '.tex', nested: nested(start) || conditions.includes(undefined) });
      i = file.end; continue;
    } else if (name === 'includegraphics' || name === 'includesvg' || name === 'includepdf') resource = true;
    else if (['setmainfont', 'setsansfont', 'setmonofont', 'setmathfont', 'newfontfamily'].includes(name)) {
      // Named system fonts remain the TeX engine's responsibility. A project font
      // file or a Path option requires binary-resource synchronization.
      let at = skipSpace(text, i);
      if (name === 'newfontfamily') at = skipSpace(text, readControl(text, at)?.end ?? readGroup(text, at)?.end ?? at);
      const before = readGroup(text, at, '[', ']');
      if (before) at = before.end;
      const font = readGroup(text, at);
      const after = font && readGroup(text, font.end, '[', ']');
      if (font && (/\.(?:otf|ttf|woff2?)$/i.test(font.value) || /\bPath\s*=/.test((before?.value ?? '') + ',' + (after?.value ?? '')))) {
        dependencies.push({ raw: font.value, extension: '', resource: true, nested: nested(start) || conditions.includes(undefined) });
      }
      if (font) i = after?.end ?? font.end;
      continue;
    } else continue;
    if (text[i] === '*') i++;
    let at = skipSpace(text, i);
    let option: Group | undefined;
    while ((option = readGroup(text, at, '[', ']'))) at = skipSpace(text, option.end);
    const group = readGroup(text, at);
    let raw = group?.value, end = group?.end;
    if (raw === undefined && name === 'input') {
      const bare = /^[^\s{}\\%]+/.exec(text.slice(at));
      if (bare) { raw = bare[0]; end = at + bare[0].length; }
    }
    if (raw === undefined) { warn('无法静态跟踪文件引用（' + from + '）：\\' + name + '；请将依赖加入额外定义文件。'); continue; }
    const names = extension === '.sty' ? raw.split(',') : [raw];
    for (const value of names) dependencies.push({ raw: value.trim(), extension, optional, resource, nested: nested(start) || conditions.includes(undefined) });
    i = end!;
  }
  return dependencies;
}

/**
 * Produces only the single-formula entry and its text dependency closure for an
 * isolated local workspace or shared Overleaf workspace. Performs no writes.
 */
export async function buildCloudDocument(options: CloudDocumentOptions): Promise<CloudDocumentBundle> {
  const rootPath = safePath(options.rootPath);
  const diagnostics: string[] = [];
  const available = new Map<string, ProjectFile>();
  for (const file of options.files) {
    const path = safePath(file.path);
    if (available.has(path)) throw new Error('项目存在重复路径：' + path);
    available.set(path, { ...file, path });
  }
  const root = available.get(rootPath);
  if (!root) throw new Error('找不到 TeX 预览使用的项目主文件：' + rootPath);
  const sources = new Map<string, string>();
  let total = 0;
  async function read(file: ProjectFile): Promise<string> {
    if (sources.has(file.path)) return sources.get(file.path)!;
    if (file.kind !== 'doc' && !TEXT_EXTENSION.test(file.path)) throw new Error('轻量 TeX 预览尚不支持同步图片或字体等二进制资源：' + file.path);
    if (sources.size >= MAX_FILES) throw new Error('TeX 预览最多同步 ' + MAX_FILES + ' 个依赖文本文件；当前公式依赖超出限制。');
    const text = await options.readFile(file);
    if (text.length > MAX_FILE_CHARACTERS || text.includes('\0')) throw new Error('文本文件过大或含二进制内容：' + file.path);
    total += text.length;
    if (total > MAX_TOTAL_CHARACTERS) throw new Error('TeX 预览文本总量超过大小上限。');
    sources.set(file.path, text);
    return text;
  }
  const rootSource = await read(root);
  const preamble = extractCloudPreamble(rootSource);
  // Keep only the preamble in the index used to apply preview source choices.
  // Neither that index nor the returned bundle may promote original body inputs.
  sources.set(rootPath, preamble);
  const body = formulaBody(options.formula, options.display);

  const extraPaths: string[] = [];
  if (options.settings.extraFilesMode === 'auto') {
    const wanted = options.settings.autoFileName || 'macros.sty';
    const matches = [...available.keys()].filter(path => path.split('/').at(-1) === wanted);
    if (matches.length === 1) extraPaths.push(matches[0]);
    else if (matches.length > 1) diagnostics.push('发现多份 ' + wanted + '，没有自动添加额外宏文件；请手动指定：' + matches.join('、'));
  } else if (options.settings.extraFilesMode === 'manual') {
    for (const rawPath of options.settings.extraFiles) {
      const path = safePath(rawPath);
      if (!available.has(path)) throw new Error('额外宏文件不存在或不是可读取的文本文件：' + path);
      if (!extraPaths.includes(path)) extraPaths.push(path);
    }
  }

  const warn = (message: string) => { if (!diagnostics.includes(message)) diagnostics.push(message); };
  const resolve = (dependency: FileDependency, from: string, checkResource = true): string | undefined => {
    const raw = dependency.raw;
    if (!raw || /[\\#{}]/.test(raw)) {
      warn('无法静态跟踪动态文件引用：' + raw + '（' + from + '）；请将其项目文本依赖明确加入额外定义文件。'); return;
    }
    if (dependency.resource) {
      const message = '轻量 TeX 预览尚不支持同步图片或字体等二进制资源：' + raw + '（' + from + '）。请使用系统字体或移除公式预览对该资源的依赖。';
      if (dependency.nested || !checkResource) { warn(message); return; }
      throw new Error(message);
    }
    const path = safePath(/\.[^/]+$/.test(raw) ? raw : raw + dependency.extension);
    const directory = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '';
    const target = available.has(path) ? path : available.has(directory + path) ? directory + path : undefined;
    if (target && target !== path) warn('引用 ' + raw + ' 按所在文件目录匹配为 ' + target + '；实际 TeX 路径解析仍由编译器决定。');
    if (!target && dependency.extension === '.tex' && !dependency.optional) warn('导言区或公式引用未在项目文本中找到，将交由所选 TeX 引擎查找：' + path + '。若为项目自定义文件，请明确加入额外定义文件。');
    return target;
  };
  const inspected = new Set<string>();
  const pending: Array<{ path: string; text: string; depth: number }> = [{ path: rootPath, text: preamble + '\n' + body, depth: 0 }];
  for (const path of extraPaths) {
    if (path === rootPath) throw new Error('额外宏文件不能选择当前主文档。');
    pending.push({ path, text: await read(available.get(path)!), depth: 0 });
  }
  while (pending.length) {
    const current = pending.pop()!;
    if (inspected.has(current.path)) continue;
    inspected.add(current.path);
    if (current.depth > 32) throw new Error('导言区文件依赖超过深度上限。');
    if (current.path !== rootPath) {
      const structure = documentStructure(current.text);
      if (structure.documentStart !== undefined || structure.documentEnd !== undefined || structure.classCount || structure.unresolvedBoundary) {
        throw new Error('导言区或额外文件引用了完整文档，不能把其正文加入公式预览：' + current.path);
      }
    }
    for (const dependency of fileDependencies(current.text, current.path, diagnostics)) {
      const path = resolve(dependency, current.path, false);
      if (!path) continue;
      if (path === rootPath) throw new Error('导言区或公式不能再次引用完整主文档：' + path);
      if (!inspected.has(path)) pending.push({ path, text: await read(available.get(path)!), depth: current.depth + 1 });
    }
  }

  const controlled = await controlledPreamble(options, sources, preamble, extraPaths, diagnostics);
  const entryPath = chooseEntryPath(new Set(available.keys()));
  const markerPrefix = 'optpreviewloaded' + entryPath.replace(/[^A-Za-z0-9]/g, '');
  const extraCommands: string[] = [];
  (controlled?.reordered ? [] : extraPaths).forEach((path, index) => {
    if (path === rootPath) throw new Error('额外宏文件不能选择当前主文档。');
    const marker = markerPrefix + 'x' + index;
    // Marker commands are prepended ONLY to scratch copies. They are global so
    // package loading groups do not hide the fact that a file was already read.
    sources.set(path, '\\expandafter\\gdef\\csname ' + marker + '\\endcsname{1}%\n' + sources.get(path)!);
    const load = path.endsWith('.sty') ? '\\RequirePackage{' + path.slice(0, -4) + '}' : '\\input{' + path + '}';
    extraCommands.push('\\ifcsname ' + marker + '\\endcsname\\else\n' + load + '%\n\\fi');
  });

  const entry = [
    '% Generated only inside an isolated TeX preview workspace.',
    '\\PassOptionsToPackage{active,tightpage}{preview}',
    controlled?.preamble ?? preamble,
    ...extraCommands,
    '\\RequirePackage{preview}',
    '\\setlength{\\PreviewBorder}{2pt}',
    '\\begin{document}',
    '\\begin{preview}',
    body,
    '\\end{preview}',
    '\\end{document}',
    '',
  ].join('\n');
  // Prune again after source controls removed/reordered loads. Keep disabled
  // dependency shims only when they are still actually referenced by the entry.
  const retained = new Set<string>();
  const remaining = [{ path: rootPath, text: entry }];
  while (remaining.length) {
    const current = remaining.pop()!;
    for (const dependency of fileDependencies(current.text, current.path, diagnostics)) {
      const path = resolve(dependency, current.path);
      if (!path || path === rootPath || retained.has(path) || !sources.has(path)) continue;
      retained.add(path); remaining.push({ path, text: sources.get(path)! });
    }
  }
  return { files: [...sources].filter(([path]) => retained.has(path)).map(([path, content]) => ({ path, content })).concat({ path: entryPath, content: entry }), entryPath, diagnostics };
}
