import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'

import { parseIdempotencyKey, requestHash, runIdempotent, type IdempotentOutcome } from './idempotency'

type Row = { account_id: string; key: string; request_hash: string; status: string; response_status?: number; response?: unknown }

/** In-memory api_idempotency_keys with the primary key (account_id, key) semantics of the migration. */
function fakeDb() {
  const rows = new Map<string, Row>()
  const id = (a: string, k: string) => `${a}|${k}`
  const db = {
    from: () => ({
      insert: async (r: Row) => {
        await Promise.resolve()
        const k = id(r.account_id, r.key)
        if (rows.has(k)) return { error: { code: '23505', message: 'duplicate key' } }
        rows.set(k, { ...r })
        return { error: null }
      },
      select: () => {
        const f: Record<string, string> = {}
        const b = {
          eq: (c: string, v: string) => ((f[c] = v), b),
          maybeSingle: async () => ({ data: rows.get(id(f.account_id, f.key)) ?? null, error: null }),
        }
        return b
      },
      update: (patch: Partial<Row>) => {
        const f: Record<string, string> = {}
        const b = {
          eq: (c: string, v: string) => {
            f[c] = v
            const row = rows.get(id(f.account_id, f.key))
            if (f.account_id && f.key && row) Object.assign(row, patch)
            return f.account_id && f.key ? Promise.resolve({ error: null }) : b
          },
        }
        return b
      },
      delete: () => {
        const f: Record<string, string> = {}
        const b = {
          eq: (c: string, v: string) => {
            f[c] = v
            if (f.account_id && f.key && f.status) {
              const row = rows.get(id(f.account_id, f.key))
              if (row && row.status === f.status) rows.delete(id(f.account_id, f.key))
              return Promise.resolve({ error: null })
            }
            return b
          },
        }
        return b
      },
    }),
  }
  return { db: db as unknown as SupabaseClient, rows }
}

const input = { accountId: 'acc', key: 'k1', hash: requestHash({ to: '5511999990000', text: 'oi' }) }
const sent = (): IdempotentOutcome => ({ status: 201, body: { object: 'message', id: 'm1' }, store: true })

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
    // let both reach the claim, then finish the winner
    await new Promise((r) => setTimeout(r, 10))
    release()
    const results = await Promise.all([a, b])
    expect(runs).toBe(1)
    expect(results.map((r) => r.kind).sort()).toEqual(['conflict', 'fresh'])
    expect(results.find((r) => r.kind === 'conflict')).toMatchObject({ status: 409, code: 'idempotency_in_progress' })
    // and after completion a retry replays
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

  it('a failure before any send releases the key so the caller can retry', async () => {
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
      runs++, { status: 502, body: { error: { code: 'send_unconfirmed' } }, store: true }
    )
    await runIdempotent(db, input, run)
    const again = await runIdempotent(db, input, run)
    expect(again).toMatchObject({ kind: 'replay', status: 502 })
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
})
