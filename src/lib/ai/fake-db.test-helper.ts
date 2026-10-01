// In-memory PostgREST-ish client for AI route tests (not a test file
// itself). Supports the calls the AI routes make: select / insert /
// update / delete with eq / neq / in filters, order, limit, head
// counts, maybeSingle / single. RLS is NOT simulated — routes must
// filter by account themselves, which is what the tests check.

type Row = Record<string, unknown>;

export function makeFakeDb(tables: Record<string, Row[]>, onRpc?: (fn: string, args: unknown) => unknown) {
  let seq = 0;
  return {
    rpc: async (fn: string, args: unknown) => (onRpc ? onRpc(fn, args) : { data: null, error: null }),
    from(table: string) {
      const all = () => (tables[table] ??= []);
      let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
      let payload: Row | Row[] = {};
      let head = false;
      const filters: ((r: Row) => boolean)[] = [];
      let sort: { col: string; asc: boolean } | null = null;
      let max: number | null = null;

      function run(): { data: unknown; error: null; count: number } {
        if (op === 'insert') {
          const rows = (Array.isArray(payload) ? payload : [payload]).map((r) => ({
            id: `new-${++seq}`,
            created_at: `2026-09-29T00:00:0${seq % 10}Z`,
            updated_at: `2026-09-29T00:00:0${seq % 10}Z`,
            ...r,
          }));
          all().push(...rows);
          return { data: rows, error: null, count: rows.length };
        }
        let rows = all().filter((r) => filters.every((f) => f(r)));
        if (op === 'update') for (const r of rows) Object.assign(r, payload);
        if (op === 'delete') tables[table] = all().filter((r) => !rows.includes(r));
        if (sort) {
          const { col, asc } = sort;
          rows = [...rows].sort((a, z) => String(a[col]).localeCompare(String(z[col])) * (asc ? 1 : -1));
        }
        if (max !== null) rows = rows.slice(0, max);
        return { data: head ? null : rows, error: null, count: rows.length };
      }

      const b = {
        select: (_cols?: string, opts?: { head?: boolean }) => {
          head = !!opts?.head;
          return b;
        },
        insert: (p: Row | Row[]) => {
          op = 'insert';
          payload = p;
          return b;
        },
        update: (p: Row) => {
          op = 'update';
          payload = p;
          return b;
        },
        delete: () => {
          op = 'delete';
          return b;
        },
        eq: (col: string, val: unknown) => {
          filters.push((r) => r[col] === val);
          return b;
        },
        neq: (col: string, val: unknown) => {
          filters.push((r) => r[col] !== val);
          return b;
        },
        is: (col: string, val: unknown) => {
          filters.push((r) => (r[col] ?? null) === val);
          return b;
        },
        // `col.is.null,col.eq.value` — the only shapes the routes use.
        or: (expr: string) => {
          const conds = expr.split(',').map((c) => c.split('.'));
          filters.push((r) =>
            conds.some(([col, op, val]) => (op === 'is' ? (r[col] ?? null) === null : r[col] === val)),
          );
          return b;
        },
        gte: (col: string, val: unknown) => {
          filters.push((r) => String(r[col] ?? '') >= String(val));
          return b;
        },
        in: (col: string, vals: unknown[]) => {
          filters.push((r) => vals.includes(r[col]));
          return b;
        },
        order: (col: string, opts?: { ascending?: boolean }) => {
          sort = { col, asc: opts?.ascending !== false };
          return b;
        },
        limit: (n: number) => {
          max = n;
          return b;
        },
        maybeSingle: async () => {
          const r = run();
          return { data: (r.data as Row[])[0] ?? null, error: null };
        },
        single: async () => {
          const r = run();
          return { data: (r.data as Row[])[0] ?? null, error: null };
        },
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(run()).then(resolve, reject),
      };
      return b;
    },
  };
}
