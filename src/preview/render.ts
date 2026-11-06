import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import { Configuration, ConfigurationHandler } from 'mathjax-full/js/input/tex/Configuration.js';
import { MapHandler } from 'mathjax-full/js/input/tex/MapHandler.js';
import { CommandMap } from 'mathjax-full/js/input/tex/SymbolMap.js';
import { Macro } from 'mathjax-full/js/input/tex/Symbol.js';
import type { ParseMethod } from 'mathjax-full/js/input/tex/Types.js';
import TexError from 'mathjax-full/js/input/tex/TexError.js';
import type TexParser from 'mathjax-full/js/input/tex/TexParser.js';
import PhysicsMethods from 'mathjax-full/js/input/tex/physics/PhysicsMethods.js';
import 'mathjax-full/js/input/tex/ams/AmsConfiguration.js';
import 'mathjax-full/js/input/tex/newcommand/NewcommandConfiguration.js';
import 'mathjax-full/js/input/tex/configmacros/ConfigMacrosConfiguration.js';
import 'mathjax-full/js/input/tex/boldsymbol/BoldsymbolConfiguration.js';
import 'mathjax-full/js/input/tex/physics/PhysicsConfiguration.js';
import 'mathjax-full/js/input/tex/mathtools/MathtoolsConfiguration.js';
import 'mathjax-full/js/input/tex/braket/BraketConfiguration.js';
import 'mathjax-full/js/input/tex/cancel/CancelConfiguration.js';
import type { MacroDefinition, ProjectIndex } from '../core/types';
import { hasQtyConflict, packageNames, PACKAGE_CATALOG } from '../packages';
import { enablePartialSyntax } from './partial-syntax';

export const RENDER_LIMITS = Object.freeze({ formula: 12_000, definitions: 48_000, macros: 512, expansions: 1_000, matrixDimension: 32,
  placeholderCharacters: 4_096, svg: 2_000_000 });
export interface FormulaRenderOptions { tolerant?: boolean }
export interface FormulaResult {
  svg: string;
  diagnostics: string[];
  /** Bare command names, for metadata only; the SVG already marks them red. */
  unresolvedCommands?: string[];
  /** Incomplete syntax only. Callers must insert this via textContent, never HTML. */
  fallbackText?: string;
}

// This adaptor and MathJax module graph live inside the extension bundle. They do
// not read, replace, or configure window.MathJax or the website's renderer.
const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);

interface TolerantState { unresolved: Set<string>; diagnostics: string[]; characters: number }
const TOLERANT_STATE = 'personal-tolerant';
// Follow MathJax's bundled noundefined implementation, retaining the command
// itself as a red mtext atom. Text nodes escape markup; arguments remain in the
// input stream because an unknown command has no trustworthy argument grammar.
const unresolvedCommand: ParseMethod = (parser, control) => {
  const name = String(control).replace(/^\\/, '');
  const state = parser.configuration.packageData.get(TOLERANT_STATE) as TolerantState | undefined;
  if (state && (state.characters += name.length + 1) > RENDER_LIMITS.placeholderCharacters) {
    throw new TexError('PersonalPlaceholderLimit', '未知命令的预览占位文本超过长度限制');
  }
  if (state && !state.unresolved.has(name)) {
    state.unresolved.add(name);
    state.diagnostics.push(`未识别或暂不支持的命令：\\${name}`);
  }
  const text = parser.create('text', '\\' + name);
  parser.Push(parser.create('node', 'mtext', [], { mathcolor: '#c62828' }, text));
};
Configuration.create(TOLERANT_STATE, { fallback: { macro: unresolvedCommand }, priority: 3 });

function boundedSize(argument: string): void {
  const size = Number(argument);
  if (!Number.isSafeInteger(size) || size < 0 || size > RENDER_LIMITS.matrixDimension) {
    throw new TexError('PersonalMatrixLimit', `矩阵预览每维只支持 0–${RENDER_LIMITS.matrixDimension}，实际排版请查看 PDF`);
  }
}

