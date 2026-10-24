#!/usr/bin/env node
// Regenerates src/lib/i18n-chunks/*.tsx from the full dictionaries.
//   npm run i18n:split          write the files
//   npm run i18n:split -- --check   report stale files and exit 1 without writing
// CI runs the same comparison in src/lib/i18n-chunks.test.ts.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { chunkFileName, planChunks, renderChunk } from './i18n-split-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// Minimal TS loader: the dictionaries only use relative imports.
const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file).exports;
  const out = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  cache.set(file, mod);
  const req = (spec) => {
    if (!spec.startsWith('.')) return require(spec);
    const base = path.resolve(path.dirname(file), spec);
    const hit = [base + '.ts', path.join(base, 'index.ts')].find((c) => fs.existsSync(c));
    return load(hit);
  };
  new Function('exports', 'require', 'module', out)(mod.exports, req, mod);
  return mod.exports;
}

const { EN_TO_PT } = load(path.join(root, 'src/lib/i18n.ts'));
const plan = planChunks(root, EN_TO_PT);
const check = process.argv.includes('--check');
console.log(`${plan.unmatched.length} of ${plan.keys.length} keys match no source file (chunk "unmatched")`);
let stale = 0;
const wanted = new Set();
for (const [name, set] of Object.entries(plan.chunks)) {
  const file = path.join(root, chunkFileName(name));
  wanted.add(file);
  const text = renderChunk(name, set, EN_TO_PT);
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replaceAll(String.fromCharCode(13), '') : null;
  if (current === text) continue;
  stale++;
  if (!check) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}
const dir = path.join(root, 'src/lib/i18n-chunks');
if (fs.existsSync(dir))
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (!wanted.has(p)) {
      stale++;
      if (!check) fs.rmSync(p);
    }
  }
console.log(
  check
    ? stale ? `${stale} stale i18n chunk(s); run npm run i18n:split` : 'i18n chunks up to date'
    : `i18n chunks written (${stale} changed)`
);
if (check && stale) process.exit(1);
