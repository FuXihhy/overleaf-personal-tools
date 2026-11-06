#!/usr/bin/env node
// Synthetic CPU measurements only: no Overleaf session, personal sources,
// browser automation, network, production build output or native TeX jobs.
// node scripts/benchmark-preview.mjs --out artifacts/preview-performance
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { cpus, platform, release, arch, tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const hash = value => createHash('sha256').update(value).digest('hex');
const round = value => Math.round(value * 1000) / 1000;
const empty = () => ({ macros: [], packages: [], commands: [], files: [], diagnostics: [] });
const firstFormula = String.raw`x^2+\alpha=\frac{a+b}{c}`;

function statistics(samples) {
  assert(samples.length > 0);
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return { samples: samples.length, medianMs: round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2),
    p95Ms: round(sorted[Math.ceil(sorted.length * .95) - 1]), minMs: round(sorted[0]), maxMs: round(sorted.at(-1)) };
}

function letters(index) {
  let result = '';
  do { result = String.fromCharCode(65 + index % 26) + result; index = Math.floor(index / 26) - 1; } while (index >= 0);
  return result;
}

function syntheticProject(count) {
  const sources = new Map();
  const pieces = 4;
  const body = Array.from({ length: count }, (_, index) => `\\newcommand{\\Macro${letters(index)}}[1]{\\frac{#1+${index + 1}}{1+#1^2}}`);
  sources.set('main.tex', '\\documentclass{article}\n\\usepackage{amsmath,physics}\n' +
    Array.from({ length: pieces }, (_, index) => `\\input{parts/part${index}.tex}`).join('\n') +
    '\n\\begin{document}\\(x^2+y^2\\)\\end{document}');
  for (let index = 0; index < pieces; index++) sources.set(`parts/part${index}.tex`, body.slice(Math.floor(index * count / pieces), Math.floor((index + 1) * count / pieces)).join('\n'));
  return { sources, count, files: [...sources.keys()].map(path => ({ id: path, path, kind: 'doc' })),
    characters: [...sources.values()].reduce((sum, text) => sum + text.length, 0), macroSource: body.join('\n') };
}

async function timed(operation) {
  const start = performance.now(); const value = await operation();
  return { ms: performance.now() - start, value };
}

async function worker() {
  const imported = await timed(() => import(pathToFileURL(option('--renderer')).href));
  const render = imported.value.renderFormula;
  const first = await timed(() => render(firstFormula, empty(), false, { tolerant: true }));
  assert(first.value.svg && !first.value.diagnostics.length, 'Cold render must succeed.');
  const result = { importMs: imported.ms, firstRenderMs: first.ms, firstSvgCharacters: first.value.svg.length, warm: [], indexing: [], parsing: [] };
  const iterations = Number(option('--iterations', '0'));
  if (!iterations) return result;
  const core = await import(pathToFileURL(option('--core')).href);
  const projects = [syntheticProject(100), syntheticProject(400)];
  const indexFor = async fixture => core.enrichIndex(await core.buildProjectIndex({ files: fixture.files, rootPath: 'main.tex',
    settings: { ...core.DEFAULT_SETTINGS, extraFilesMode: 'none' }, readFile: async file => fixture.sources.get(file.path) }));
  for (const fixture of projects) {
    fixture.index = await indexFor(fixture);
    assert.equal(fixture.index.macros.length, fixture.count, 'All synthetic declarations must actually be indexed.');
    assert.equal(fixture.index.diagnostics.filter(item => item.level === 'error').length, 0);
  }
  const physics = { ...empty(), packages: [{ name: 'physics', options: [], source: 'main.tex' }] };
  const fixtures = [
    { name: 'typical', tex: firstFormula, index: empty() },
    { name: 'integral', tex: String.raw`\int_0^\infty e^{-x^2}\,dx=\frac{\sqrt\pi}{2}`, index: empty() },
    { name: 'unknown-fragments', tex: String.raw`\frac{x+\missingAlpha}{1+\missingBeta}+\sin x+\missingAlpha`, index: empty(), unresolved: ['missingAlpha', 'missingBeta'] },
    { name: 'incomplete-braces', tex: String.raw`\frac{x+\alpha}{`, index: empty(), fallback: true },
    { name: 'physics', tex: String.raw`\pdv[2]{f}{x}+\qty(\frac{a}{b})+\bra{\psi}\ket{\phi}`, index: physics },
    { name: 'physics-matrix-12x12', tex: '\\mqty(' + Array.from({ length: 12 }, (_, row) => Array.from({ length: 12 }, (_, column) => String((row + column) % 10)).join('&')).join('\\\\') + ')', index: physics },
    ...projects.map(fixture => ({ name: `custom-macros-${fixture.count}-six-reachable`,
      tex: Array.from({ length: 6 }, (_, index) => `\\Macro${letters(index)}{x}`).join('+'), index: fixture.index,
      indexedMacros: fixture.count, reachableMacros: 6 })),
    { name: 'custom-macros-400-forty-reachable', tex: Array.from({ length: 40 }, (_, index) => `\\Macro${letters(index)}{x}`).join('+'),
      index: projects[1].index, indexedMacros: 400, reachableMacros: 40 },
  ];
  const check = (fixture, output) => {
    if (fixture.fallback) { assert.equal(output.fallbackText, fixture.tex); assert.equal(output.svg, ''); }
    else {
      assert(output.svg.startsWith('<svg'), fixture.name + ' must render, not benchmark an error fast path.');
      assert.deepEqual([...output.unresolvedCommands].sort(), [...(fixture.unresolved ?? [])].sort());
      if (!fixture.unresolved) assert.deepEqual(output.diagnostics, []);
    }
  };
  for (const fixture of fixtures) {
    // Warm the fixture once. Each measured call still creates a fresh MathJax
    // TeX/document context, exactly as the production renderer does.
    check(fixture, await render(fixture.tex, fixture.index, false, { tolerant: true }));
    const samples = []; let output;
    for (let i = 0; i < iterations; i++) {
      const run = await timed(() => render(fixture.tex, fixture.index, false, { tolerant: true }));
      check(fixture, run.value); output = run.value; samples.push(run.ms);
    }
    result.warm.push({ name: fixture.name, formula: fixture.tex, formulaCharacters: fixture.tex.length,
      indexedMacros: fixture.indexedMacros ?? 0, reachableMacros: fixture.reachableMacros ?? 0,
      svgCharacters: output.svg.length, outcome: fixture.fallback ? 'plain-text-draft' : fixture.unresolved ? 'svg-with-red-commands' : 'svg',
      ...statistics(samples), rawMs: samples.map(round) });
  }
  for (const fixture of projects) {
    const samples = [];
    for (let i = 0; i < iterations; i++) {
      const run = await timed(() => indexFor(fixture));
      assert.equal(run.value.macros.length, fixture.count); samples.push(run.ms);
    }
    result.indexing.push({ name: `project-${fixture.count}-macros`, files: fixture.files.length, indexedMacros: fixture.count,
      characters: fixture.characters, readPolicy: 'immediate in-memory Promise; no filesystem or Overleaf transport latency',
      ...statistics(samples), rawMs: samples.map(round) });
    const parseSamples = [];
    for (let i = 0; i < iterations; i++) {
      const run = await timed(() => JSON.stringify(core.parseTex(fixture.macroSource, 'synthetic.sty'), (key, value) => key === 'offset' ? undefined : value));
      assert(run.value.length > fixture.macroSource.length); parseSamples.push(run.ms);
    }
    result.parsing.push({ name: `parse-and-declaration-signature-${fixture.count}`, characters: fixture.macroSource.length,
      ...statistics(parseSamples), rawMs: parseSamples.map(round) });
  }
  return result;
}

