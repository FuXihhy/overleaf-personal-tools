// Read-only audit of explicitly listed local macro files. TeX runs exclusively
// through the production native host's sandbox, never against original files.
// Usage: node scripts/audit-tex-macros.mjs --inventory artifacts/macro-audit/report.json
//        node scripts/audit-tex-macros.mjs --health-only --file /absolute/macros.sty
// For corrected representative inputs, --update-report merges only the tested
// declaration IDs into an existing report, retaining the separate rerun provenance.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, mkdir, rm, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const healthOnly = args.includes('--health-only');
const compiler = option('--compiler', 'pdflatex');
if (!['pdflatex', 'xelatex', 'lualatex'].includes(compiler)) throw new Error('Unsupported compiler.');
const outputPath = resolve(option('--output', 'artifacts/macro-audit/tex-report.json'));
const inventoryPath = resolve(option('--inventory', 'artifacts/macro-audit/report.json'));
const previousReport = args.includes('--update-report') ? JSON.parse(await readFile(outputPath, 'utf8')) : undefined;
if (previousReport && previousReport.compiler !== compiler) throw new Error('Cannot merge results from different compilers.');
const requestedFiles = args.flatMap((value, index) => value === '--file' ? [args[index + 1]] : []);
const input = requestedFiles.length ? { files: requestedFiles.map(path => ({ path, declarations: [] })) } : JSON.parse(await readFile(inventoryPath, 'utf8'));
if (!Array.isArray(input.files) || !input.files.length || input.files.length > 32) throw new Error('Expected 1–32 explicitly selected inventory files.');
const hash = value => createHash('sha256').update(value).digest('hex');
const work = await mkdtemp(join(tmpdir(), 'opt-tex-audit-'));
const started = new Date().toISOString();
const report = { schemaVersion: 1, started, compiler, healthOnly, inventoryPath: requestedFiles.length ? undefined : inventoryPath,
  method: 'Production document builder and sandboxed native host; unchanged source snapshots; representative invocations, not exhaustive argument combinations.',
  sourcePolicy: 'Originals are read only. No uploads or network operations. Full-file health is checked before any invocation.',
  files: [], variants: [], totals: {} };
const jobs = { started: 0, passed: 0, failed: 0 };

function classify(error) {
  error = error.replace(/\r?\n/g, '');
  if (/File [`']([^`']+\.(?:sty|cls|def|fd))['’] not found/i.test(error)) return 'missing-package';
  if (/font.*not (?:loadable|found)|Metric \(TFM\) file not found|mktexpk|mktextfm/i.test(error)) return 'missing-font';
  if (/Undefined control sequence/i.test(error)) return 'undefined-control-sequence';
  if (/already defined|already loaded/i.test(error)) return 'declaration-conflict';
  if (/Double subscript/i.test(error)) return 'double-subscript';
  if (/timeout|timed out|超时|超过.*秒/i.test(error)) return 'timeout';
  return 'tex-compilation-error';
}

async function runNative(document, id) {
  jobs.started++;
  const requestPath = join(work, id.replace(/[^A-Za-z0-9_-]/g, '_') + '.json');
  await writeFile(requestPath, JSON.stringify({ op: 'render', version: 1, id, compiler, document }), { mode: 0o600 });
  const python = 'import json,sys\nfrom native.host import render\ntry:\n r=render(json.load(open(sys.argv[1])))\n print(json.dumps({"ok":True,"elapsedMs":r.get("elapsedMs"),"diagnostics":r.get("diagnostics",[]),"pdfBytes":len(r.get("pdfBase64", ""))*3//4}))\nexcept Exception as error:\n print(json.dumps({"ok":False,"error":str(error)}))';
  const result = await new Promise(resolveJob => {
    const child = spawn('/usr/bin/python3', ['-c', python, requestPath], { cwd: repository, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', finished = false;
    const finish = result => { if (finished) return; finished = true; clearTimeout(timer); resolveJob(result); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ ok: false, error: 'Audit subprocess timed out after the native host deadline.' }); }, 25_000);
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 128_000) child.kill('SIGKILL'); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16_000); });
    child.on('error', error => finish({ ok: false, error: String(error) }));
    child.on('close', code => {
      try { finish(JSON.parse(stdout)); }
      catch { finish({ ok: false, error: 'Audit host process exited ' + code + ': ' + stderr + stdout.slice(-4000) }); }
    });
  });
  await rm(requestPath, { force: true });
  if (result.ok) jobs.passed++; else { jobs.failed++; result.category = classify(result.error); }
  return result;
}

function declarationBody(declaration) {
  if (typeof declaration.texBody === 'string' && declaration.texBody.trim()) return declaration.texBody;
  if (typeof declaration.formula !== 'string' || !declaration.formula.trim() || declaration.context === 'setup') return;
  return declaration.context === 'math' || !declaration.context ? '\\(\\displaystyle ' + declaration.formula + '\\)' : declaration.formula;
}

