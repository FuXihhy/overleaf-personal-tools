// Synthetic end-to-end document-builder -> sandboxed native TeX smoke test.
// No host installation, browser registration, or user project access.
import { build } from 'esbuild';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const work=await mkdtemp(join(tmpdir(),'opt-smoke-'));
try {
  await build({entryPoints:['src/preview/cloud-document.ts'],outfile:join(work,'document.mjs'),bundle:true,platform:'node',format:'esm'});
  const {buildCloudDocument}=await import(pathToFileURL(join(work,'document.mjs')));
  const sources={
    'main.tex':String.raw`\documentclass{article}
\usepackage{amsmath,physics}
\input{macros.sty}
\begin{document}
This body must never be compiled: \undefinedBodyCommand
\end{document}`,
    'macros.sty':String.raw`\newcommand{\projectOperator}{\operatorname{Spec}}
\NewDocumentCommand{\flexible}{s m}{\IfBooleanTF{#1}{#2^2}{#2}}`,
  };
  const document=await buildCloudDocument({files:Object.keys(sources).map(path=>({id:path,path,kind:'doc'})),rootPath:'main.tex',readFile:async file=>sources[file.path],settings:{extraFilesMode:'auto',autoFileName:'macros.sty',extraFiles:[]},formula:String.raw`\projectOperator(R)\quad\pdv{f}{x}+\flexible*{z}`,display:true});
  const request={version:1,op:'render',id:'synthetic-smoke',compiler:'pdflatex',document};
  await writeFile(join(work,'request.json'),JSON.stringify(request));
  const output=execFileSync('/usr/bin/python3',['-c',
    'import json,sys; from native.host import render; print(json.dumps(render(json.load(open(sys.argv[1])))))',
    join(work,'request.json')],{cwd:resolve('.'),timeout:25000,maxBuffer:1024*1024,encoding:'utf8'});
  const result=JSON.parse(output);
  if(!result.pdfBase64)throw new Error(JSON.stringify(result));
  await mkdir('dev/generated',{recursive:true});
  await writeFile('dev/generated/formula.pdf',Buffer.from(result.pdfBase64,'base64'));
  console.log(JSON.stringify({ok:true,elapsedMs:result.elapsedMs,diagnostics:result.diagnostics,pdf:'dev/generated/formula.pdf'}));
} finally {await rm(work,{recursive:true,force:true});}
