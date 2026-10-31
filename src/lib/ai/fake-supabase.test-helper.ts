// Tiny in-memory PostgREST-ish client for route tests: select / insert /
// update with eq filters, order, limit, maybeSingle / single, and
// per-table forced failures. Embedded selects (`stage:pipeline_stages(...)`)
// are ignored — put the flat columns in the fixture rows.

export type Row = Record<string, unknown>;

export interface FakeDb {
  tables: Record<string, Row[]>;
  /** Table -> operation that must fail ('insert' | 'update' | 'select'). */
  fail: Record<string, string[]>;
  /** Every write, in order, for assertions. */
  writes: { table: string; op: 'insert' | 'update'; row: Row; match: Row }[];
}

export function makeFakeDb(tables: Record<string, Row[]> = {}): FakeDb {
  return { tables, fail: {}, writes: [] };
}

export function fakeSupabase(db: FakeDb) {
  return {
    from(table: string) {
      let op: 'select' | 'insert' | 'update' = 'select';
      let payload: Row = {};
      const filters: Row = {};
      let order: { col: string; asc: boolean } | null = null;
      let max = Infinity;

      const run = (): { data: Row[] | null; error: { message: string } | null } => {
        if (db.fail[table]?.includes(op)) return { data: null, error: { message: `forced ${op} failure on ${table}` } };
        const all = (db.tables[table] ??= []);
        if (op === 'insert') {
          const row = { id: `${table}-${all.length + 1}`, ...payload };
          all.push(row);
          db.writes.push({ table, op, row: payload, match: {} });
          return { data: [row], error: null };
        }
        let rows = all.filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
        if (op === 'update') {
          for (const r of rows) Object.assign(r, payload);
          db.writes.push({ table, op, row: payload, match: { ...filters } });
          return { data: rows.map((r) => ({ ...r })), error: null };
        }
        if (order) {
          const { col, asc } = order;
          rows = [...rows].sort((a, z) => String(a[col]).localeCompare(String(z[col])) * (asc ? 1 : -1));
        }
        return { data: rows.slice(0, max).map((r) => ({ ...r })), error: null };
      };

      const b = {
        select: () => b,
        insert: (row: Row) => {
          op = 'insert';
          payload = row;
          return b;
        },
        update: (row: Row) => {
          op = 'update';
          payload = row;
          return b;
        },
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return b;
        },
        order: (col: string, opts?: { ascending?: boolean }) => {
          order = { col, asc: opts?.ascending !== false };
          return b;
        },
        limit: (n: number) => {
          max = n;
          return b;
        },
        maybeSingle: async () => {
          const r = run();
          return { data: r.data?.[0] ?? null, error: r.error };
        },
        single: async () => {
          const r = run();
          return { data: r.data?.[0] ?? null, error: r.error ?? (r.data?.[0] ? null : { message: 'no row' }) };
        },
        then: (resolve: (v: ReturnType<typeof run>) => unknown) => resolve(run()),
      };
      return b;
    },
  };
}
