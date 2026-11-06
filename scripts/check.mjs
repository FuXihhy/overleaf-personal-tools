import { execFileSync } from 'node:child_process';
const checks = [
  ['node_modules/typescript/bin/tsc','--noEmit'],
  ['node_modules/vitest/vitest.mjs','run'],
  ['scripts/build.mjs'],
];
for(const args of checks)execFileSync(process.execPath,args,{stdio:'inherit'});
