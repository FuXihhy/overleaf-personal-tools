import type { CommandEntry, Diagnostic, MacroDefinition, PackageDeclaration } from './types';

export type TexEvent =
  | { type: 'macro'; macro: MacroDefinition; offset: number }
  | { type: 'package'; package: PackageDeclaration; offset: number }
  | { type: 'include'; path: string; command: 'input' | 'include'; offset: number };
export interface ParseResult { events: TexEvent[]; diagnostics: Diagnostic[] }

interface Group { text: string; end: number; start?: number }
interface Argument { type: 'm' | 'o' | 'O' | 's'; defaultValue?: string }
const definitionNames = new Set(['newcommand', 'renewcommand', 'providecommand', 'DeclareRobustCommand']);
const documentDefinitionNames = new Set(['NewDocumentCommand', 'RenewDocumentCommand', 'ProvideDocumentCommand', 'DeclareDocumentCommand']);
const unsafeBody = /\\(?:begin|end|draw|tikz|node|foreach|includegraphics|input|include|write|read|openout|openin|special|directlua|catcode|csname|expandafter|if\w*|else|fi|If\w*|label|ref|pageref|footnote|section|def|gdef|edef|xdef|let|newcommand|renewcommand|usepackage|RequirePackage)\b/;

/** Replace comments with spaces, retaining offsets and line breaks for diagnostics. */
export function maskComments(text: string): string {
  let result = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && i + 1 < text.length) {
      result += text[i] + text[++i];
    } else if (text[i] === '%') {
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') { result += ' '; i++; }
      if (i < text.length) result += text[i];
    } else result += text[i];
  }
  return result;
}

function removeComments(text: string): string {
  let result = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && i + 1 < text.length) result += text[i] + text[++i];
    else if (text[i] === '%') {
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
      if (text[i] === '\r' && text[i + 1] === '\n') i++;
    } else result += text[i];
  }
  return result;
}

function whitespace(text: string, at: number): number { while (/\s/.test(text[at] ?? '') && at < text.length) at++; return at; }
function control(text: string, at: number): { name: string; end: number } | undefined {
  if (text[at] !== '\\' || at + 1 >= text.length) return;
  let end = at + 1;
  if (/[A-Za-z@]/.test(text[end])) { while (/[A-Za-z@]/.test(text[end] ?? '') && end < text.length) end++; }
  else end++;
  return { name: text.slice(at + 1, end), end };
}

function group(text: string, at: number, open = '{', close = '}'): Group | undefined {
  at = whitespace(text, at);
  if (text[at] !== open) return;
  const start = at + 1;
  let depth = 1;
  let braceDepth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    // A closing square bracket inside {...} does not end an optional argument.
    if (open === '[') {
      if (text[i] === '{') braceDepth++;
      else if (text[i] === '}') braceDepth--;
      if (braceDepth > 0 || text[i] === '}') continue;
    }
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return { text: text.slice(start, i), end: i + 1, start };
  }
}

function macroName(text: string, at: number): { name: string; end: number } | undefined {
  at = whitespace(text, at);
  const wrapped = group(text, at);
  if (wrapped) {
    const token = control(wrapped.text.trim(), 0);
    if (token && token.end === wrapped.text.trim().length) return { name: token.name, end: wrapped.end };
    return;
  }
  return control(text, at);
}

function xparseArguments(specification: string): { args: Argument[]; supported: boolean } {
  const args: Argument[] = [];
  let supported = true;
  for (let i = 0; i < specification.length;) {
    i = whitespace(specification, i);
    if (i >= specification.length) break;
    const token = specification[i++];
    if (token === 'm' || token === 'o' || token === 's') args.push({ type: token });
    else if (token === 'O') {
      const value = group(specification, i);
      if (!value) { supported = false; break; }
      args.push({ type: 'O', defaultValue: value.text }); i = value.end;
    } else { supported = false; break; }
  }
  return { args, supported };
}

function signature(name: string, args: Argument[]): string {
  return '\\' + name + args.map(arg => arg.type === 'm' ? '{arg}' : arg.type === 's' ? '*' : '[' + (arg.defaultValue ?? 'optional') + ']').join('');
}