// Physics' generated-matrix commands allocate arrays before maxBuffer can be
// checked. Bound those dimensions at the parser boundary, including macro use.
new CommandMap('personal-matrix-limits', {
  imat: 'identity', identitymatrix: 'identity',
  xmat: 'repeated', xmatrix: 'repeated',
  dmat: 'diagonal', diagonalmatrix: 'diagonal', admat: ['diagonal', true], antidiagonalmatrix: ['diagonal', true],
}, {
  identity(parser: TexParser, control) {
    const name = control as string;
    const start = parser.i;
    boundedSize(parser.GetArgument(name));
    parser.i = start;
    return PhysicsMethods.IdentityMatrix(parser, name);
  },
  repeated(parser: TexParser, control) {
    const name = control as string;
    const start = parser.i;
    parser.GetStar();
    parser.GetArgument(name);
    boundedSize(parser.GetArgument(name));
    boundedSize(parser.GetArgument(name));
    parser.i = start;
    return PhysicsMethods.XMatrix(parser, name);
  },
  diagonal(parser: TexParser, control, anti: boolean) {
    const name = control as string;
    if (parser.GetNext() !== '{') return;
    const start = parser.i;
    const entries = parser.GetArgument(name).split(',');
    if (entries.length > RENDER_LIMITS.matrixDimension) {
      throw new TexError('PersonalMatrixLimit', '对角矩阵预览最多支持 32 项');
    }
    parser.i = start;
    return PhysicsMethods.DiagonalMatrix(parser, name, anti);
  },
});
Configuration.create('personal-matrix-limits', {
  // configmacros (3) must retain precedence over our package fallback (4).
  handler: { macro: ['personal-matrix-limits'] }, priority: 4,
});

type ConfigMacro = string | [string, number] | [string, number, string];
const bareName = (name: string): string => name.replace(/^\\/, '');
function controlNames(tex: string): string[] {
  const names: string[] = [];
  for (let i = 0; i < tex.length; i++) {
    if (tex[i] === '%') {
      while (i < tex.length && tex[i] !== '\n') i++;
    } else if (tex[i] === '\\') {
      const start = ++i;
      if (/[A-Za-z@]/.test(tex[i] ?? '')) {
        while (i < tex.length && /[A-Za-z@]/.test(tex[i])) i++;
        names.push(tex.slice(start, i));
        i--;
      } else if (i < tex.length) names.push(tex[i]);
    }
  }
  return names;
}

function macroIsRenderable(macro: MacroDefinition): boolean {
  return macro.supported && /^[A-Za-z@]+$/.test(bareName(macro.name)) &&
    Number.isInteger(macro.args) && macro.args >= 0 && macro.args <= 9 &&
    (macro.optionalDefault === undefined || macro.args > 0);
}

function packageDefinesCommand(packageName: string, commandName: string): boolean {
  // A completion catalog is intentionally incomplete. Read the bundled
  // MathJax package maps too, including official aliases not shown as hints.
  if (Object.hasOwn(PACKAGE_CATALOG, packageName) && PACKAGE_CATALOG[packageName].some(command => command.name === commandName)) return true;
  let maps: string[] = [];
  if (packageName === 'amsmath' || packageName === 'mathtools') {
    maps.push(...(ConfigurationHandler.get('ams')?.handler.macro ?? []).filter(name => name.startsWith('AMSmath')));
  }
  if (packageName === 'amssymb') {
    maps.push(...(ConfigurationHandler.get('ams')?.handler.macro ?? []).filter(name => name.startsWith('AMSsymbols')));
  }
  if (['physics', 'mathtools', 'braket', 'cancel'].includes(packageName)) {
    maps.push(...(ConfigurationHandler.get(packageName)?.handler.macro ?? []));
  }
  return maps.some(name => MapHandler.getMap(name)?.contains(commandName));
}

function baselineDefinesCommand(commandName: string): boolean {
  if (commandName === 'ensuremath') return true;
  return ['base', 'ams', 'newcommand', 'boldsymbol'].some(name =>
    (ConfigurationHandler.get(name)?.handler.macro ?? []).some(map => MapHandler.getMap(map)?.contains(commandName)));
}

