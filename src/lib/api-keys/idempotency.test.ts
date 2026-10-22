import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'

import {
  IDEMPOTENCY_LEASE_MS,
  SEND_UNKNOWN_BODY,
  parseIdempotencyKey,
  requestHash,
  runIdempotent,
  type IdempotencyDeps,
  type IdempotentOutcome,
  type RecoverResult,
} from './idempotency'

type Row = {
  account_id: string
  key: string
  request_hash: string
  status: string
  claim_id: string | null
  created_at: string
  response_status?: number
  response?: unknown
  conversation_id?: string | null
  contact_id?: string | null
  channel?: string | null
}

const T0 = new Date('2026-10-01T12:00:00Z')

/**
 * In-memory api_idempotency_keys: primary key (account_id, key), filters (eq / is / or),
 * delete ... select returning the removed rows, a controllable clock and injectable update failures.
 */
function fakeDb(opts: { failUpdates?: number } = {}) {
  const rows = new Map<string, Row>()
  const clock: { now?: Date } = {}
  let failUpdates = opts.failUpdates ?? 0
  const id = (a: string, k: string) => `${a}|${k}`

  function query(op: 'select' | 'update' | 'delete', patch?: Partial<Row>) {
    const preds: ((r: Row) => boolean)[] = []
    const b: Record<string, unknown> = {}
    const matches = () => [...rows.values()].filter((r) => preds.every((p) => p(r)))
    const apply = () => {
      const hit = matches()
      if (op === 'update') {
        if (failUpdates > 0) {
          failUpdates -= 1
          return { data: null, error: { message: 'db down' } }
        }
        for (const r of hit) Object.assign(r, patch)
        return { data: hit.map((r) => ({ key: r.key })), error: null }
      }
      if (op === 'delete') {
        for (const r of hit) rows.delete(id(r.account_id, r.key))
        return { data: hit.map((r) => ({ key: r.key })), error: null }
      }
      return { data: hit[0] ?? null, error: null }
    }
    b.eq = (c: string, v: unknown) => (preds.push((r) => (r as unknown as Record<string, unknown>)[c] === v), b)
    b.is = (c: string, v: null) => (preds.push((r) => ((r as unknown as Record<string, unknown>)[c] ?? null) === v), b)
    b.or = (expr: string) => {
      // only the shape the code uses: "status.eq.in_progress,response_status.gte.300"
      expect(expr).toBe('status.eq.in_progress,response_status.gte.300')
      preds.push((r) => r.status === 'in_progress' || (r.response_status ?? 0) >= 300)
      return b
    }
    b.select = () => b
    b.maybeSingle = async () => ({ data: matches()[0] ?? null, error: null })
    b.then = (resolve: (v: unknown) => unknown) => resolve(apply())
    return b
  }

  const db = {
    from: () => ({
      insert: async (r: Omit<Row, 'created_at'>) => {
        await Promise.resolve()
        const k = id(r.account_id, r.key)
        if (rows.has(k)) return { error: { code: '23505', message: 'duplicate key' } }
        rows.set(k, { ...r, created_at: (clock.now ?? new Date()).toISOString() })
        return { error: null }
      },
      select: () => query('select'),
      update: (patch: Partial<Row>) => query('update', patch),
      delete: () => query('delete'),
    }),
  }
  return { db: db as unknown as SupabaseClient, rows, clock }
}

const input = { accountId: 'acc', key: 'k1', hash: requestHash({ to: '5511999990000', text: 'oi' }) }
const sent = (): IdempotentOutcome => ({ status: 201, body: { object: 'message', id: 'm1' }, store: true })
const noSleep = async () => undefined
let seq = 0
const ids = (): IdempotencyDeps => ({ sleep: noSleep, newClaimId: () => `claim-${++seq}` })

describe('Idempotency-Key header', () => {
  it('accepts printable ASCII up to 255 chars, rejects the rest', () => {
    expect(parseIdempotencyKey(null)).toEqual({ key: null })
    expect(parseIdempotencyKey(' order-123 ')).toEqual({ key: 'order-123' })
    for (const bad of ['', '   ', 'a b', 'ação', 'x'.repeat(256)]) {
      expect(parseIdempotencyKey(bad)).toHaveProperty('error')
    }
  })

  it('hashes the request fields, order-independent', () => {
    expect(requestHash({ a: 1, b: 2 })).toBe(requestHash({ b: 2, a: 1 }))
    expect(requestHash({ to: '1', text: 'a' })).not.toBe(requestHash({ to: '1', text: 'b' }))
  })
})

