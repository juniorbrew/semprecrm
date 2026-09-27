// ============================================================
// Tiny in-memory stand-in for the PostgREST query builder, for tests
// that need REAL filter semantics (the broadcast row-claim tests: two
// passes racing over the same rows). Not a test file itself — imported
// by *.test.ts.
//
// Supports what broadcast-core / broadcast-resume use: select (with
// { count: 'exact', head: true }), insert, update, eq, neq, in, is,
// lt, not(col,'is',null), or(...) with and(...) groups, order, range,
// limit, maybeSingle, single, and `await`. Each statement executes
// synchronously when awaited, so an UPDATE ... WHERE is atomic exactly
// like a single Postgres statement is.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

export type Row = Record<string, unknown>;

type Pred = (row: Row) => boolean;

function cmp(a: unknown, b: unknown): number {
  const ta = typeof a === 'string' ? Date.parse(a) : NaN;
  const tb = typeof b === 'string' ? Date.parse(b) : NaN;
  if (!Number.isNaN(ta) && !Number.isNaN(tb) && /\d{4}-\d{2}-\d{2}T/.test(String(a))) {
    return ta - tb;
  }
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'string' && typeof b === 'string' && /\d{4}-\d{2}-\d{2}T/.test(a)) {
    // timestamptz equality — compare the instant, microseconds included.
    return normalizeTs(a) === normalizeTs(b);
  }
  return false;
}

function normalizeTs(s: string): string {
  const m = s.match(/^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?$/);
  if (!m) return s;
  const frac = (m[2] ?? '').padEnd(6, '0').slice(0, 6);
  const base = new Date(`${m[1]}${m[3] ?? 'Z'}`).toISOString().slice(0, 19);
  return `${base}.${frac}`;
}

/** Split on top-level commas (not inside parentheses). */
function splitTop(expr: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of expr) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function parseTerm(term: string): Pred {
  const t = term.trim();
  const group = t.match(/^(and|or)\((.*)\)$/);
  if (group) {
    const parts = splitTop(group[2]).map(parseTerm);
    return group[1] === 'and'
      ? (r) => parts.every((p) => p(r))
      : (r) => parts.some((p) => p(r));
  }
  const [col, op, ...rest] = t.split('.');
  const val = rest.join('.');
  switch (op) {
    case 'eq':
      return (r) => sameValue(r[col], val) || String(r[col]) === val;
    case 'neq':
      return (r) => String(r[col]) !== val;
    case 'lt':
      return (r) => r[col] != null && cmp(r[col], val) < 0;
    case 'is':
      return val === 'null' ? (r) => r[col] == null : (r) => String(r[col]) === val;
    case 'not': {
      const inner = parseTerm(`${col}.${val}`);
      return (r) => !inner(r);
    }
    default:
      throw new Error(`fake-supabase: unsupported or() operator ${op}`);
  }
}

export class FakeDb {
  tables = new Map<string, Row[]>();
  private seq = 0;

  table(name: string): Row[] {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return this.tables.get(name)!;
  }

  seed(name: string, rows: Row[]): void {
    this.table(name).push(...rows.map((r) => ({ ...r })));
  }

  nextId(): string {
    this.seq += 1;
    return `id-${this.seq}`;
  }

  client(): SupabaseClient {
    return { from: (t: string) => new Query(this, t) } as unknown as SupabaseClient;
  }
}

class Query implements PromiseLike<unknown> {
  private preds: Pred[] = [];
  private op: 'select' | 'update' | 'insert' = 'select';
  private patch: Row = {};
  private inserts: Row[] = [];
  private returning = false;
  private countExact = false;
  private head = false;
  private orderBy: { col: string; asc: boolean } | null = null;
  private from_ = 0;
  private to_: number | null = null;
  private single_: 'single' | 'maybe' | null = null;

  constructor(
    private db: FakeDb,
    private name: string,
  ) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.op === 'select') {
      this.countExact = opts?.count === 'exact';
      this.head = Boolean(opts?.head);
    } else {
      this.returning = true;
    }
    return this;
  }
  update(patch: Row) {
    this.op = 'update';
    this.patch = patch;
    return this;
  }
  insert(rows: Row | Row[]) {
    this.op = 'insert';
    this.inserts = Array.isArray(rows) ? rows : [rows];
    return this;
  }
  eq(col: string, val: unknown) {
    this.preds.push((r) => sameValue(r[col], val) || r[col] === val);
    return this;
  }
  neq(col: string, val: unknown) {
    this.preds.push((r) => r[col] !== val);
    return this;
  }
  in(col: string, vals: unknown[]) {
    this.preds.push((r) => vals.some((v) => sameValue(r[col], v) || r[col] === v));
    return this;
  }
  is(col: string, val: null) {
    this.preds.push((r) => (val === null ? r[col] == null : r[col] === val));
    return this;
  }
  lt(col: string, val: unknown) {
    this.preds.push((r) => r[col] != null && cmp(r[col], val) < 0);
    return this;
  }
  not(col: string, op: string, val: unknown) {
    if (op !== 'is' || val !== null) throw new Error('fake-supabase: only not(col,"is",null)');
    this.preds.push((r) => r[col] != null);
    return this;
  }
  or(expr: string) {
    const p = parseTerm(`or(${expr})`);
    this.preds.push(p);
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderBy = { col, asc: opts?.ascending !== false };
    return this;
  }
  range(from: number, to: number) {
    this.from_ = from;
    this.to_ = to;
    return this;
  }
  limit(n: number) {
    this.to_ = this.from_ + n - 1;
    return this;
  }
  maybeSingle() {
    this.single_ = 'maybe';
    return this;
  }
  single() {
    this.single_ = 'single';
    return this;
  }

  private matches(): Row[] {
    return this.db.table(this.name).filter((r) => this.preds.every((p) => p(r)));
  }

  private execute(): { data: unknown; error: unknown; count?: number | null } {
    if (this.op === 'insert') {
      const created = this.inserts.map((r) => ({ id: this.db.nextId(), ...r }));
      this.db.table(this.name).push(...created);
      return { data: this.returning ? created.map((r) => ({ ...r })) : null, error: null };
    }
    if (this.op === 'update') {
      const hit = this.matches();
      for (const r of hit) Object.assign(r, this.patch);
      return { data: this.returning ? hit.map((r) => ({ ...r })) : null, error: null };
    }
    let rows = this.matches();
    const count = rows.length;
    if (this.orderBy) {
      const { col, asc } = this.orderBy;
      rows = [...rows].sort((a, b) => (asc ? 1 : -1) * cmp(a[col], b[col]));
    }
    // PostgREST default max-rows: 1000.
    const to = this.to_ ?? this.from_ + 999;
    rows = rows.slice(this.from_, to + 1).map((r) => ({ ...r }));
    if (this.head) return { data: null, error: null, count: this.countExact ? count : null };
    if (this.single_) {
      if (rows.length === 0) {
        return this.single_ === 'maybe'
          ? { data: null, error: null }
          : { data: null, error: { message: 'no rows' } };
      }
      return { data: rows[0], error: null };
    }
    return { data: rows, error: null, count: this.countExact ? count : null };
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    // Defer to a microtask so interleaved passes really interleave.
    return Promise.resolve()
      .then(() => this.execute())
      .then(onfulfilled, onrejected);
  }
}
