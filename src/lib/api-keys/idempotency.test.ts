import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'

import {
  IDEMPOTENCY_LEASE_MS,
  SEND_UNKNOWN_BODY,
  parseIdempotencyKey,
  requestHash,
  runIdempotent,
  type IdempotentOutcome,
  type RecoverResult,
} from './idempotency'

type Row = {
  account_id: string
  key: string
  request_hash: string
  status: string
  created_at: string
  response_status?: number
  response?: unknown
  conversation_id?: string | null
  contact_id?: string | null
  channel?: string | null
}

const T0 = new Date('2026-10-01T12:00:00Z')

/**
 * In-memory api_idempotency_keys with the primary key (account_id, key) semantics of the
 * migration, a controllable clock and injectable update failures.
 */
function fakeDb(opts: { failUpdates?: number } = {}) {
  const rows = new Map<string, Row>()
  const clock: { now?: Date } = {}
  let failUpdates = opts.failUpdates ?? 0
  const id = (a: string, k: string) => `${a}|${k}`

  function query(op: 'select' | 'update' | 'delete', patch?: Partial<Row>) {
    const f: Record<string, string> = {}
    const apply = () => {
      const row = rows.get(id(f.account_id, f.key))
      const match = row && (!f.status || row.status === f.status)
      if (op === 'update') {
        if (failUpdates > 0) {
          failUpdates -= 1
          return { error: { message: 'db down' } }
        }
        if (match) Object.assign(row, patch)
      }
      if (op === 'delete' && match) rows.delete(id(f.account_id, f.key))
      return { error: null }
    }
    const b: Record<string, unknown> = {
      eq: (c: string, v: string) => ((f[c] = v), b),
      maybeSingle: async () => ({ data: rows.get(id(f.account_id, f.key)) ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => resolve(apply()),
    }
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
  it('runs once, stores the response and replays it for the same key and body', async () => {
    const { db } = fakeDb()
    let runs = 0
    const run = async () => (runs++, sent())
    const first = await runIdempotent(db, input, run)
    expect(first).toEqual({ kind: 'fresh', status: 201, body: { object: 'message', id: 'm1' } })
    const again = await runIdempotent(db, input, run)
    expect(again).toEqual({ kind: 'replay', status: 201, body: { object: 'message', id: 'm1' } })
    expect(runs).toBe(1)
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
    const run = async (): Promise<IdempotentOutcome> => (
      runs++, { status: 502, body: SEND_UNKNOWN_BODY, store: true }
    )
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
  function stale(db: ReturnType<typeof fakeDb>, over: Partial<Row> = {}) {
    db.rows.set('acc|k1', {
      account_id: 'acc',
      key: 'k1',
      request_hash: input.hash,
      status: 'in_progress',
      created_at: T0.toISOString(),
      conversation_id: 'conv1',
      contact_id: 'c1',
      channel: 'official',
      ...over,
    })
  }
  const later = (ms: number) => () => new Date(T0.getTime() + ms)

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

  it('after the lease, a message found in the conversation is replayed as a success (no re-send)', async () => {
    const f = fakeDb()
    stale(f)
    const body = { object: 'message', message_id: 'm9' }
    const recover = vi.fn(async (): Promise<RecoverResult> => ({ kind: 'sent', status: 201, body }))
    const run = vi.fn(async () => sent())
    const r = await runIdempotent(f.db, input, run, { now: later(IDEMPOTENCY_LEASE_MS + 1), recover, sleep: noSleep })
    expect(r).toEqual({ kind: 'replay', status: 201, body })
    expect(run).not.toHaveBeenCalled()
    expect(f.rows.get('acc|k1')).toMatchObject({ status: 'done', response_status: 201 })
    // and the next retry is a plain replay
    expect(await runIdempotent(f.db, input, run, { now: later(IDEMPOTENCY_LEASE_MS + 5), recover })).toMatchObject({ kind: 'replay', status: 201 })
    expect(recover).toHaveBeenCalledTimes(1)
  })

  it('after the lease, nothing found: stores send_unknown and never re-sends', async () => {
    const f = fakeDb()
    stale(f)
    const run = vi.fn(async () => sent())
    const recover = async (): Promise<RecoverResult> => ({ kind: 'unknown' })
    const r = await runIdempotent(f.db, input, run, { now: later(IDEMPOTENCY_LEASE_MS + 1), recover, sleep: noSleep })
    expect(r).toEqual({ kind: 'replay', status: 502, body: SEND_UNKNOWN_BODY })
    expect(run).not.toHaveBeenCalled()
    expect(await runIdempotent(f.db, input, run, { now: later(IDEMPOTENCY_LEASE_MS + 9) })).toMatchObject({ kind: 'replay', status: 502 })
    expect(run).not.toHaveBeenCalled()
  })

  it('without a recover function the stale claim also resolves to send_unknown', async () => {
    const f = fakeDb()
    stale(f)
    const run = vi.fn(async () => sent())
    const r = await runIdempotent(f.db, input, run, { now: later(IDEMPOTENCY_LEASE_MS + 1), sleep: noSleep })
    expect(r).toMatchObject({ kind: 'replay', status: 502 })
    expect(run).not.toHaveBeenCalled()
  })

  it('when the send never began, the claim is taken over and the request runs once', async () => {
    const f = fakeDb()
    stale(f, { conversation_id: null, contact_id: null, channel: null })
    let runs = 0
    const run = async () => (runs++, sent())
    const recover = async (): Promise<RecoverResult> => ({ kind: 'unsent' })
    const r = await runIdempotent(f.db, input, run, { now: later(IDEMPOTENCY_LEASE_MS + 1), recover, sleep: noSleep })
    expect(r).toMatchObject({ kind: 'fresh', status: 201 })
    expect(runs).toBe(1)
    expect(f.rows.get('acc|k1')).toMatchObject({ status: 'done', response_status: 201 })
  })

  it('does not loop forever if recovery keeps answering "unsent"', async () => {
    const f = fakeDb()
    stale(f, { conversation_id: null })
    const run = async () => sent()
    const recover = async (): Promise<RecoverResult> => ({ kind: 'unsent' })
    // the first pass takes over and runs: the key is then fresh and done
    await runIdempotent(f.db, input, run, { now: later(IDEMPOTENCY_LEASE_MS + 1), recover, sleep: noSleep })
    expect(f.rows.get('acc|k1')?.status).toBe('done')
  })
})
