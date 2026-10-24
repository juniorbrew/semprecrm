// ============================================================
// i18n chunk planner. Shared by scripts/i18n-split.mjs (writes the files)
// and src/lib/i18n-chunks.test.ts (fails when they are stale or when a
// client entry reaches the full dictionary).
//
// The full dictionaries (src/lib/i18n.ts <- i18n-extra + i18n-dict/*) stay
// the source of truth. Each route group gets a generated chunk holding only
// the keys whose English text appears in the source files that group can
// reach (static + dynamic imports, plus the /api routes it fetches).
// ============================================================
import fs from 'node:fs';
import path from 'node:path';

export const FULL_DICT_FILES = [
  'src/lib/i18n.ts',
  'src/lib/i18n-extra.ts',
  'src/lib/i18n-dict/',
];
// Generated output must not feed its own input.
const NOT_SOURCE = [...FULL_DICT_FILES, 'src/lib/i18n-chunks/'];
const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];
const ENTRY_RE = /^(page|layout|error|loading|not-found|template)\.tsx$/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
export const rel = (root, p) => path.relative(root, p).split(path.sep).join('/');

function resolveImport(root, from, spec) {
  let base;
  if (spec.startsWith('@/')) base = path.join(root, 'src', spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
  else return null;
  const cands = [
    base,
    ...EXTS.map((e) => base + e),
    ...EXTS.map((e) => path.join(base, 'index' + e)),
  ];
  return cands.find((c) => fs.existsSync(c) && fs.statSync(c).isFile()) ?? null;
}

const IMPORT_RE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
const FETCH_RE = /['"`](\/api\/[A-Za-z0-9_\-/[\]${}.]*)/g;

function apiRoutes(root, literal) {
  // "/api/a/b/${id}/c" -> walk src/app/api matching literal or [param] dirs
  const parts = literal
    .replace(/^\/api\/?/, '')
    .split('/')
    .filter(Boolean);
  const out = [];
  const subdirs = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  const visit = (dir, i) => {
    if (!fs.existsSync(dir)) return;
    if (i >= parts.length) {
      const r = path.join(dir, 'route.ts');
      if (fs.existsSync(r)) out.push(r);
      return;
    }
    const seg = parts[i];
    if (!seg.includes('${')) visit(path.join(dir, seg), i + 1);
    for (const e of subdirs(dir))
      if (e.name.startsWith('[')) visit(path.join(dir, e.name), i + 1);
  };
  visit(path.join(root, 'src/app/api'), 0);
  return out;
}

export function makeGraph(root) {
  const cache = new Map();
  const read = (f) => {
    if (!cache.has(f)) cache.set(f, fs.readFileSync(f, 'utf8'));
    return cache.get(f);
  };
  const edgeCache = new Map();
  const edges = (f) => {
    if (edgeCache.has(f)) return edgeCache.get(f);
    // type-only imports are erased at build time and never ship
    const src = read(f).replace(/\bimport\s+type\b[^;'"]*?from\s*['"][^'"]+['"]/g, '');
    const imports = [];
    for (const m of src.matchAll(IMPORT_RE)) {
      const r = resolveImport(root, f, m[1]);
      if (r) imports.push(r);
    }
    const apis = [];
    for (const m of src.matchAll(FETCH_RE)) apis.push(...apiRoutes(root, m[1]));
    const e = { imports, apis };
    edgeCache.set(f, e);
    return e;
  };
  /** imports only (client graph) or imports + fetched API routes (text scope) */
  const closure = (entries, withApi) => {
    const seen = new Set();
    const stack = [...entries];
    while (stack.length) {
      const f = stack.pop();
      if (seen.has(f)) continue;
      seen.add(f);
      const e = edges(f);
      stack.push(...e.imports);
      if (withApi) stack.push(...e.apis);
    }
    return seen;
  };
  return { read, closure, edges };
}

export function defineGroups(root) {
  const app = path.join(root, 'src/app');
  const entriesIn = (dir) => walk(dir).filter((f) => ENTRY_RE.test(path.basename(f)));
  const groups = {
    root: [path.join(app, 'layout.tsx')],
    notfound: [path.join(app, 'not-found.tsx')],
    auth: [...entriesIn(path.join(app, '(auth)')), ...entriesIn(path.join(app, 'join'))],
    marketing: entriesIn(path.join(app, '(marketing)')),
    platform: entriesIn(path.join(app, 'platform')),
    shell: [path.join(app, '(dashboard)/layout.tsx')],
  };
  const dash = path.join(app, '(dashboard)');
  for (const e of fs.readdirSync(dash, { withFileTypes: true })) {
    if (e.isDirectory()) groups['d-' + e.name] = entriesIn(path.join(dash, e.name));
  }
  return groups;
}

// Normalise source so JSX text and escaped quotes can be matched as literals.
function normalise(src) {
  return src
    .replace(/\\(['"`])/g, '$1')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&mdash;/g, '—')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
}

// The key must sit between quote/backtick/JSX-tag/brace delimiters
// (whitespace around it tolerated): 'Save', "Save", >Save<, {`Save`}.
function hasLiteral(text, key) {
  let i = text.indexOf(key);
  while (i !== -1) {
    const before = text.slice(Math.max(0, i - 2), i);
    const after = text.slice(i + key.length, i + key.length + 2);
    if (/["'`>}]\s?$/.test(before) && /^\s?["'`<{]/.test(after)) return true;
    i = text.indexOf(key, i + 1);
  }
  return false;
}

export function planChunks(root, enToPt) {
  const graph = makeGraph(root);
  const groups = defineGroups(root);
  const textOf = new Map();
  const norm = (f) => {
    if (!textOf.has(f)) textOf.set(f, normalise(graph.read(f)));
    return textOf.get(f);
  };
  const keys = Object.keys(enToPt);
  const nkeys = new Map(keys.map((k) => [k, normalise(k)]));
  // Source written in Portuguese is translated back for en-US, so a key also
  // belongs where its pt-BR value appears as a literal.
  const nvals = new Map(keys.map((k) => [k, normalise(enToPt[k])]));
  const textsOf = (files) =>
    [...files]
      .filter((f) => !NOT_SOURCE.some((d) => rel(root, f).startsWith(d)))
      .filter((f) => !/\.test\.tsx?$/.test(f))
      .map(norm);
  const keysIn = (texts, keyList, strict) => {
    const hit = new Set();
    for (const k of keyList) {
      const nk = nkeys.get(k);
      if (texts.some((t) => t.includes(nk) && (!strict || hasLiteral(t, nk)))) hit.add(k);
      else if (strict && texts.some((t) => hasLiteral(t, nvals.get(k)))) hit.add(k);
    }
    return hit;
  };
  // `Enter the ${doc}` builds "Enter the CPF" at runtime: a template literal
  // whose static head is >= 8 chars claims every key with that head.
  const TEMPLATE_HEAD = /`([^`$]{8,})\$\{/g;
  const templateKeys = (texts) => {
    const heads = new Set();
    for (const t of texts) for (const m of t.matchAll(TEMPLATE_HEAD)) heads.add(m[1]);
    const hit = new Set();
    for (const k of keys) {
      const nk = nkeys.get(k);
      for (const h of heads) if (nk.startsWith(h)) hit.add(k);
    }
    return hit;
  };
  const texts = {};
  const sets = {};
  for (const [g, entries] of Object.entries(groups)) {
    texts[g] = textsOf(graph.closure(entries, true));
    sets[g] = keysIn(texts[g], keys, true);
    for (const k of templateKeys(texts[g])) sets[g].add(k);
  }
  // Second pass for keys no group matched as a whole literal (JSX text split
  // around elements, wrapped lines): a plain substring hit still places them.
  const strictUsed = new Set();
  for (const s of Object.values(sets)) for (const k of s) strictUsed.add(k);
  const rest = keys.filter((k) => !strictUsed.has(k));
  for (const g of Object.keys(sets)) for (const k of keysIn(texts[g], rest, false)) sets[g].add(k);
  const minus = (a, ...bs) => new Set([...a].filter((k) => !bs.some((b) => b.has(k))));
  const chunks = {};
  for (const g of Object.keys(sets)) {
    if (g === 'root') chunks[g] = sets[g];
    else if (g.startsWith('d-')) chunks[g] = minus(sets[g], sets.root, sets.shell);
    else chunks[g] = minus(sets[g], sets.root);
  }
  const used = new Set();
  for (const s of Object.values(chunks)) for (const k of s) used.add(k);
  // Keys no source file mentions (server-built or dead copy) ride with the
  // dashboard shell, the only place API messages surface.
  const unmatched = keys.filter((k) => !used.has(k));
  for (const k of unmatched) chunks.shell.add(k);
  return { groups, chunks, unmatched, keys, graph };
}

export function chunkFileName(name) {
  return `src/lib/i18n-chunks/${name}.tsx`;
}

export function renderChunk(name, keysSet, enToPt) {
  const body = [...keysSet]
    .sort()
    .map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(enToPt[k])},`)
    .join('\n');
  return `'use client';
// GENERATED by scripts/i18n-split.mjs. Do not edit; run \`npm run i18n:split\`.
// Route chunk "${name}": ${keysSet.size} entries for the runtime translator.
import { registerDict } from '@/lib/i18n-runtime';

registerDict({
${body}
});

export default function I18nChunk() {
  return null;
}
`;
}