function rowFor(declaration, position) {
  return { declarationId: declaration.id ?? declaration.name + ':' + (declaration.offset ?? position), name: declaration.name, kind: declaration.kind,
    line: declaration.line, context: declaration.context, indexed: declaration.parserRecognized ?? declaration.indexed ?? declaration.inIndex,
    mathjaxParserSupported: declaration.parserSupported, declarationType: declaration.declarationType, caseNote: declaration.caseNote,
    invocation: declaration.formula ?? null, texBody: declarationBody(declaration) ?? null,
    status: 'not-tested', reason: '', diagnostics: [] };
}

async function flush() {
  let output = report;
  if (previousReport) {
    const mergeRows = (oldFile, newFile) => {
      if (!newFile) return oldFile;
      if (oldFile.hash !== newFile.hash) throw new Error('Source changed; a complete audit is required.');
      const replacements = new Map(newFile.declarations.map(row => [row.declarationId, row]));
      const declarations = oldFile.declarations.map(row => { const replacement = replacements.get(row.declarationId); replacements.delete(row.declarationId); return replacement ?? row; });
      return { ...oldFile, health: newFile.health, declarations: declarations.concat([...replacements.values()]) };
    };
    output = { ...previousReport, updated: new Date().toISOString(), finished: report.finished ?? previousReport.finished,
      files: previousReport.files.map(file => mergeRows(file, report.files.find(candidate => candidate.path === file.path))),
      variants: previousReport.variants.map(file => mergeRows(file, report.variants.find(candidate => candidate.hash === file.hash))),
      updates: [...(previousReport.updates ?? []), { started, finished: report.finished, inventoryPath, declarationIds: report.variants.flatMap(file => file.declarations.map(row => row.declarationId)) }],
    };
  }
  const rows = output.files.flatMap(file => file.declarations ?? []);
  const uniqueRows = output.variants.flatMap(file => file.declarations ?? []);
  const counts = records => records.reduce((result, row) => { result[row.status] = (result[row.status] ?? 0) + 1; return result; }, {});
  output.totals = { files: output.files.length, uniqueVariants: output.variants.length, declarationsAcrossFiles: rows.length,
    declarationsAcrossVariants: uniqueRows.length, statusesAcrossFiles: counts(rows), statusesAcrossVariants: counts(uniqueRows),
    jobs: Object.fromEntries(Object.keys(jobs).map(key => [key, jobs[key] + (previousReport?.totals?.jobs?.[key] ?? 0)])) };
  report.totals = output.totals;
  report.updated = new Date().toISOString();
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(output, null, 2) + '\n', { mode: 0o600 });
  const columns = ['path', 'hash', 'thirdParty', 'declarationId', 'name', 'kind', 'line', 'context', 'indexed', 'mathjaxParserSupported', 'status', 'reason', 'invocation', 'diagnostics'];
  const quote = value => '"' + String(value ?? '').replaceAll('"', '""') + '"';
  const csv = [columns.join(','), ...output.files.flatMap(file => (file.declarations ?? []).map(row => columns.map(key => quote(key === 'diagnostics' ? row.diagnostics.join(' | ') : (file[key] ?? row[key]))).join(',')))].join('\n') + '\n';
  await writeFile(outputPath.replace(/\.json$/i, '') + '.csv', csv, { mode: 0o600 });
}

