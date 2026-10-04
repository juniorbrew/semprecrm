// In-memory PostgREST-ish client for the broadcast audience tests (not a
// test file itself). Reads honour eq / neq / ilike / in, multi-column
// order, range and the server's max_rows cap; every IN-list size and
// every write is logged so tests can assert "no writes" and "small URLs".
// `fail` makes reads of that table return a PostgREST error.

import type { SupabaseClient } from '@supabase/supabase-js';
import { MAX_ROWS } from './audience';

type Row = Record<string, unknown>;

export function makeAudienceDb(tables: Record<string, Row[]>, fail: string[] = []) {
  const log = { inSizes: [] as number[], writes: [] as string[], ranges: [] as string[] };
  const db = {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: 'u-1' } } } }),
    },
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = [];
      const orders: string[] = [];
      let range: [number, number] | null = null;
      let write = false;

      function run() {
        if (write) return { data: [], error: null };
        if (fail.includes(table)) return { data: null, error: { message: `${table} read failed` } };
        let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        if (orders.length) {
          rows = [...rows].sort((a, z) => {
            for (const c of orders) {
              const d = String(a[c] ?? '').localeCompare(String(z[c] ?? ''));
              if (d) return d;
            }
            return 0;
          });
        }
        if (range) rows = rows.slice(range[0], range[1] + 1);
        return { data: rows.slice(0, MAX_ROWS).map((r) => ({ ...r })), error: null };
      }

      const recordWrite = (kind: string) => () => {
        write = true;
        log.writes.push(`${kind}:${table}`);
        return b;
      };
      const b = {
        select: () => b,
        insert: recordWrite('insert'),
        update: recordWrite('update'),
        upsert: recordWrite('upsert'),
        delete: recordWrite('delete'),
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
        neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), b),
        ilike: (c: string, p: string) => {
          const needle = p.replace(/%/g, '').toLowerCase();
          filters.push((r) => String(r[c] ?? '').toLowerCase().includes(needle));
          return b;
        },
        in: (c: string, vs: unknown[]) => {
          log.inSizes.push(vs.length);
          filters.push((r) => vs.includes(r[c]));
          return b;
        },
        order: (c: string) => (orders.push(c), b),
        range: (from: number, to: number) => {
          range = [from, to];
          log.ranges.push(`${table}:${from}-${to}`);
          return b;
        },
        single: async () => ({ data: null, error: { message: 'not supported' } }),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
      };
      return b;
    },
  };
  return { db: db as unknown as SupabaseClient, log };
}