describe('runIdempotent', () => {
  it('runs once, hands the claim id to the run, stores the response and replays it', async () => {
    const { db } = fakeDb()
    const seen: string[] = []
    const run = async (claimId: string) => (seen.push(claimId), sent())
    const first = await runIdempotent(db, input, run, { newClaimId: () => 'claim-X' })
    expect(first).toEqual({ kind: 'fresh', status: 201, body: { object: 'message', id: 'm1' } })
    const again = await runIdempotent(db, input, run)
    expect(again).toEqual({ kind: 'replay', status: 201, body: { object: 'message', id: 'm1' } })
    expect(seen).toEqual(['claim-X'])
  })

  it('422 when the key is reused with a different body', async () => {
    const { db } = fakeDb()
    await runIdempotent(db, input, async () => sent())
    const r = await runIdempotent(db, { ...input, hash: requestHash({ to: '5511999990000', text: 'outro' }) }, async () => sent())
    expect(r).toMatchObject({ kind: 'conflict', status: 422, code: 'idempotency_key_reused' })
  })

  it('two concurrent requests with one key send once: the loser gets 409 in progress', async () => {
    const { db } = fakeDb()
    let runs = 0
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const run = async () => {
      runs++
      await gate
      return sent()
    }
    const a = runIdempotent(db, input, run)
    const b = runIdempotent(db, input, run)
    await new Promise((r) => setTimeout(r, 10))
    release()
    const results = await Promise.all([a, b])
    expect(runs).toBe(1)
    expect(results.map((r) => r.kind).sort()).toEqual(['conflict', 'fresh'])
    expect(results.find((r) => r.kind === 'conflict')).toMatchObject({ status: 409, code: 'idempotency_in_progress' })
    expect(await runIdempotent(db, input, run)).toMatchObject({ kind: 'replay', status: 201 })
    expect(runs).toBe(1)
  })

  it('ten concurrent duplicates still send exactly once', async () => {
    const { db } = fakeDb()
    let runs = 0
    const run = async () => {
      runs++
      await new Promise((r) => setTimeout(r, 5))
      return sent()
    }
    await Promise.all(Array.from({ length: 10 }, () => runIdempotent(db, input, run)))
    expect(runs).toBe(1)
  })

  it('a failure known to precede the send releases the key so the caller can retry', async () => {
    const { db, rows } = fakeDb()
    const bad = await runIdempotent(db, input, async () => ({ status: 400, body: { error: { code: 'invalid_phone' } }, store: false }))
    expect(bad).toMatchObject({ kind: 'fresh', status: 400 })
    expect(rows.size).toBe(0)
    const ok = await runIdempotent(db, input, async () => sent())
    expect(ok).toMatchObject({ kind: 'fresh', status: 201 })
  })

  it('an unexpected throw releases the key and propagates', async () => {
    const { db, rows } = fakeDb()
    await expect(
      runIdempotent(db, input, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(rows.size).toBe(0)
  })

  it('stores an ambiguous failure (message may have left) and replays it instead of re-sending', async () => {
    const { db } = fakeDb()
    let runs = 0
    const run = async (): Promise<IdempotentOutcome> => (runs++, { status: 502, body: SEND_UNKNOWN_BODY, store: true })
    await runIdempotent(db, input, run)
    const again = await runIdempotent(db, input, run)
    expect(again).toMatchObject({ kind: 'replay', status: 502, body: SEND_UNKNOWN_BODY })
    expect(runs).toBe(1)
  })

  it('keys are scoped per account', async () => {
    const { db } = fakeDb()
    let runs = 0
    const run = async () => (runs++, sent())
    await runIdempotent(db, input, run)
    await runIdempotent(db, { ...input, accountId: 'other' }, run)
    expect(runs).toBe(2)
  })

  it('retries the final update, so a transient DB error does not leave the key in progress', async () => {
    const { db, rows } = fakeDb({ failUpdates: 2 })
    await runIdempotent(db, input, async () => sent(), { sleep: noSleep })
    expect(rows.get('acc|k1')).toMatchObject({ status: 'done', response_status: 201 })
  })

  it('still answers the caller when every update attempt fails (the key stays in progress)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { db, rows } = fakeDb({ failUpdates: 99 })
    const r = await runIdempotent(db, input, async () => sent(), { sleep: noSleep })
    expect(r).toMatchObject({ kind: 'fresh', status: 201 })
    expect(rows.get('acc|k1')?.status).toBe('in_progress')
    err.mockRestore()
  })
})

describe('crash recovery (stale in_progress claim)', () => {
  function stale(f: ReturnType<typeof fakeDb>, over: Partial<Row> = {}) {
    f.rows.set('acc|k1', {
      account_id: 'acc',
      key: 'k1',
      request_hash: input.hash,
      status: 'in_progress',
      claim_id: 'claim-old',
      created_at: T0.toISOString(),
      conversation_id: 'conv1',
      contact_id: 'c1',
      channel: 'official',
      ...over,
    })
  }
  const later = (ms: number) => () => new Date(T0.getTime() + ms)
  const pastLease = later(IDEMPOTENCY_LEASE_MS + 1)

  it('the lease comfortably exceeds the worst send path (pacing queue + provider timeout)', () => {
    expect(IDEMPOTENCY_LEASE_MS).toBeGreaterThanOrEqual(10 * 60_000)
  })

  it('within the lease a retry gets 409 and nothing is resolved', async () => {
    const f = fakeDb()
    stale(f)
    const recover = vi.fn()
    const run = vi.fn(async () => sent())
    const r = await runIdempotent(f.db, input, run, { now: later(IDEMPOTENCY_LEASE_MS - 1), recover })
    expect(r).toMatchObject({ kind: 'conflict', status: 409, code: 'idempotency_in_progress' })
    expect(recover).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('after the lease, a message found for this claim is replayed as a success (no re-send)', async () => {
    const f = fakeDb()
    stale(f)
    const body = { object: 'message', message_id: 'm9' }
    const recover = vi.fn(async (): Promise<RecoverResult> => ({ kind: 'sent', status: 201, body }))
    const run = vi.fn(async () => sent())
    const r = await runIdempotent(f.db, input, run, { ...ids(), now: pastLease, recover })
    expect(r).toEqual({ kind: 'replay', status: 201, body })
    expect(run).not.toHaveBeenCalled()
    expect(f.rows.get('acc|k1')).toMatchObject({ status: 'done', response_status: 201 })
    expect(await runIdempotent(f.db, input, run, { ...ids(), now: later(IDEMPOTENCY_LEASE_MS + 5), recover })).toMatchObject({ kind: 'replay', status: 201 })
    expect(recover).toHaveBeenCalledTimes(1)
  })

  it('after the lease, nothing found: stores send_unknown and never re-sends', async () => {
    const f = fakeDb()
    stale(f)
    const run = vi.fn(async () => sent())
    const recover = async (): Promise<RecoverResult> => ({ kind: 'unknown' })
    const r = await runIdempotent(f.db, input, run, { ...ids(), now: pastLease, recover })
    expect(r).toEqual({ kind: 'replay', status: 502, body: SEND_UNKNOWN_BODY })
    expect(run).not.toHaveBeenCalled()
    expect(await runIdempotent(f.db, input, run, { ...ids(), now: later(IDEMPOTENCY_LEASE_MS + 9) })).toMatchObject({ kind: 'replay', status: 502 })
    expect(run).not.toHaveBeenCalled()
  })

  it('without a recover function the stale claim also resolves to send_unknown', async () => {
    const f = fakeDb()
    stale(f)
    const run = vi.fn(async () => sent())
    const r = await runIdempotent(f.db, input, run, { ...ids(), now: pastLease })
    expect(r).toMatchObject({ kind: 'replay', status: 502 })
    expect(run).not.toHaveBeenCalled()
  })

  it('when the send never began, the claim is taken over and the request runs once', async () => {
    const f = fakeDb()
    stale(f, { conversation_id: null, contact_id: null, channel: null })
    let runs = 0
    const run = async () => (runs++, sent())
    const recover = async (): Promise<RecoverResult> => ({ kind: 'unsent' })
    const r = await runIdempotent(f.db, input, run, { ...ids(), now: pastLease, recover })
    expect(r).toMatchObject({ kind: 'fresh', status: 201 })
    expect(runs).toBe(1)
    expect(f.rows.get('acc|k1')).toMatchObject({ status: 'done', response_status: 201 })
  })

  it('two concurrent retries of a stale never-started claim: exactly one takes over and sends', async () => {
    const f = fakeDb()
    stale(f, { conversation_id: null, contact_id: null, channel: null })
    let runs = 0
    const run = async () => {
      runs++
      await new Promise((r) => setTimeout(r, 10))
      return sent()
    }
    const recover = async (): Promise<RecoverResult> => ({ kind: 'unsent' })
    const results = await Promise.all(Array.from({ length: 5 }, () => runIdempotent(f.db, input, run, { ...ids(), now: pastLease, recover })))
    expect(runs).toBe(1)
    expect(results.filter((r) => r.kind === 'fresh')).toHaveLength(1)
    expect(results.filter((r) => r.kind === 'conflict')).toHaveLength(4)
    expect(f.rows.get('acc|k1')).toMatchObject({ status: 'done', response_status: 201 })
  })

  it('the original, slow request cannot clobber the takeover that replaced its claim', async () => {
    const f = fakeDb()
    let releaseA!: () => void
    const gateA = new Promise<void>((r) => (releaseA = r))
    const a = runIdempotent(f.db, input, async () => (await gateA, { status: 502, body: SEND_UNKNOWN_BODY, store: true }), { sleep: noSleep, newClaimId: () => 'claim-A' })
    await new Promise((r) => setTimeout(r, 5))
    // A never recorded a send target (conversation_id NULL): B takes over after the lease.
    const farFuture = () => new Date(Date.now() + IDEMPOTENCY_LEASE_MS + 60_000)
    const b = await runIdempotent(f.db, input, async () => sent(), {
      sleep: noSleep,
      newClaimId: () => 'claim-B',
      now: farFuture,
      recover: async () => ({ kind: 'unsent' }),
    })
    expect(b).toMatchObject({ kind: 'fresh', status: 201 })
    releaseA()
    await a
    expect(f.rows.get('acc|k1')).toMatchObject({ claim_id: 'claim-B', status: 'done', response_status: 201 })
  })

  it('a late result of the original replaces a stored send_unknown, but never a stored success', async () => {
    // original finishes AFTER a recovery already resolved the claim
    for (const [recovered, finalStatus] of [
      [{ kind: 'unknown' } as RecoverResult, 201],
      [{ kind: 'sent', status: 201, body: { object: 'message', message_id: 'm9' } } as RecoverResult, 201],
    ] as const) {
      const f = fakeDb()
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      const original = runIdempotent(f.db, input, async () => (await gate, { status: 502, body: SEND_UNKNOWN_BODY, store: true }), { sleep: noSleep, newClaimId: () => 'claim-A' })
      await new Promise((r) => setTimeout(r, 5))
      await runIdempotent(f.db, input, async () => sent(), {
        sleep: noSleep,
        now: () => new Date(Date.now() + IDEMPOTENCY_LEASE_MS + 60_000),
        recover: async () => recovered,
      })
      release()
      await original
      const row = f.rows.get('acc|k1')!
      if (recovered.kind === 'sent') {
        // the stored success survives the original's later failure
        expect(row.response_status).toBe(finalStatus)
      } else {
        // send_unknown (502) may be replaced by the original's own (502 here): still done
        expect(row.status).toBe('done')
      }
    }
  })

  it('a late success of the original overwrites a stored send_unknown', async () => {
    const f = fakeDb()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const original = runIdempotent(f.db, input, async () => (await gate, sent()), { sleep: noSleep, newClaimId: () => 'claim-A' })
    await new Promise((r) => setTimeout(r, 5))
    await runIdempotent(f.db, input, async () => sent(), {
      sleep: noSleep,
      now: () => new Date(Date.now() + IDEMPOTENCY_LEASE_MS + 60_000),
      recover: async () => ({ kind: 'unknown' }),
    })
    expect(f.rows.get('acc|k1')).toMatchObject({ response_status: 502 })
    release()
    await original
    expect(f.rows.get('acc|k1')).toMatchObject({ claim_id: 'claim-A', response_status: 201 })
  })
})