function runWorker(renderer, core, iterations) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [script, '--worker', '--renderer', renderer, '--core', core, '--iterations', String(iterations)],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Benchmark worker exceeded 60 seconds.')); }, 60_000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('Benchmark worker failed: ' + stderr));
      try { resolveRun(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
  });
}

async function main() {
  const iterations = Number(option('--iterations', '40'));
  const coldSamples = Number(option('--cold-samples', '5'));
  if (!Number.isInteger(iterations) || iterations < 5 || iterations > 500 || !Number.isInteger(coldSamples) || coldSamples < 3 || coldSamples > 20) throw new Error('Use 5–500 iterations and 3–20 cold samples.');
  const output = resolve(option('--out', join(root, 'artifacts/preview-performance')));
  const temporary = await mkdtemp(join(tmpdir(), 'opt-preview-benchmark-'));
  try {
    const renderer = join(temporary, 'renderer.mjs'); const core = join(temporary, 'core.mjs');
    const buildOptions = { bundle: true, format: 'esm', target: 'chrome111', minify: true, legalComments: 'linked', sourcemap: true, logLevel: 'silent' };
    // Match scripts/build.mjs's renderer settings; keep the production dist/
    // untouched. Only the output basename differs for Node's ESM loader.
    await build({ ...buildOptions, entryPoints: [join(root, 'src/preview/render.ts')], outfile: renderer });
    await build({ ...buildOptions, stdin: { contents: `export {buildProjectIndex} from './src/core/project-index'; export {parseTex} from './src/core/parser'; export {enrichIndex} from './src/packages'; export {DEFAULT_SETTINGS} from './src/core/types';`, resolveDir: root }, outfile: core });
    const runs = [];
    for (let i = 0; i < coldSamples; i++) {
      runs.push(await runWorker(renderer, core, i === 0 ? iterations : 0));
      console.log(`Fresh-process sample ${i + 1}/${coldSamples} complete.`);
    }
    const content = await readFile(join(root, 'src/content.ts'), 'utf8');
    const bridge = await readFile(join(root, 'src/overleaf/editor-bridge.ts'), 'utf8');
    const sources = ['src/preview/render.ts', 'src/core/project-index.ts', 'src/core/parser.ts', 'src/core/types.ts', 'src/packages/index.ts', 'src/content.ts', 'src/overleaf/editor-bridge.ts'];
    const sourceHashes = Object.fromEntries(await Promise.all(sources.map(async path => [path, hash(await readFile(join(root, path)))])));
    const rendererBytes = await readFile(renderer);
    const report = {
      schemaVersion: 1, generatedAt: new Date().toISOString(), runtime: { kind: 'Node.js', version: process.version, platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length },
      scope: 'Synthetic inputs only. Production-equivalent minified renderer bundle imported by Node, not a Chrome browser latency test.',
      method: { iterations, coldSamples, percentile: 'nearest-rank P95; median averages the middle pair for even sample counts',
        freshProcess: 'Fresh JS module cache each sample; OS file cache may be warm. Node process launch is excluded.',
        warm: 'One unmeasured warmup per fixture; each measured call includes a new TeX context and SVG serialization.',
        exclusions: ['Chrome extension/module loading pipeline', 'editor event delivery and DOM layout', 'browser frame scheduling', 'Overleaf source reads', 'local/cloud TeX compilation', 'PDF rendering', 'content preview-cache hits'],
        loadCaveat: 'Shared host load is uncontrolled; P95 with five cold samples is the maximum, not a stable population tail estimate.' },
      bundle: { bytes: rendererBytes.length, sha256: hash(rendererBytes), buildOptions, output: 'temporary renderer.mjs; production dist unchanged' }, sourceHashes,
      cold: { import: statistics(runs.map(run => run.importMs)), firstRender: statistics(runs.map(run => run.firstRenderMs)),
        importPlusFirstRender: statistics(runs.map(run => run.importMs + run.firstRenderMs)),
        formula: firstFormula, raw: runs.map(run => ({ importMs: round(run.importMs), firstRenderMs: round(run.firstRenderMs) })) },
      warm: runs[0].warm, indexing: runs[0].indexing, parsing: runs[0].parsing,
      scheduling: { category: 'Intentional waits read from current source; excluded from timings above',
        draft: /previewFrame=requestAnimationFrame/.test(content) ? 'requestAnimationFrame; no fixed typing debounce' : 'Check current source',
        priorDraftDebounceMs: { value: 120, status: 'historical; removed when current requestAnimationFrame scheduling was introduced' },
        texDebounceMs: /renderTex\(\),650/.test(content) ? 650 : null,
        documentPublishDebounceMs: /\}, 450\)/.test(bridge) ? 450 : null,
        declarationRebuildDebounceMs: /rebuild\(\),900/.test(content) ? 900 : null,
        note: '450ms document publish + 900ms rebuild can add about 1350ms after edits to declarations. Ordinary formula edits do not rebuild an unchanged declaration signature. TeX 650ms is a separate asynchronous path; no sum here is an end-to-end browser measurement.' },
    };
    await mkdir(output, { recursive: true });
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    const table = values => values.map(row => `| ${row.name} | ${row.medianMs} | ${row.p95Ms} |`).join('\n');
    const summary = `# 公式预览性能测量\n\n本报告只使用合成内容。测量的是与生产配置一致的压缩 bundle 在 **Node ${process.version}** 中的计算耗时，不是 Chrome 中的端到端延迟。未读取个人宏文件，也未调用本机或云端 TeX。\n\n首次 import：中位数 ${report.cold.import.medianMs} ms，P95 ${report.cold.import.p95Ms} ms；首次渲染：中位数 ${report.cold.firstRender.medianMs} ms，P95 ${report.cold.firstRender.p95Ms} ms。采用 ${coldSamples} 个新进程，操作系统文件缓存可能已热；进程启动不计时。\n\n## 已加载后的宽容渲染\n\n每项 ${iterations} 次，每次仍创建新的 TeX 上下文。\n\n| 合成场景 | 中位数 ms | P95 ms |\n| --- | ---: | ---: |\n${table(report.warm)}\n\n## 索引与声明签名\n\n文件读取为内存中的即时 Promise，不含 Overleaf 传输耗时。\n\n| 合成场景 | 中位数 ms | P95 ms |\n| --- | ---: | ---: |\n${table([...report.indexing, ...report.parsing])}\n\n## 人为等待与测量边界\n\n当前草稿按 requestAnimationFrame 调度，旧 120 ms 防抖已移除。TeX 编译仍等待 650 ms；文档快照发布等待 450 ms，声明变化后的重建再等待 900 ms。后两项在相应路径上可能累计约 1350 ms，普通公式编辑不会触发未变化声明的整项目重建。这些等待均未混入上方计算耗时。\n\nP95 使用 nearest-rank；只有 ${coldSamples} 个冷启动样本时，P95 是样本最大值。主机并发负载未隔离。结果不包含浏览器加载、DOM 布局、帧调度、云端通信、TeX/PDF 耗时或预览缓存命中，不能据此承诺真实输入到屏幕的延迟。详见 report.json 的原始样本、源码和 bundle 指纹。\n`;
    await writeFile(join(output, 'SUMMARY.md'), summary);
    console.log('Report: ' + join(output, 'report.json'));
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (args.includes('--worker')) worker().then(result => process.stdout.write(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1; });
else main().catch(error => { console.error(error); process.exitCode = 1; });
