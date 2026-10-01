// Test double for the CSAT modules: a tiny in-memory Supabase client (tables
// + the few rpc functions of migration 074, with the same state transitions
// as the SQL). Used only by the csat-*.test.ts files.

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

export interface FakeState {
  tables: Record<string, Row[]>
  /** Names of the rpc functions called, in order. */
  rpcCalls: { name: string; args: Row }[]
  /** Make the next insert into `table` fail with this error. */
  failInsert?: Record<string, { code?: string; message: string }>
}

let seq = 0

export function makeFakeDb(tables: Record<string, Row[]> = {}) {
  const state: FakeState = { tables, rpcCalls: [] }
  const t = (name: string) => (state.tables[name] ??= [])

  function builder(table: string) {
    const filters: ((r: Row) => boolean)[] = []
    let op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select'
    let payload: Row | Row[] = {}
    let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {}
    let single = false
    let order: { col: string; asc: boolean } | null = null
    let max = Infinity
    let countOnly = false

    const run = (): { data: any; error: any } => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const rows = t(table)
      if (op === 'insert' || op === 'upsert') {
        const list = Array.isArray(payload) ? payload : [payload]
        const out: Row[] = []
        for (const p of list) {
          const fail = state.failInsert?.[table]
          if (op === 'insert' && fail) return { data: null, error: fail }
          const key = upsertOpts.onConflict
          if (op === 'upsert' && key && rows.some((r) => r[key] === p[key])) continue
          if (op === 'insert' && table === 'messages' && rows.some((r) => r.message_id && r.message_id === p.message_id && r.conversation_id === p.conversation_id)) {
            return { data: null, error: { code: '23505', message: 'duplicate' } }
          }
          const row = { id: `${table}-${++seq}`, ...p }
          rows.push(row)
          out.push(row)
        }
        return { data: out, error: null }
      }
      const hit = rows.filter((r) => filters.every((f) => f(r)))
      if (op === 'update') {
        for (const r of hit) Object.assign(r, payload)
        return { data: hit, error: null }
      }
      if (op === 'delete') {
        state.tables[table] = rows.filter((r) => !hit.includes(r))
        return { data: hit, error: null }
      }
      if (countOnly) return { data: null, error: null, count: hit.length } as never
      const sorted = order ? [...hit].sort((a, b) => (String(a[order!.col]) < String(b[order!.col]) ? -1 : 1) * (order!.asc ? 1 : -1)) : hit
      return { data: sorted.slice(0, max), error: null }
    }

    const b: Row = {
      select: (_c?: string, o?: { head?: boolean; count?: string }) => ((countOnly = !!o?.head), b),
      insert: (p: Row) => ((op = 'insert'), (payload = p), b),
      update: (p: Row) => ((op = 'update'), (payload = p), b),
      upsert: (p: Row, o: typeof upsertOpts) => ((op = 'upsert'), (payload = p), (upsertOpts = o), b),
      delete: () => ((op = 'delete'), b),
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), b),
      neq: (k: string, v: unknown) => (filters.push((r) => r[k] !== v), b),
      gte: (k: string, v: string) => (filters.push((r) => String(r[k]) >= v), b),
      in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), b),
      is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), b),
      order: (col: string, o?: { ascending?: boolean }) => ((order = { col, asc: o?.ascending ?? true }), b),
      limit: (n: number) => ((max = n), b),
      maybeSingle: () => {
        single = true
        const r = run()
        return Promise.resolve(r.error ? r : { data: (r.data as Row[])[0] ?? null, error: null })
      },
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => {
        void single
        return Promise.resolve(run()).then(ok, bad)
      },
    }
    return b
  }

  const rpc = async (name: string, args: Row) => {
    state.rpcCalls.push({ name, args })
    const now = args.p_now as string
    if (name === 'csat_record_answer') {
      const r = t('csat_responses').find((x) => x.id === args.p_response_id)
      if (!r || r.status !== 'sent' || Date.parse(now) - Date.parse(r.sent_at) > 48 * 3_600_000) return { data: [], error: null }
      const comment = args.p_comment ? String(args.p_comment).slice(0, 500) : null
      Object.assign(r, { status: 'answered', score: args.p_score, answered_at: now, comment, comment_received_at: comment ? now : null, comment_requested_at: null })
      t('conversation_events').push({ conversation_id: r.conversation_id, event_type: 'csat_answered', payload: { score: args.p_score } })
      t('automation_event_queue').push({ trigger_type: 'csat_received', conversation_id: r.conversation_id, context: { score: args.p_score } })
      return { data: [{ ...r }], error: null }
    }
    if (name === 'csat_request_comment') {
      const r = t('csat_responses').find((x) => x.id === args.p_response_id)
      const ok = !!r && r.status === 'answered' && !r.comment_requested_at && !r.comment_received_at
      if (ok) r.comment_requested_at = now
      return { data: ok, error: null }
    }
    if (name === 'csat_record_comment') {
      const r = t('csat_responses').find((x) => x.id === args.p_response_id)
      const ok =
        !!r && r.status === 'answered' && r.comment_requested_at && !r.comment_received_at &&
        Date.parse(now) - Date.parse(r.comment_requested_at) <= 10 * 60_000
      if (ok) Object.assign(r, { comment: args.p_comment ? String(args.p_comment).slice(0, 500) : null, comment_received_at: now })
      return { data: !!ok, error: null }
    }
    if (name === 'csat_expire') {
      let n = 0
      for (const r of t('csat_responses')) {
        if (r.status === 'sent' && Date.parse(now) - Date.parse(r.sent_at) > 48 * 3_600_000) {
          r.status = 'expired'
          n += 1
        }
      }
      return { data: n, error: null }
    }
    if (name === 'csat_claim_jobs') {
      const due = t('csat_jobs').filter((j) => !j.processed_at && Date.parse(j.run_at) <= Date.parse(now) && (j.attempts ?? 0) < 3 && !j.claimed_at)
      for (const j of due) Object.assign(j, { claimed_at: now, attempts: (j.attempts ?? 0) + 1 })
      return { data: due.map((j) => ({ ...j })), error: null }
    }
    return { data: null, error: { code: 'PGRST202', message: `no function ${name}` } }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: { from: builder, rpc } as any, state }
}
