#!/usr/bin/env node
// Local, read-only macro audit. No personal paths or definitions belong here.
// Usage: node scripts/audit-macros.mjs --out artifacts/macro-audit [--third-party PATH] PATH...
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = value => createHash('sha256').update(value).digest('hex');
const skipSpace = (text, at) => { while (/\s/.test(text[at] ?? '') && at < text.length) at++; return at; };
function group(text, at, open = '{', close = '}') {
  at = skipSpace(text, at); if (text[at] !== open) return;
  let depth = 1; const start = ++at;
  for (; at < text.length; at++) {
    if (text[at] === '\\') { at++; continue; }
    if (text[at] === open) depth++;
    if (text[at] === close && --depth === 0) return { value: text.slice(start, at), end: at + 1 };
  }
}
function control(text, at) {
  at = skipSpace(text, at);
  const match = /^\\([A-Za-z@]+|[^\s])/.exec(text.slice(at));
  return match && { name: match[1], end: at + match[0].length };
}
function target(text, at) {
  const wrapped = group(text, at);
  if (wrapped) return { name: wrapped.value.trim().replace(/^\\/, ''), end: wrapped.end };
  return control(text, at);
}
const declarationPattern = /\\(?:DeclareMathAlphabet|DeclareMathSymbol|DeclareSymbolFont|SetMathAlphabet|DeclarePairedDelimiter(?:XPP|X)?|DeclareMathOperator|DeclareRobustCommand|(?:New|Renew|Provide|Declare)DocumentCommand|newcommand|renewcommand|providecommand|newenvironment|renewenvironment|newtheorem|def|gdef|edef|xdef|let|definecolor|tikzset|tikzstyle)\b/g;