/** A bounded declaration scanner, deliberately not a TeX interpreter. */
export function parseTex(input: string, source = ''): ParseResult {
  const text = maskComments(input);
  const events: TexEvent[] = [];
  const diagnostics: Diagnostic[] = [];
  const warn = (message: string) => diagnostics.push({ level: 'warning', message, source });
  let scopeDepth = 0;
  let inConditional = 0;
  let reportedConditional = false;
  for (let i = 0; i < text.length;) {
    if (text[i] === '{') { scopeDepth++; i++; continue; }
    if (text[i] === '}') { scopeDepth = Math.max(0, scopeDepth - 1); i++; continue; }
    const token = control(text, i);
    if (!token) { i++; continue; }
    const start = i;
    const kind = token.name;
    i = token.end;
    if (kind === 'verb') {
      if (text[i] === '*') i++;
      const delimiter = text[i++];
      if (delimiter) { const end = text.indexOf(delimiter, i); i = end < 0 ? text.length : end + 1; }
      continue;
    }
    if (kind === 'begin') {
      const environment = group(text, i);
      if (environment && /^(?:verbatim\*?|Verbatim|lstlisting|minted|comment|filecontents\*?)$/.test(environment.text.trim())) {
        const endToken = '\\end{' + environment.text.trim() + '}';
        const end = text.indexOf(endToken, environment.end);
        if (end < 0) { warn('代码或注释环境未闭合，已停止扫描该区域。'); i = text.length; }
        else i = end + endToken.length;
        continue;
      }
    }
    if (kind === 'newif') { const flag = control(text, whitespace(text, i)); if (flag) i = flag.end; continue; }
    if (kind === 'begingroup' || kind === 'bgroup') { scopeDepth++; continue; }
    if (kind === 'endgroup' || kind === 'egroup') { scopeDepth = Math.max(0, scopeDepth - 1); continue; }
    if (/^if/.test(kind) && kind !== 'ifthenelse') {
      inConditional++;
      if (!reportedConditional) { warn('条件分支中的声明未加入静态索引；此扩展不执行 TeX 条件判断。'); reportedConditional = true; }
      continue;
    }
    if (kind === 'fi') { inConditional = Math.max(0, inConditional - 1); continue; }
    // Local/conditional definitions cannot safely be promoted to project-wide state.
    if (scopeDepth > 0 || inConditional > 0) continue;
    if (kind === 'usepackage' || kind === 'RequirePackage') {
      const options = group(text, i, '[', ']');
      if (options) i = options.end;
      const packages = group(text, i);
      if (!packages) { warn('无法解析宏包声明。'); continue; }
      i = packages.end;
      for (const name of packages.text.split(',').map(value => value.trim()).filter(Boolean)) {
        events.push({ type: 'package', offset: start, package: { name, options: options?.text.split(',').map(value => value.trim()).filter(Boolean) ?? [], source } });
      }
      continue;
    }
    if (kind === 'input' || kind === 'include') {
      const file = group(text, i);
      if (file) { events.push({ type: 'include', command: kind, path: file.text.trim(), offset: start }); i = file.end; }
      else if (kind === 'input') {
        i = whitespace(text, i);
        const match = /^[^\s{}\\]+/.exec(text.slice(i));
        if (match) { events.push({ type: 'include', command: kind, path: match[0], offset: start }); i += match[0].length; }
      }
      continue;
    }
    if (kind === 'DeclareMathAlphabet') {
      const name = macroName(text, i);
      if (!name) { warn('无法解析数学字体声明的命令名。'); continue; }
      i = name.end;
      const font: string[] = [];
      for (let part = 0; part < 4; part++) {
        const value = group(text, i);
        if (!value) break;
        font.push(value.text.trim()); i = value.end;
      }
      if (font.length !== 4) { warn('无法完整解析数学字体声明：\\' + name.name); continue; }
      // A bounded font-family adaptation, independent of the user's command
      // name. Never substitute a visually different font for an unknown family.
      const supported = font.join('/') === 'OML/cmm/b/it';
      events.push({ type: 'macro', offset: start, macro: {
        name: name.name, kind, source, offset: start, raw: input.slice(start, i),
        args: 1, body: supported ? '\\mathbfit{#1}' : '', supported,
        signature: '\\' + name.name + '{arg} — ' + font.join('/'),
      } });
      if (!supported) warn('数学字体声明 \\' + name.name + '（' + font.join('/') + '）尚无可靠的 MathJax 适配，请使用 TeX 预览。');
      continue;
    }
    if (!(definitionNames.has(kind) || documentDefinitionNames.has(kind) || kind === 'DeclareMathOperator' || kind === 'def' || kind === 'gdef' || kind === 'let')) continue;
    let starred = false;
    i = whitespace(text, i);
    if (text[i] === '*') { starred = true; i++; }
    const name = macroName(text, i);
    if (!name) { warn('无法解析 \\' + kind + ' 的命令名。'); continue; }
    i = name.end;
    let args: Argument[] = [];
    let body: Group | undefined;
    let supported = true;
    let completeArgumentSpecification = true;
    let optionalDefault: string | undefined;
    if (definitionNames.has(kind)) {
      const count = group(text, i, '[', ']');
      if (count) {
        i = count.end;
        if (!/^[0-9]$/.test(count.text.trim())) supported = false;
        const n = /^[0-9]$/.test(count.text.trim()) ? Number(count.text.trim()) : 0;
        args = Array.from({ length: n }, () => ({ type: 'm' as const }));
        const optional = group(text, i, '[', ']');
        if (optional) {
          i = optional.end; optionalDefault = optional.text;
          if (n < 1) supported = false;
          else args[0] = { type: 'O', defaultValue: optional.text };
        }
      }
      body = group(text, i);
    } else if (documentDefinitionNames.has(kind)) {
      const spec = group(text, i);
      if (!spec) { warn('无法解析 \\' + name.name + ' 的 xparse 参数。'); continue; }
      const parsed = xparseArguments(spec.text);
      args = parsed.args;
      supported = parsed.supported;
      completeArgumentSpecification = parsed.supported;
      // Only mandatory arguments and one leading optional argument with a default
      // can be represented by the common renderer macro format.
      supported &&= args.every((arg, index) => arg.type === 'm' || (index === 0 && arg.type === 'O'));
      if (args[0]?.type === 'O') optionalDefault = args[0].defaultValue;
      body = group(text, spec.end);
    } else if (kind === 'DeclareMathOperator') {
      body = group(text, i);
    } else if (kind === 'let') {
      i = whitespace(text, i); if (text[i] === '=') i = whitespace(text, i + 1);
      const target = control(text, i);
      if (target) body = { text: '\\' + target.name, end: target.end };
      else if (i < text.length) body = { text: text[i], end: i + 1 };
    } else {
      const parameterStart = i;
      while (i < text.length && text[i] !== '{' && text[i] !== '\n') i++;
      const parameters = text.slice(parameterStart, i).replace(/\s/g, '');
      const matches = [...parameters.matchAll(/#([1-9])/g)];
      const n = matches.reduce((largest, match) => Math.max(largest, Number(match[1])), 0);
      supported = parameters === Array.from({ length: n }, (_, index) => '#' + (index + 1)).join('');
      args = Array.from({ length: n }, () => ({ type: 'm' as const }));
      body = group(text, i);
    }
    if (!body) { warn('无法完整解析 \\' + name.name + ' 的定义。'); continue; }
    i = body.end;
    const bodyText = body.start !== undefined ? removeComments(input.slice(body.start, body.end - 1)) : body.text;
    const replacement = kind === 'DeclareMathOperator' ? '\\operatorname' + (starred ? '*' : '') + '{' + bodyText + '}' : bodyText;
    supported &&= !unsafeBody.test(replacement);
    const macro: MacroDefinition = {
      name: name.name, body: replacement, args: args.length, raw: input.slice(start, i),
      kind, source, offset: start, supported, signature: completeArgumentSpecification ? signature(name.name, args) : '\\' + name.name + ' …',
      ...(optionalDefault !== undefined ? { optionalDefault } : {}),
    };
    events.push({ type: 'macro', macro, offset: start });
  }
  if (scopeDepth || inConditional) warn('文件中存在未闭合分组或条件块；其中的定义未加入全局索引。');
  return { events, diagnostics };
}

function argumentsForMacro(macro: MacroDefinition): Argument[] {
  if (documentDefinitionNames.has(macro.kind)) {
    const text = maskComments(macro.raw);
    const command = control(text, 0);
    const name = command && macroName(text, command.end);
    const spec = name && group(text, name.end);
    if (spec) { const parsed = xparseArguments(spec.text); return parsed.supported ? parsed.args : []; }
  }
  return Array.from({ length: macro.args }, (_, index) => index === 0 && macro.optionalDefault !== undefined ? { type: 'O', defaultValue: macro.optionalDefault } : { type: 'm' });
}

export function macroToCommand(macro: MacroDefinition): CommandEntry {
  let position = 0;
  const escape = (value: string) => value.replace(/[\\{}$]/g, '\\$&');
  const snippet = '\\' + macro.name + argumentsForMacro(macro).map(arg => {
    // Optional stars are left out of the default insertion.
    if (arg.type === 's') return '';
    const placeholder = '${' + (++position) + ':' + escape(arg.defaultValue ?? (arg.type === 'm' ? 'arg' : 'optional')) + '}';
    return arg.type === 'm' ? '{' + placeholder + '}' : '[' + placeholder + ']';
  }).join('');
  return { name: macro.name, signature: macro.signature, snippet, source: macro.source, description: macro.body, preview: macro.supported ? 'supported' : 'unsupported' };
}