try {
  await build({ stdin: { contents: `export {buildCloudDocument} from './src/preview/cloud-document'; export {DEFAULT_SETTINGS} from './src/core/types'; export {parseTex} from './src/core/parser';`, resolveDir: repository }, outfile: join(work, 'builder.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  const { buildCloudDocument, DEFAULT_SETTINGS, parseTex } = await import(pathToFileURL(join(work, 'builder.mjs')));
  const byHash = new Map();
  for (const file of input.files) {
    if (!file || typeof file.path !== 'string' || !isAbsolute(file.path)) throw new Error('Inventory requires absolute source paths.');
    const data = await readFile(file.path);
    if (data.length > 2 * 1024 * 1024) throw new Error('Source exceeds native host size limit: ' + file.path);
    const digest = hash(data);
    if (file.hash && !digest.startsWith(file.hash)) throw new Error('Source changed since inventory: ' + file.path);
    const record = { ...file, hash: digest, text: data.toString('utf8') };
    if (byHash.has(digest)) byHash.get(digest).aliases.push(record);
    else byHash.set(digest, { source: record, aliases: [record] });
  }
  for (const [digest, group] of byHash) {
    const { source } = group;
    const sources = new Map([['main.tex', '\\documentclass{article}\n\\usepackage{macros}\n\\begin{document}UNUSED ORIGINAL BODY\\end{document}'], ['macros.sty', source.text]]);
    const sourceDirectory = await realpath(dirname(source.path));
    const pending = ['macros.sty'];
    const dependencyPaths = [];
    while (pending.length) {
      const path = pending.shift();
      for (const event of parseTex(sources.get(path), path).events) {
        if (event.type === 'macro') continue;
        const raw = event.type === 'package' ? event.package.name : event.path;
        if (!/^[A-Za-z0-9._ /-]+$/.test(raw) || raw.split('/').includes('..') || isAbsolute(raw)) continue;
        const target = /\.[^/]+$/.test(raw) ? raw : raw + (event.type === 'package' ? '.sty' : '.tex');
        if (sources.has(target)) continue;
        const absolute = resolve(sourceDirectory, target);
        if (relative(sourceDirectory, absolute).startsWith('..')) continue;
        try {
          const info = await stat(absolute);
          if (!info.isFile() || info.size > 2 * 1024 * 1024 || sources.size >= 100) continue;
          if (relative(sourceDirectory, await realpath(absolute)).startsWith('..')) continue;
          const content = await readFile(absolute, 'utf8');
          sources.set(target, content); pending.push(target); dependencyPaths.push(absolute);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    const documentFor = async formula => buildCloudDocument({ files: [...sources.keys()].map(path => ({ id: path, path, kind: 'doc' })), rootPath: 'main.tex',
      readFile: async file => sources.get(file.path), settings: { ...DEFAULT_SETTINGS, extraFilesMode: 'none' }, formula, display: false });
    const health = await runNative(await documentFor('x'), 'health-' + digest.slice(0, 12));
    const variant = { hash: digest, representativePath: source.path, aliases: group.aliases.map(file => file.path), thirdParty: !!source.thirdParty,
      dependencyPaths, health, declarations: source.declarations.map(rowFor) };
    report.variants.push(variant);
    console.log(JSON.stringify({ phase: 'health', hash: digest.slice(0, 12), ok: health.ok, category: health.category, elapsedMs: health.elapsedMs }));
    if (!health.ok) {
      for (const row of variant.declarations) { row.status = 'blocked-preamble'; row.reason = 'The unchanged macro file failed its standalone article preamble health check; this is not an individual-command result.'; row.diagnostics = [health.error]; }
    } else if (!healthOnly) {
      const eligible = [];
      for (const [position, declaration] of source.declarations.entries()) {
        const row = variant.declarations[position];
        if (declaration.shadowed === true || declaration.effective === false) {
          row.status = 'shadowed'; row.reason = 'A later definition replaces this declaration; calling its name would exercise the final definition.';
        } else if (row.context === 'setup') {
          row.status = 'preamble-only'; row.reason = 'Declaration loaded successfully in the full-file health check; this row has no standalone command invocation.';
          row.diagnostics = health.diagnostics ?? [];
        } else if (!row.texBody) {
          row.reason = declaration.skipReason ?? 'No representative invocation supplied by the inventory.';
        } else eligible.push(row);
      }
      let batchNumber = 0;
      async function testBatch(rows) {
        const id = digest.slice(0, 12) + '-case-' + (++batchNumber);
        // A minipage provides a single supported document-body environment to the
        // production builder. Each case is locally grouped to avoid state leakage.
        const body = '\\begin{minipage}{0.92\\textwidth}\n' + rows.map(row => '{\n' + row.texBody + '\n}\\par\n').join('\n') + '\\end{minipage}';
        let result;
        try { result = await runNative(await documentFor(body), id); }
        catch (error) { result = { ok: false, error: String(error), category: 'document-builder-error' }; }
        if (result.ok) {
          const unresolved = (result.diagnostics ?? []).some(message => /undefined (?:references|citations)|(?:Reference|Citation).+undefined|Missing character:|Font shape.+(?:undefined|not available)/i.test(message));
          if (unresolved && rows.length > 1) {
            const middle = Math.ceil(rows.length / 2);
            await testBatch(rows.slice(0, middle)); await testBatch(rows.slice(middle));
            return;
          }
          for (const row of rows) { row.status = unresolved ? 'pass-with-warning' : 'pass'; row.reason = rows.length > 1 ? 'Representative invocation compiled in a successful grouped check.' : 'Representative invocation compiled successfully.'; row.diagnostics = result.diagnostics ?? []; }
        } else if (rows.length > 1) {
          const middle = Math.ceil(rows.length / 2);
          await testBatch(rows.slice(0, middle)); await testBatch(rows.slice(middle));
        } else {
          rows[0].status = 'failure'; rows[0].reason = result.category ?? classify(result.error); rows[0].diagnostics = [result.error];
        }
      }
      const batches = [];
      for (let position = 0; position < eligible.length; position += 8) batches.push(eligible.slice(position, position + 8));
      let next = 0, completed = 0;
      const worker = async () => { while (next < batches.length) { const batch = batches[next++]; await testBatch(batch); completed++; console.log(JSON.stringify({ phase: 'cases', hash: digest.slice(0, 12), batches: completed, totalBatches: batches.length })); } };
      await Promise.all([worker(), worker()]);
    }
    for (const alias of group.aliases) report.files.push({ path: alias.path, hash: digest, bytes: Buffer.byteLength(alias.text), thirdParty: !!alias.thirdParty,
      reusedFrom: alias.path === source.path ? undefined : source.path, health, declarations: variant.declarations.map(row => ({ ...row })) });
    await flush();
  }
  report.finished = new Date().toISOString();
  await flush();
  console.log(JSON.stringify({ output: outputPath, totals: report.totals }));
} finally { await rm(work, { recursive: true, force: true }); }
