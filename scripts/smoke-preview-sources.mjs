// Real TeX checks for the preview-source controls, using artificial text only.
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const work = await mkdtemp(join(tmpdir(), 'opt-source-smoke-'));
try {
  await build({ stdin: { contents: `export {buildCloudDocument} from './src/preview/cloud-document'; export {DEFAULT_SETTINGS} from './src/core/types';`, resolveDir: resolve('.') }, outfile: join(work,'builder.mjs'), bundle: true, platform: 'node', format: 'esm' });
  const { buildCloudDocument, DEFAULT_SETTINGS } = await import(pathToFileURL(join(work,'builder.mjs')));
  const sources = {
    'main.tex': String.raw`\documentclass{article}
\usepackage{amsmath,amssymb,physics}
\input{defs/extra}
\begin{document}\undefinedOriginalBody\end{document}`,
    'defs/extra.tex': String.raw`\def\choice{A}\newcommand{\onlyExtra}{a}`,
    'macros.sty': String.raw`\ProvidesPackage{macros}\def\choice{B}\newcommand{\bR}{\ensuremath{\mathbb{R}}}`,
  };
  const order = ['package:amsmath','package:amssymb','package:physics','file:defs/extra.tex','file:macros.sty'];
  const select = (ids, disabled = []) => ids.map(id => ({id,enabled:!disabled.includes(id)}));
  const cases = [
    {name:'unchanged',expected:'B'},
    {name:'saved-natural-order',expected:'B',selection:select(order)},
    {name:'disabled-macro-file',expected:'A',selection:select(order,['file:macros.sty'])},
    {name:'reordered-files',expected:'A',selection:select([...order.slice(0,3),'file:macros.sty','file:defs/extra.tex'])},
    {name:'disabled-package',expected:'B',selection:select(order,['package:physics']),extra:String.raw`\ifdefined\pdv\errmessage{Disabled physics was loaded}\fi`},
    {name:'enabled-wrapper',expected:'B',selection:select(order),extra:String.raw`+\bR+\pdv{f}{x}`},
    {name:'invalid-dependency-order',expected:'B',selection:select(['package:physics','package:amsmath','package:amssymb',...order.slice(3)]),failure:'already loaded'},
    {name:'disabled-local-retains-child',expected:'C',selection:select(['file:local.sty','package:amsmath','file:child.tex'],['file:local.sty']),extra:String.raw`+\dfrac{1}{2}\ifdefined\hidden\errmessage{Disabled local definition was loaded}\fi`,sources:{
      'main.tex':String.raw`\documentclass{article}\usepackage[foo]{local}\begin{document}\undefinedOriginalBody\end{document}`,
      'local.sty':String.raw`\ProvidesPackage{local}\RequirePackage{amsmath}\input{child}\def\hidden{H}`,
      'child.tex':String.raw`\def\choice{C}`,
    }},
    {name:'interleaved-noop',expected:'C',selection:select(['file:main.tex','file:extra.tex']),sources:{
      'main.tex':String.raw`\documentclass{article}\def\choice{A}\input{extra}\def\choice{C}\begin{document}\undefinedOriginalBody\end{document}`,
      'extra.tex':String.raw`\def\choice{B}`,
    }},
    {name:'interleaved-disabled',expected:'C',selection:select(['file:main.tex','file:extra.tex'],['file:extra.tex']),sources:{
      'main.tex':String.raw`\documentclass{article}\def\choice{A}\input{extra}\def\choice{C}\begin{document}\undefinedOriginalBody\end{document}`,
      'extra.tex':String.raw`\def\choice{B}`,
    }},
  ];
  for (const entry of cases) {
    const project = entry.sources ?? sources;
    const document = await buildCloudDocument({
      files:Object.keys(project).map(path=>({id:path,path,kind:'doc'})),rootPath:'main.tex',readFile:async file=>project[file.path],
      settings:{...DEFAULT_SETTINGS,previewSources:entry.selection},
      formula:`\\if ${entry.expected}\\choice\\else\\errmessage{Wrong source order}\\fi \\choice${entry.extra??''}`,display:true,
    });
    const requestPath=join(work,entry.name+'.json');
    await writeFile(requestPath,JSON.stringify({version:1,op:'render',id:entry.name,compiler:'pdflatex',document}));
    const result=JSON.parse(execFileSync('/usr/bin/python3',['-c','import json,sys\nfrom native.host import render\ntry:\n print(json.dumps(render(json.load(open(sys.argv[1])))))\nexcept Exception as error:\n print(json.dumps({"error":str(error)}))',requestPath],{cwd:resolve('.'),timeout:25000,maxBuffer:1024*1024,encoding:'utf8'}));
    if(entry.failure){
      if(result.pdfBase64 || !result.error?.replace(/\s+/g,' ').includes(entry.failure))throw new Error(entry.name+': expected visible dependency-order failure, got '+JSON.stringify(result));
      console.log(JSON.stringify({case:entry.name,ok:true,expectedFailure:entry.failure}));continue;
    }
    if(!result.pdfBase64)throw new Error(entry.name+': '+JSON.stringify(result));
    console.log(JSON.stringify({case:entry.name,ok:true,elapsedMs:result.elapsedMs,diagnostics:result.diagnostics}));
  }
} finally { await rm(work,{recursive:true,force:true}); }