/** Inventory includes declarations the extension deliberately does not parse. */
export function inventoryDeclarations(text, parsed, masked) {
  const indexed = new Map(parsed.events.filter(event => event.type === 'macro').map(event => [event.offset, event.macro]));
  const rows = []; let coveredUntil = 0;
  for (const match of masked.matchAll(declarationPattern)) {
    const offset = match.index;
    if (offset < coveredUntil) continue;
    const kind = match[0].slice(1);
    const macro = indexed.get(offset);
    let at = skipSpace(masked, offset + match[0].length);
    if (masked[at] === '*') at++;
    const named = target(masked, at);
    let name = named?.name ?? `${kind}@${offset}`;
    let end = named?.end ?? at;
    if (macro) { end = offset + macro.raw.length; name = macro.name; }
    else if (/^(?:gdef|edef|xdef|def)$/.test(kind)) {
      const bodyStart = masked.indexOf('{', end);
      end = group(masked, bodyStart)?.end ?? end;
    } else if (kind === 'let') {
      at = skipSpace(masked, end); if (masked[at] === '=') at++;
      end = control(masked, at)?.end ?? at + 1;
    } else {
      // Remaining forms have a bounded sequence of grouped/optional arguments.
      for (let part = 0; part < 8; part++) {
        at = skipSpace(masked, end); if (masked[at] === '=') at = skipSpace(masked, at + 1);
        const next = group(masked, at) ?? group(masked, at, '[', ']');
        if (!next) break;
        end = next.end;
      }
    }
    coveredUntil = end;
    const line = text.slice(0, offset).split('\n').length;
    const declarationType = /^(?:newtheorem|newenvironment|renewenvironment)$/.test(kind) ? 'environment'
      : /^(?:DeclareSymbolFont|SetMathAlphabet|definecolor|tikzset|tikzstyle)$/.test(kind) ? 'resource' : 'command';
    if (kind === 'tikzset') name = name.split(/[={]/)[0].trim();
    rows.push({ id: `${kind}:${name}:${offset}`, name, kind, line, offset, raw: text.slice(offset, end),
      declarationType, parserRecognized: !!macro, ...(macro ? { macro } : {}) });
  }
  return rows;
}

function argumentKinds(row) {
  const macro = row.macro;
  if (!macro) return row.kind === 'DeclareMathAlphabet' ? ['m'] : [];
  if (/DocumentCommand$/.test(row.kind)) {
    const start = control(row.raw, 0);
    const name = target(row.raw, start.end);
    const spec = group(row.raw, name?.end ?? start.end)?.value ?? '';
    const args = [];
    for (let at = 0; at < spec.length;) {
      at = skipSpace(spec, at); const token = spec[at++];
      if (token === 'm') args.push('m');
      else if (token === 'o' || token === 's') args.push(token);
      else if (token === 'O') { args.push('O'); at = group(spec, at)?.end ?? at; }
      else break;
    }
    return args;
  }
  return Array.from({ length: macro.args }, (_, i) => i === 0 && macro.optionalDefault !== undefined ? 'O' : 'm');
}

/** Representative contexts are recorded, never silently substituted for a failure. */
export function representativeCase(row, rows) {
  if (row.declarationType === 'resource') return { context: 'setup', formula: '', texBody: '', caseNote: 'Declaration is covered only by the TeX preamble health check.' };
  if (row.declarationType === 'environment') {
    const formula = `\\begin{${row.name}}Example.\\end{${row.name}}`;
    return { context: 'environment', formula, texBody: formula };
  }
  const definitions = new Map(rows.filter(item => item.macro).map(item => [item.name, item.macro]));
  const dependencies = []; const seen = new Set(); const pending = [row.name];
  while (pending.length && seen.size < 1000) {
    const name = pending.pop(); if (seen.has(name)) continue; seen.add(name);
    const definition = definitions.get(name); if (!definition) continue;
    dependencies.push(definition.body);
    pending.push(...[...definition.body.matchAll(/\\([A-Za-z@]+)/g)].map(match => match[1]));
  }
  const body = row.macro?.body ?? '';
  const allBodies = dependencies.join('\n');
  const drawing = /\\(?:tikz|draw|node|foreach|strand)\b|\\begin\{(?:tikzpicture|knot)\}/.test(allBodies);
  const ownsPicture = /\\begin\{tikzpicture\}|\\tikz\b/.test(allBodies);
  const textSize = /\\(?:tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge)\b/.test(body);
  const textOnly = /hyper-K|K\\"ahler|\\textit\{i\.e\.\}|\\begin\{tcolorbox\}/.test(body)
    || textSize && /\\yng\b/.test(body);
  const kinds = argumentKinds(row);
  const args = kinds.filter(kind => kind === 'm').map((_, i) => drawing && !ownsPicture ? (i < 2 ? '0' : 'x') : 'x');
  if (drawing && /\\foreach/.test(body)) args.fill('1');
  if (drawing && ownsPicture && /\\begin\{tikzpicture\}\[#[12]\]#[12]|\\mathtikz/.test(body)) args.fill('\\draw (0,0)--(1,0);');
  let formula = '\\' + row.name + args.map(arg => '{' + arg + '}').join('');
  let context = drawing ? 'tikz' : textOnly ? 'text' : 'math';
  let caseNote = '';
  // Zero-argument aliases of an accent/font still consume an operand afterwards.
  if (!kinds.length && /^\s*\{*\s*\\(?:widehat|widetilde|hat|tilde|bar|overline|underline|vec|dot|ddot|mathbb|mathbf|mathcal|mathsf|mathfrak|mathscr)\s*\}*\s*$/.test(body)) {
    formula += '{x}'; caseNote = 'Alias consumes a following operand.';
  }
  if (/\\yng\b/.test(body) && !kinds.length) {
    formula += '(2,1)'; caseNote = 'youngtab alias consumes a parenthesized row-length list.';
  }
  if (/^\s*\\left\s*$/.test(body)) { formula += '(x\\right)'; caseNote = 'Paired delimiter context.'; }
  if (/^\s*\\right\s*$/.test(body)) { formula = '\\left(x' + formula + ')'; caseNote = 'Paired delimiter context.'; }
  if (/\\color\b/.test(body) && !kinds.length) formula = '{' + formula + ' x}';
  const begins = [...body.matchAll(/\\begin\{([^}]+)\}/g)].map(match => match[1]);
  const ends = [...body.matchAll(/\\end\{([^}]+)\}/g)].map(match => match[1]);
  if (begins.length && !ends.length && !kinds.length) {
    const close = [...begins].reverse().map(name => `\\end{${name}}`).join('');
    const partner = rows.find(item => item.macro?.body.replace(/\s/g, '') === close);
    formula += ' ' + (begins.includes('aligned') || begins.includes('eqnarray') ? 'x&=x' : 'x=x') + (partner ? '\\' + partner.name : close);
    context = 'environment'; caseNote = 'Opening alias tested together with its matching closing alias.';
  } else if (ends.length && !begins.length && !kinds.length) {
    const open = [...ends].reverse().map(name => `\\begin{${name}}`).join('');
    const partner = rows.find(item => item.macro?.body.replace(/\s/g, '') === open);
    formula = (partner ? '\\' + partner.name : open) + ' ' + (ends.includes('aligned') || ends.includes('eqnarray') ? 'x&=x' : 'x=x') + formula;
    context = 'environment'; caseNote = 'Closing alias tested together with its matching opening alias.';
  } else if (begins.some(name => ['equation', 'align', 'aligned', 'eqnarray'].includes(name))) context = 'environment';
  if (/\\nonumber\b|\\notag\b/.test(body)) { formula = '\\begin{align}x&=x' + formula + '\\end{align}'; context = 'environment'; }
  let texBody = context === 'math' ? '\\(' + formula + '\\)' : formula;
  if (context === 'text' && textSize) texBody = '{' + formula + '}';
  if (drawing) {
    if (!ownsPicture) texBody = '\\begin{tikzpicture}' + formula + '\\end{tikzpicture}';
    else if (/\\mathchoice|\\ensuremath|\\mathtikz/.test(body)) texBody = '\\(' + formula + '\\)';
  }
  return { context, formula, texBody, caseNote, usesScriptAlphabet: /\\mathscr\b/.test(allBodies) };
}

function csv(rows, fields) {
  const escape = value => '"' + String(value ?? '').replace(/"/g, '""') + '"';
  return fields.join(',') + '\n' + rows.map(row => fields.map(field => escape(Array.isArray(row[field]) ? row[field].join('\n') : row[field])).join(',')).join('\n') + '\n';
}

function failureSummary(rows) {
  const groups = new Map();
  for (const row of rows.filter(item => item.status === 'requires-tex-or-fix')) {
    const unknown = row.diagnostics.join('\n').match(/Undefined control sequence (\\\S+)/);
    const key = unknown ? unknown[0] : row.context === 'tikz' ? 'Drawing definition requires TeX'
      : row.context === 'environment' ? 'Document environment requires TeX'
      : 'Definition is outside the supported MathJax subset';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row.declarationType === 'environment' ? '`' + row.name + '` environment' : '`\\' + row.name + '`');
  }
  return [...groups].map(([reason, names]) => '| ' + reason + ' | ' + names.join(', ') + ' |');
}

async function main() {
  const args = process.argv.slice(2); const paths = []; const thirdParty = new Set();
  let output = resolve(root, 'artifacts/macro-audit');
  for (let at = 0; at < args.length; at++) {
    if (args[at] === '--out') output = resolve(args[++at]);
    else if (args[at] === '--third-party') { const path = resolve(args[++at]); thirdParty.add(path); paths.push(path); }
    else if (args[at].startsWith('--')) throw new Error('Unknown argument: ' + args[at]);
    else paths.push(resolve(args[at]));
  }
  if (!paths.length) throw new Error('Pass explicit macros.sty paths. Originals are read-only; reports stay local.');
  await mkdir(output, { recursive: true });
  const temporary = await mkdtemp(join(tmpdir(), 'overleaf-macro-audit-'));
  try {
    const library = join(temporary, 'audit-library.mjs');
    await build({ stdin: { contents: `export { parseTex, maskComments } from './src/core/parser.ts'; export { buildProjectIndex } from './src/core/project-index.ts'; export { enrichIndex } from './src/packages/index.ts'; export { renderFormula } from './src/preview/render.ts'; export { DEFAULT_SETTINGS } from './src/core/types.ts';`, resolveDir: root },
      bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: library, logLevel: 'silent' });
    const api = await import(pathToFileURL(library).href);
    const report = { generatedAt: new Date().toISOString(), scope: 'Explicit local files only; no uploads; MathJax formula-mode smoke checks, not a proof of full TeX equivalence.', files: [] };
    const unique = new Map();
    for (const path of [...new Set(paths)]) {
      const bytes = await readFile(path); const text = bytes.toString('utf8'); const fingerprint = hash(bytes);
      const parsed = api.parseTex(text, 'macros.sty');
      const index = api.enrichIndex(await api.buildProjectIndex({ files: [{ id: 'audit', path: 'macros.sty', kind: 'doc' }], rootPath: 'macros.sty',
        settings: { ...api.DEFAULT_SETTINGS, extraFilesMode: 'none' }, readFile: async () => text }));
      const rows = inventoryDeclarations(text, parsed, api.maskComments(text));
      const last = new Map(rows.map(row => [row.declarationType + ':' + row.name, row.offset]));
      for (const row of rows) {
        Object.assign(row, representativeCase(row, rows));
        const effective = index.macros.find(macro => macro.name === row.name);
        row.effective = row.parserRecognized ? effective?.offset === row.offset : last.get(row.declarationType + ':' + row.name) === row.offset;
        row.shadowed = !row.effective;
        row.parserSupported = row.macro?.supported ?? null;
        row.status = 'pending';
      }
      const file = { path, hash: fingerprint, bytes: bytes.length, thirdParty: thirdParty.has(path),
        duplicateOf: unique.get(fingerprint)?.path ?? null, declarations: rows, indexDiagnostics: index.diagnostics };
      report.files.push(file);
      if (!unique.has(fingerprint)) unique.set(fingerprint, { path, index, file, text });
    }
    // Publish the shared inventory first so the independent TeX audit can start.
    await writeFile(join(output, 'inventory.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('Inventory ready: ' + join(output, 'inventory.json'));
    for (const { index, file } of unique.values()) {
      for (const row of file.declarations) {
        if (row.context === 'setup') { row.status = 'setup-not-renderable'; row.diagnostics = ['Setup/resource declaration; no standalone formula invocation.']; continue; }
        const started = performance.now();
        const result = await api.renderFormula(row.formula, index, row.context === 'environment');
        row.elapsedMs = Math.round(performance.now() - started);
        row.rendered = !!result.svg; row.diagnostics = result.diagnostics;
        row.svgSha256 = result.svg ? hash(result.svg) : null;
        row.status = row.shadowed ? 'shadowed-final-meaning-only' : !result.svg ? 'requires-tex-or-fix'
          : row.context === 'text' ? 'rendered-math-projection' : 'rendered';
        if (result.svg && !row.shadowed && row.usesScriptAlphabet && index.packages.some(pkg => pkg.name === 'mathrsfs')) {
          row.status = 'rendered-font-variant'; row.diagnostics = [...row.diagnostics, 'MathJax script alphabet rendered; exact mathrsfs font appearance is not certified.'];
        }
      }
    }
    for (const file of report.files) if (file.duplicateOf) {
      file.declarations = structuredClone(unique.get(file.hash).file.declarations);
      file.reusedIdenticalContentResults = true;
    }
    for (const file of report.files) {
      const current = hash(await readFile(file.path));
      if (current !== file.hash) throw new Error('Source changed during the audit: ' + file.path);
      file.sourceUnchanged = true;
      file.counts = file.declarations.reduce((counts, row) => { counts[row.status] = (counts[row.status] ?? 0) + 1; return counts; }, {});
      for (const row of file.declarations) delete row.macro;
    }
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    const flat = report.files.flatMap(file => file.declarations.map(row => ({ path: file.path, hash: file.hash, thirdParty: file.thirdParty, ...row })));
    await writeFile(join(output, 'commands.csv'), csv(flat, ['path', 'hash', 'thirdParty', 'id', 'name', 'kind', 'line', 'declarationType', 'context', 'effective', 'parserRecognized', 'parserSupported', 'status', 'formula', 'texBody', 'diagnostics', 'caseNote']));
    const summary = ['# Local macro audit', '', report.scope, '', `Files: ${report.files.length}; unique contents: ${unique.size}. All original fingerprints were rechecked unchanged.`, '',
      '| File | SHA-256 prefix | Declarations | Result counts |', '| --- | --- | ---: | --- |',
      ...report.files.map(file => `| ${file.path} | ${file.hash.slice(0, 12)} | ${file.declarations.length} | ${JSON.stringify(file.counts)} |`), '',
      'Each row records a representative invocation, not every possible argument. Environment aliases are paired; accents receive operands; text and drawing commands are classified separately. Earlier shadowed definitions are not claimed independently validated. Setup/resource declarations require the separate TeX preamble audit. A rendered SVG does not certify an external font’s exact appearance.', '',
      'A failed MathJax invocation alone does not show that the original TeX source is wrong. The separate native TeX audit distinguishes unsupported renderer features from missing standalone dependencies and source-level compilation errors.', '',
      ...[...unique.values()].flatMap(({ file }) => [
        '## ' + file.hash.slice(0, 12) + (file.thirdParty ? ' — third-party paper source' : ' — personal macro file'), '',
        '| MathJax limitation or diagnostic | Representative commands |', '| --- | --- |',
        ...failureSummary(file.declarations), '',
      ]),
      'Detailed results: commands.csv and report.json. Inventory for the independent local TeX runner: inventory.json.', ''];
    await writeFile(join(output, 'SUMMARY.md'), summary.join('\n'));
    console.log(JSON.stringify(report.files.map(({ path, hash, counts }) => ({ path, hash: hash.slice(0, 12), counts })), null, 2));
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
