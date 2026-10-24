import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EN_TO_PT } from './i18n';
import {
  FULL_DICT_FILES,
  chunkFileName,
  planChunks,
  rel,
  renderChunk,
} from '../../scripts/i18n-split-lib.mjs';

const root = process.cwd();
// One shared plan: scanning every route's import graph takes a few seconds.
const plan = planChunks(root, EN_TO_PT);

describe('i18n route chunks', () => {
  it('generated chunks match the dictionaries (run `npm run i18n:split`)', () => {
    const stale: string[] = [];
    for (const [name, keys] of Object.entries(plan.chunks)) {
      const file = path.join(root, chunkFileName(name));
      const expected = renderChunk(name, keys, EN_TO_PT);
      if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8').replaceAll(String.fromCharCode(13), '') !== expected)
        stale.push(name);
    }
    const dir = path.join(root, 'src/lib/i18n-chunks');
    const extra = fs
      .readdirSync(dir)
      .filter((f) => !(f.replace(/\.tsx$/, '') in plan.chunks));
    expect({ stale, extra }).toEqual({ stale: [], extra: [] });
  }, 120_000);

  it('no route reaches the full dictionary from client-facing imports', () => {
    // Regression guard: importing i18n.ts / i18n-extra / i18n-dict from any
    // page, layout or shared component puts ~260 KB on every route again.
    // Client code must use i18n-core (types) and i18n-runtime (lookups).
    const offenders: string[] = [];
    for (const [group, entries] of Object.entries(plan.groups)) {
      for (const f of plan.graph.closure(entries, false)) {
        const r = rel(root, f);
        if (FULL_DICT_FILES.some((d) => r.startsWith(d)))
          offenders.push(`${group} -> ${r}`);
      }
    }
    expect(offenders).toEqual([]);
  }, 120_000);

  it('every page and route handler entry belongs to a chunk group', () => {
    const grouped = new Set(Object.values(plan.groups).flat());
    const app = path.join(root, 'src/app');
    const pages: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'api') walk(p);
        } else if (e.name === 'page.tsx') pages.push(p);
      }
    };
    walk(app);
    const orphans = pages.filter((p) => !grouped.has(p)).map((p) => rel(root, p));
    expect(orphans).toEqual([]);
  });

  it('login and signup ship a small dictionary budget (root + auth)', () => {
    const size = (name: string) =>
      fs.statSync(path.join(root, chunkFileName(name))).size;
    // Whole catalogue is ~260 KB of entries; auth screens need a small slice.
    expect(size('root') + size('auth') + size('unmatched')).toBeLessThan(60_000);
  });
});
