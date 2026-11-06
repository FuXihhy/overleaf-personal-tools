import { macroToCommand, parseTex, type ParseResult } from './parser';
import { emptyIndex, type MacroDefinition, type PreviewSource, type ProjectFile, type ProjectIndex, type Settings } from './types';

export interface BuildProjectIndexOptions {
  files: ProjectFile[];
  rootPath: string;
  readFile: (file: ProjectFile) => Promise<string>;
  settings: Settings;
}
const MAX_FILE_CHARACTERS = 1_000_000;
const MAX_TOTAL_CHARACTERS = 4_000_000;
const MAX_VISITS = 200;
const MAX_DEPTH = 24;
const MAX_MACRO_DEPTH = 64;

function normalize(path: string): string | undefined {
  if (/\\|\0|^[a-z]+:/i.test(path)) return;
  const parts: string[] = [];
  for (const part of path.replace(/^\/+/, '').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return; parts.pop(); }
    else parts.push(part);
  }
  return parts.join('/');
}
const directory = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** Index only project-owned text files. No package downloads or TeX execution. */
export async function buildProjectIndex(options: BuildProjectIndexOptions): Promise<ProjectIndex> {
  const { readFile, settings } = options;
  const index = emptyIndex();
  index.previewSources = [];
  index.previewEvents = [];
  const sourceCatalog = new Map<string, PreviewSource>();
  const registerSource = (source: PreviewSource) => {
    const existing = sourceCatalog.get(source.id);
    if (existing) {
      if (!existing.packageName && source.packageName) { existing.packageName = source.packageName; existing.options = source.options; }
    }
    else { sourceCatalog.set(source.id, source); index.previewSources!.push(source); }
  };
  const files = new Map<string, ProjectFile>();
  const macros = new Map<string, MacroDefinition>();
  const loadedPackages = new Map<string, string>();
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const parsedCache = new Map<string, ParseResult>();
  let totalCharacters = 0;
  let visits = 0;
  let limitReported = false;
  const warn = (message: string, source?: string) => index.diagnostics.push({ level: 'warning', message, ...(source ? { source } : {}) });

  for (const file of options.files) {
    const path = normalize(file.path);
    if (!path) continue;
    if (files.has(path)) warn('项目存在重复路径，已保留第一项：' + path);
    else files.set(path, { ...file, path });
  }

  function resolve(path: string, from: string, extension: '.tex' | '.sty'): string | undefined {
    const clean = path.trim();
    if (!clean || /[\\#{}]/.test(clean)) return;
    const withExtension = /\.[^/]+$/.test(clean) ? clean : clean + extension;
    // TeX resolves paths relative to the project working directory. A source-local
    // fallback also covers common hand-authored multi-folder projects.
    const candidates = [...new Set([normalize(withExtension), normalize(directory(from) + withExtension)])].filter((value): value is string => !!value);
    const found = candidates.find(candidate => files.has(candidate));
    if (found && found !== normalize(withExtension)) warn('引用 ' + path + ' 按所在文件目录匹配为 ' + found + '；请以实际编译路径为准。', from);
    return found;
  }

  function acceptMacro(definition: MacroDefinition) {
    if ((definition.kind === 'providecommand' || definition.kind === 'ProvideDocumentCommand') && macros.has(definition.name)) return;
    let macro = { ...definition };
    if (macro.kind === 'let') {
      const target = /^\\([A-Za-z@]+|.)$/.exec(macro.body)?.[1];
      const captured = target && macros.get(target);
      // \let copies the current meaning; retain that snapshot if it is known.
      if (captured) macro = { ...macro, body: captured.body, args: captured.args, optionalDefault: captured.optionalDefault, supported: captured.supported,
        signature: captured.signature?.replace('\\' + captured.name, '\\' + macro.name) };
      else macro.supported = false;
    }
    if ((macro.kind === 'newcommand' || macro.kind === 'NewDocumentCommand') && macros.has(macro.name)) {
      warn('命令 \\' + macro.name + ' 被再次声明；请检查实际 LaTeX 编译结果。索引采用后出现的定义。', macro.source);
    }
    macros.delete(macro.name);
    macros.set(macro.name, macro);
  }

  async function visit(path: string, depth: number): Promise<void> {
    if (visiting.has(path)) { warn('发现循环文件引用，已停止这一分支：' + path, path); return; }
    if (depth > MAX_DEPTH) { warn('文件依赖超过最大深度 ' + MAX_DEPTH + '，已停止这一分支。', path); return; }
    if (++visits > MAX_VISITS) {
      if (!limitReported) warn('文件读取次数超过上限 ' + MAX_VISITS + '，索引可能不完整。');
      limitReported = true; return;
    }
    const file = files.get(path);
    if (!file) { warn('项目中找不到文件：' + path); return; }
    if (file.kind !== 'doc') { warn('文件不是可读取的项目文本文档：' + path, path); return; }
    let parsed = parsedCache.get(path);
    if (!parsed) {
      let text: string;
      try { text = await readFile(file); }
      catch { warn('无法读取项目文件：' + path, path); return; }
      if (text.length > MAX_FILE_CHARACTERS) { warn('文件过大，已跳过（上限 ' + MAX_FILE_CHARACTERS + ' 字符）。', path); return; }
      totalCharacters += text.length;
      if (totalCharacters > MAX_TOTAL_CHARACTERS) { warn('项目读取内容超过总量上限，已跳过该文件。', path); return; }
      parsed = parseTex(text, path);
      parsedCache.set(path, parsed);
      index.diagnostics.push(...parsed.diagnostics);
    }
    if (!visited.has(path)) { visited.add(path); index.files.push(path); }
    visiting.add(path);
    try {
      for (const event of parsed.events) {
        if (event.type === 'macro') {
          const sourceId = 'file:' + path;
          // Keep a complete declaration tape for independent preview replay.
          registerSource({ ...sourceCatalog.get(sourceId), id: sourceId, kind: 'file', name: path, path });
          index.previewEvents!.push({ sourceId, type: 'macro', macro: { ...event.macro } });
          acceptMacro(event.macro);
        }
        else if (event.type === 'include') {
          const target = resolve(event.path, path, '.tex');
          if (target) await visit(target, depth + 1);
          else warn('未找到或无法静态解析引用文件：' + event.path, path);
        } else {
          const declaration = event.package;
          const target = resolve(declaration.name, path, '.sty');
          const packageKey = target ?? declaration.name;
          const packageOptions = declaration.options.join(',');
          const sourceId = target ? 'file:' + target : 'package:' + declaration.name;
          const previewSource: PreviewSource = target
            ? { id: sourceId, kind: 'file', name: target, path: target, packageName: declaration.name, options: [...declaration.options] }
            : { id: sourceId, kind: 'package', name: declaration.name, packageName: declaration.name, options: [...declaration.options] };
          // A local package's own definitions commonly follow its imports. Its
          // catalog position belongs at the first own declaration (or after its
          // dependencies if empty), while the execution tape retains the load event.
          if (!target) registerSource(previewSource);
          if (loadedPackages.has(packageKey)) {
            if (packageOptions && loadedPackages.get(packageKey) !== packageOptions) warn('宏包 ' + declaration.name + ' 使用了不同的选项，请检查编译兼容性。', path);
            continue;
          }
          loadedPackages.set(packageKey, packageOptions);
          index.previewEvents!.push({ sourceId, type: 'package', package: { ...declaration, options: [...declaration.options] } });
          index.packages.push(declaration);
          if (target) { await visit(target, depth + 1); registerSource(previewSource); }
        }
      }
    } finally { visiting.delete(path); }
  }

  const rootPath = normalize(options.rootPath);
  if (rootPath && files.has(rootPath)) await visit(rootPath, 0);
  else index.diagnostics.push({ level: 'error', message: '无法定位主文件；请确认项目的主文档设置。', source: options.rootPath });

  if (settings.extraFilesMode === 'auto') {
    const wanted = (settings.autoFileName || 'macros.sty').trim();
    const matches = [...files.keys()].filter(path => basename(path) === wanted);
    if (matches.length > 1) warn('发现多份 ' + wanted + '，没有自动选择额外宏文件。请在设置中指定路径：' + matches.join('、'));
    else if (matches.length === 1 && !visited.has(matches[0])) await visit(matches[0], 0);
  } else if (settings.extraFilesMode === 'manual') {
    for (const requested of [...new Set(settings.extraFiles)]) {
      const path = normalize(requested);
      if (!path || !files.has(path)) { warn('指定的额外宏文件不存在：' + requested); continue; }
      if (!visited.has(path)) await visit(path, 0);
    }
  }

  // Reject known recursive expansion and propagate known unsupported dependencies.
  const resolved = new Set<string>();
  const stack = new Set<string>();
  const cycleReports = new Set<string>();
  let macroDepthReported = false;
  const check = (name: string): boolean => {
    const macro = macros.get(name)!;
    if (resolved.has(name)) return macro.supported;
    if (stack.has(name)) {
      if (!cycleReports.has(name)) { warn('宏定义包含循环依赖：\\' + name, macro.source); cycleReports.add(name); }
      macro.supported = false; return false;
    }
    if (stack.size >= MAX_MACRO_DEPTH) {
      if (!macroDepthReported) { warn('宏依赖超过最大深度 ' + MAX_MACRO_DEPTH + '，相关命令的公式预览已停用。', macro.source); macroDepthReported = true; }
      macro.supported = false; return false;
    }
    stack.add(name);
    for (const match of macro.body.matchAll(/\\([A-Za-z@]+)/g)) {
      if (macros.has(match[1]) && !check(match[1])) macro.supported = false;
    }
    stack.delete(name); resolved.add(name);
    return macro.supported;
  };
  for (const name of macros.keys()) check(name);
  index.macros = [...macros.values()];
  index.commands = index.macros.map(macroToCommand);
  const unsupported = index.macros.filter(macro => !macro.supported).length;
  if (unsupported) index.diagnostics.push({ level: 'info', message: unsupported + ' 个自定义命令可参与补全，但其定义暂不支持可靠的公式预览。' });
  return index;
}