/** Source order is a preview-only override policy, not arbitrary TeX execution. */
function orderedPreviewIndex(index: ProjectIndex): ProjectIndex {
  const rank = new Map(index.previewSourceOrder?.map((id, position) => [id, position]));
  const packageName = (name: string) => name.replace(/\.sty$/i, '').trim();
  const packageRank = (name: string): number => {
    const canonical = packageName(name);
    const source = index.previewSources?.find(item => item.packageName === canonical && rank.has(item.id));
    return rank.get(source?.id ?? `package:${canonical}`) ?? -1;
  };
  const packages = index.previewSourceOrder === undefined ? index.packages
    : [...index.packages].sort((a, b) => packageRank(a.name) - packageRank(b.name));
  const macros = index.macros.filter(macro => {
    const name = bareName(macro.name);
    // providecommand is a fallback, never a replacement for a command already
    // supplied by this renderer's baseline or enabled package adapters. The
    // index separately handles preceding project-defined commands.
    if (['providecommand', 'ProvideDocumentCommand'].includes(macro.kind) && (baselineDefinesCommand(name)
      || packages.some(pkg => packageDefinesCommand(packageName(pkg.name), name)))) return false;
    const fileRank = rank.get(`file:${macro.source}`);
    if (fileRank === undefined) return true;
    // Omit only definitions superseded by an actual supported package command.
    // This happens before reachability checks so an overridden, unsupported
    // custom definition cannot incorrectly block the package implementation.
    return !packages.some(pkg => packageRank(pkg.name) > fileRank && packageDefinesCommand(packageName(pkg.name), name));
  });
  if (macros.length === index.macros.length) return { ...index, packages, macros };
  // The completion index propagates unsupported dependencies. A dependency
  // that was just shadowed by a package/fallback must not poison its wrappers.
  // Recover only a verified parser-original definition; unresolved let
  // snapshots and genuinely unsupported syntax retain their original flags.
  const originals = new Map<string, MacroDefinition>();
  for (const event of index.previewEvents ?? []) if (event.type === 'macro') {
    originals.set(event.macro.source + '\0' + event.macro.offset, event.macro);
  }
  const effectiveMacros = macros.map(macro => {
    const original = originals.get(macro.source + '\0' + macro.offset);
    return macro.kind !== 'let' && original?.supported && original.kind === macro.kind && original.name === macro.name
      && original.body === macro.body && original.args === macro.args && original.optionalDefault === macro.optionalDefault
      ? { ...macro, supported: true } : macro;
  });
  return { ...index, packages, macros: effectiveMacros };
}

/** Only follow macros reachable from this formula, retaining source diagnostics. */
function reachableMacros(tex: string, macros: MacroDefinition[]): { used: Set<string>; unsupported: MacroDefinition[]; definitions: MacroDefinition[] } {
  const definitions = new Map(macros.map(macro => [bareName(macro.name), macro]));
  const used = new Set<string>();
  const unsupported: MacroDefinition[] = [];
  const pending = controlNames(tex);
  while (pending.length) {
    const name = pending.pop()!;
    if (used.has(name)) continue;
    used.add(name);
    const macro = definitions.get(name);
    if (!macro) continue;
    if (!macroIsRenderable(macro)) unsupported.push(macro);
    else pending.push(...controlNames(macro.body), ...controlNames(macro.optionalDefault ?? ''));
  }
  return { used, unsupported, definitions: [...definitions.values()].filter(macro => used.has(bareName(macro.name))) };
}

