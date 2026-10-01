// Test-only in-memory stand-in for the Supabase client used by the LGPD
// modules (anonymize / delete / export). Supports the PostgREST subset
// they use, enforces the 1000-row read cap like config.toml max_rows,
// and records every write so tests can assert what was touched.

type Row = Record<string, unknown>
type Err = { message: string; code?: string }

export interface FakeDbOptions {
  /** Return an error for (table, op) — op: select | update | delete | insert | upsert. */
  fail?: (table: string, op: string) => Err | null
  /** Return an error for a Storage remove in `bucket`. */
  failStorage?: (bucket: string, paths: string[]) => Err | null
  maxRows?: number
}

export interface FakeWrite {
  table: string
  op: string
  payload?: unknown
  rows: number
}

export function makeFakeDb(tables: Record<string, Row[]>, opts: FakeDbOptions = {}) {
  const maxRows = opts.maxRows ?? 1000
  const writes: FakeWrite[] = []
  const reads: { table: string; inSizes: number[] }[] = []
  const removed: { bucket: string; paths: string[] }[] = []
  const t = (name: string) => (tables[name] ??= [])

  function builder(table: string) {
    let op = 'select'
    let payload: unknown
    let countMode = false
    let head = false
    let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } | undefined
    const filters: ((r: Row) => boolean)[] = []
    const inSizes: number[] = []
    let order: { col: string; asc: boolean } | null = null
    let limitN: number | null = null
    let range: [number, number] | null = null

    function run(): { data: unknown; error: Err | null; count?: number | null } {
      const err = opts.fail?.(table, op)
      if (err) return { data: null, error: err }
      const match = () => t(table).filter((r) => filters.every((f) => f(r)))
      if (op === 'insert' || op === 'upsert') {
        const list = (Array.isArray(payload) ? payload : [payload]) as Row[]
        const keys = upsertOpts?.onConflict?.split(',') ?? []
        for (const p of list) {
          const existing = keys.length ? t(table).find((r) => keys.every((k) => r[k] === p[k])) : undefined
          if (existing) {
            if (!upsertOpts?.ignoreDuplicates) Object.assign(existing, p)
          } else t(table).push({ ...p })
        }
        writes.push({ table, op, payload, rows: list.length })
        return { data: null, error: null }
      }
      if (op === 'update') {
        const rows = match()
        for (const r of rows) Object.assign(r, payload as Row)
        writes.push({ table, op, payload, rows: rows.length })
        return { data: null, error: null, count: countMode ? rows.length : null }
      }
      if (op === 'delete') {
        const rows = match()
        tables[table] = t(table).filter((r) => !rows.includes(r))
        writes.push({ table, op, rows: rows.length })
        return { data: null, error: null, count: countMode ? rows.length : null }
      }
      reads.push({ table, inSizes })
      let rows = match()
      if (order) {
        const { col, asc } = order
        rows = [...rows].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1))
      }
      const total = rows.length
      if (range) rows = rows.slice(range[0], range[1] + 1)
      if (limitN !== null) rows = rows.slice(0, limitN)
      rows = rows.slice(0, maxRows)
      if (head) return { data: null, error: null, count: total }
      return { data: rows.map((r) => ({ ...r })), error: null, count: countMode ? total : null }
    }

    const b: Record<string, unknown> = {
      select: (_cols?: string, o?: { count?: string; head?: boolean }) => {
        if (o?.count) countMode = true
        if (o?.head) head = true
        return b
      },
      insert: (p: unknown) => ((op = 'insert'), (payload = p), b),
      upsert: (p: unknown, o?: typeof upsertOpts) => ((op = 'upsert'), (payload = p), (upsertOpts = o), b),
      update: (p: unknown, o?: { count?: string }) => ((op = 'update'), (payload = p), (countMode = !!o?.count), b),
      delete: (o?: { count?: string }) => ((op = 'delete'), (countMode = !!o?.count), b),
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
      neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), b),
      gt: (c: string, v: unknown) => (filters.push((r) => String(r[c]) > String(v)), b),
      lt: (c: string, v: unknown) => (filters.push((r) => String(r[c]) < String(v)), b),
      lte: (c: string, v: unknown) => (filters.push((r) => String(r[c]) <= String(v)), b),
      in: (c: string, vs: unknown[]) => (inSizes.push(vs.length), filters.push((r) => vs.includes(r[c])), b),
      is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b),
      not: (c: string, operator: string, v: unknown) => {
        if (operator === 'is' && v === null) filters.push((r) => (r[c] ?? null) !== null)
        else if (operator === 'in') {
          const list = String(v).replace(/[()]/g, '').split(',')
          filters.push((r) => !list.includes(String(r[c])))
        }
        return b
      },
      order: (col: string, o?: { ascending?: boolean }) => ((order = { col, asc: o?.ascending !== false }), b),
      limit: (n: number) => ((limitN = n), b),
      range: (from: number, to: number) => ((range = [from, to]), b),
      maybeSingle: () => {
        const r = run()
        const data = Array.isArray(r.data) ? (r.data[0] ?? null) : r.data
        return Promise.resolve({ data, error: r.error })
      },
      single: () => {
        const r = run()
        const data = Array.isArray(r.data) ? (r.data[0] ?? null) : r.data
        return Promise.resolve({ data, error: r.error ?? (data ? null : { message: 'no rows' }) })
      },
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => Promise.resolve(run()).then(onF, onR),
    }
    return b
  }

  const db = {
    from: (table: string) => builder(table),
    storage: {
      from: (bucket: string) => ({
        remove: async (paths: string[]) => {
          const err = opts.failStorage?.(bucket, paths)
          if (err) return { data: null, error: err }
          removed.push({ bucket, paths })
          return { data: paths.map((name) => ({ name })), error: null }
        },
      }),
    },
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: db as any, tables, writes, reads, removed }
}