/** Render an expression with a fresh TeX context, so no project macros persist. */
export async function renderFormula(tex: string, index: ProjectIndex, display: boolean, options: FormulaRenderOptions = {}): Promise<FormulaResult> {
  index = orderedPreviewIndex(index);
  const diagnostics: string[] = [];
  const unresolved = new Set<string>();
  const metadata = () => options.tolerant ? { unresolvedCommands: [...unresolved] } : {};
  const failed = (message: string, incomplete = false): FormulaResult => ({
    svg: '', diagnostics: [...new Set([...diagnostics, message])], ...metadata(),
    ...(options.tolerant && incomplete ? { fallbackText: tex } : {}),
  });
  if (tex.length > RENDER_LIMITS.formula) return failed(`公式超过预览长度限制（${RENDER_LIMITS.formula} 字符）。`);
  const reachable = reachableMacros(tex, index.macros);
  if (reachable.definitions.length > RENDER_LIMITS.macros) return failed(`本式引用的自定义宏超过预览数量限制（${RENDER_LIMITS.macros}）。`);
  if (reachable.definitions.reduce((total, macro) => total + macro.body.length + (macro.optionalDefault?.length ?? 0), 0) > RENDER_LIMITS.definitions) {
    return failed('宏定义总长度超过预览限制。');
  }
  if (reachable.unsupported.length && !options.tolerant) {
    return { svg: '', diagnostics: reachable.unsupported.map(macro =>
      `暂不支持预览自定义命令 \\${bareName(macro.name)}（${macro.kind}，${macro.source}）；请查看编译后的 PDF。`) };
  }
  const blocked = new Set(reachable.unsupported.map(macro => bareName(macro.name)));
  if (hasQtyConflict(index) && reachable.used.has('qty')) {
    if (!options.tolerant) return failed('无法确定 \\qty 来自 physics 还是 siunitx；请明确其定义后再预览。');
    blocked.add('qty');
  }

  const names = packageNames(index);
  const packages = ['base', 'ams', 'newcommand', 'boldsymbol'];
  // AMS is the normal baseline for math previews. Other packages are opt-in;
  // in particular, physics must not silently redefine a project's commands.
  for (const name of index.packages.map(pkg => pkg.name.replace(/\.sty$/i, '').trim())) {
    if (['physics', 'mathtools', 'braket', 'cancel'].includes(name) && !packages.includes(name)) packages.push(name);
  }
  if (names.has('physics')) packages.push('personal-matrix-limits');
  if (options.tolerant) packages.push(TOLERANT_STATE);
  // User macros are applied last and therefore override package definitions.
  packages.push('configmacros');
  const macros: Record<string, ConfigMacro> = Object.create(null);
  // This entry point already parses math mode. LaTeX's \ensuremath uses
  // \@firstofone in that mode: expand one argument without adding a math atom
  // or a group. An extra {#1} would change relation spacing and script binding.
  // MathJax's macro parser preserves explicit groups inside the argument and
  // counts this expansion toward maxMacros; do not strip it with a regexp.
  macros.ensuremath = ['#1', 1];
  if (names.has('bm')) macros.bm = ['\\boldsymbol{#1}', 1];
  for (const macro of reachable.definitions) {
    if (!macroIsRenderable(macro)) continue;
    const name = bareName(macro.name);
    macros[name] = macro.optionalDefault !== undefined
      ? [macro.body, macro.args, macro.optionalDefault]
      : macro.args ? [macro.body, macro.args] : macro.body;
  }
  const physicsOptions = new Set(index.packages.filter(pkg => pkg.name === 'physics').flatMap(pkg => pkg.options));
  if ([...physicsOptions].some(option => !['italicdiff', 'arrowdel'].includes(option))) {
    return failed(`physics 的预览尚不支持选项 ${[...physicsOptions].filter(option => !['italicdiff', 'arrowdel'].includes(option)).join('、')}；请查看 PDF。`, true);
  }

  try {
    let parseError: TexError | undefined;
    const input = new TeX({
      packages, macros, tags: 'none',
      maxMacros: RENDER_LIMITS.expansions,
      maxBuffer: RENDER_LIMITS.definitions + RENDER_LIMITS.formula,
      ...(names.has('physics') ? { physics: { italicdiff: physicsOptions.has('italicdiff'), arrowdel: physicsOptions.has('arrowdel') } } : {}),
      formatError(jax: TeX<unknown, unknown, unknown>, error: TexError) {
        parseError = error;
        diagnostics.push(`公式预览失败：${error.message}`);
        // Do not typeset MathJax's error banner (which can repeat a large input
        // and is never displayed). The error result below owns the draft text.
        return jax.parseOptions.nodeFactory.create('node', 'mrow', []);
      },
    });
    if (options.tolerant) {
      enablePartialSyntax(input.parseOptions, diagnostics);
      // configmacros allocates a fresh map for each TeX instance. Add blocked
      // names there, ahead of package handlers, without changing global maps or
      // executing unsupported replacement bodies (including baseline names).
      input.parseOptions.packageData.set(TOLERANT_STATE, { unresolved, diagnostics, characters: 0 } satisfies TolerantState);
      const commands = input.parseOptions.handlers.retrieve('configmacros-map') as CommandMap;
      for (const name of blocked) commands.add(name, new Macro(name, unresolvedCommand));
    }
    const output = new SVG({ fontCache: 'none', internalSpeechTitles: false });
    const document = mathjax.document('', { InputJax: input, OutputJax: output });
    const node = document.convert(tex, { display, em: 16, ex: 8, containerWidth: 80 * 16 });
    if (parseError) {
      // Resource limits must remain hard failures in every mode. Syntax errors
      // instead expose bounded plain source text for the caller's draft view.
      const bounded = /^(?:MaxMacroSub[12]|MaxBufferSize|Personal\w*Limit)$/.test(parseError.id);
      return failed(`公式预览失败：${parseError.message}`, !bounded);
    }
    const svgNode = adaptor.tags(node, 'svg')[0];
    if (!svgNode) return failed('公式预览未返回 SVG。');
    const svg = adaptor.outerHTML(svgNode);
    if (svg.length > RENDER_LIMITS.svg) return failed('公式的 SVG 预览超过长度限制。');
    // Only generated SVG is returned. Never return TeX, source HTML, or an
    // error node for the caller to insert as HTML. External resources are off.
    if (/<\s*(?:script|foreignObject|iframe|image)\b/i.test(svg) || /\s(?:on\w+)\s*=/i.test(svg) ||
      /\s(?:xlink:)?href\s*=\s*["'](?!#)/i.test(svg) || /url\s*\(/i.test(svg)) {
      return failed('公式包含预览不允许的外部资源或交互属性。');
    }
    return { svg, diagnostics: [...new Set(diagnostics)], ...metadata() };
  } catch (error) {
    return failed(`公式预览失败：${error instanceof Error ? error.message : String(error)}`);
  }
}
