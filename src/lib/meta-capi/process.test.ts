import { describe, expect, it, vi } from 'vitest'

import type { SupabaseClient } from '@supabase/supabase-js'

import { nextAttemptAt, processCapiBatch } from './process'
import type { ClaimedEvent } from './payload'
import { explainMetaError, sendCapiEvents, type SendOutcome } from './send'

const NOW = new Date('2026-11-09T12:00:00Z')

const claimed = (over: Partial<ClaimedEvent> = {}): ClaimedEvent => ({
  id: 'e1',
  account_id: 'a1',
  deal_id: 'd1',
  event_name: 'lead',
  event_id: 'sempre-d1-lead',
  attempts: 0,
  lease_until: '2026-11-09T12:02:00+00:00',
  occurred_at: '2026-11-09T11:00:00Z',
  value: null,
  currency: null,
  dataset_id: '123456789',
  token_enc: 'enc',
  contact_id: 'c1',
  contact_phone: '+5511900001111',
  contact_email: null,
  contact_instagram_id: null,
  contact_messenger_id: null,
  contact_anonymized: false,
  origin_channel: 'whatsapp',
  origin_kind: 'ad',
  origin_click_id_type: 'ctwa_clid',
  origin_click_id: 'CTWA',
  origin_occurred_at: '2026-11-09T10:00:00Z',
  waba_id: 'W1',
  channel_external_id: null,
  ...over,
})

type Upd = { table: string; patch: Record<string, unknown>; filters: Record<string, unknown> }
/** `matches` decides, per update, how many rows "matched" (0 = lease lost); `updateError` simulates a DB error. */
function fakeDb(
  rows: ClaimedEvent[],
  claimError: { code: string } | null = null,
  opts: { matches?: (u: Upd) => number; updateError?: { code: string } | null } = {},
) {
  const updates: Upd[] = []
  const db = {
    rpc: vi.fn(async () => ({ data: rows, error: claimError })),
    from: (table: string) => ({
      update: (patch: Record<string, unknown>) => {
        const filters: Record<string, unknown> = {}
        const q: Record<string, unknown> = {}
        q.eq = (k: string, v: unknown) => ((filters[k] = v), q)
        q.is = (k: string, v: unknown) => ((filters[k] = v), q)
        q.select = () => q
        q.then = (res: (v: unknown) => void) => {
          const u = { table, patch, filters }
          updates.push(u)
          const n = opts.matches ? opts.matches(u) : 1
          res({ data: Array.from({ length: n }, () => ({ id: 'x' })), error: opts.updateError ?? null })
        }
        return q
      },
    }),
  }
  return { db: db as unknown as SupabaseClient, updates, rpc: db.rpc }
}

const ok: SendOutcome = { ok: true, error: null, code: null, retryable: false }
const run = (db: SupabaseClient, send: (a: never) => Promise<SendOutcome>) =>
  processCapiBatch({ db, now: () => NOW, decryptToken: () => 'TOKEN', send: send as never })

describe('processCapiBatch', () => {
  it('sends and marks sent, decrypting the token; a saved test code is never added to a real event', async () => {
    const { db, updates } = fakeDb([claimed()])
    const send = vi.fn<(a: unknown) => Promise<SendOutcome>>(async () => ok)
    const s = await run(db, send)
    expect(s).toMatchObject({ claimed: 1, sent: 1 })
    const arg = send.mock.calls[0][0] as { token: string; datasetId: string; body: { data: unknown[] } }
    expect(arg.token).toBe('TOKEN')
    expect(arg.datasetId).toBe('123456789')
    expect(arg.body.data).toHaveLength(1)
    expect(updates[0].patch).toMatchObject({ status: 'sent', attempts: 1, claimed_until: null })
    expect(updates[0].filters).toMatchObject({ id: 'e1', status: 'pending', claimed_until: '2026-11-09T12:02:00+00:00' })
    expect(arg.body).not.toHaveProperty('test_event_code')
  })

  it('retries with growing backoff, then fails after 5 attempts', async () => {
    const retry: SendOutcome = { ok: false, error: 'A Meta está fora do ar no momento.', code: null, retryable: true }
    for (const [attempts, minutes] of [[0, 1], [1, 5], [2, 30], [3, 120]] as const) {
      const { db, updates } = fakeDb([claimed({ attempts })])
      const s = await run(db, async () => retry)
      expect(s.retrying).toBe(1)
      expect(updates[0].patch.next_attempt_at).toBe(new Date(NOW.getTime() + minutes * 60_000).toISOString())
    }
    const { db, updates } = fakeDb([claimed({ attempts: 4 })])
    const s = await run(db, async () => retry)
    expect(s.failed).toBe(1)
    expect(updates[0].patch).toMatchObject({ status: 'failed', attempts: 5, last_error: 'A Meta está fora do ar no momento.' })
    expect(nextAttemptAt(5, NOW)).toBeNull()
  })

  it('a non-retryable error fails at once', async () => {
    const { db, updates } = fakeDb([claimed()])
    const s = await run(db, async () => ({ ok: false, error: 'A Meta recusou os dados do evento ou o ID do conjunto de dados.', code: 100, retryable: false }))
    expect(s.failed).toBe(1)
    expect(updates[0].patch.status).toBe('failed')
  })

  it('error 190 pauses the account settings and does not send the rest of that account', async () => {
    const { db, updates } = fakeDb([claimed({ id: 'e1' }), claimed({ id: 'e2' })])
    const send = vi.fn<(a: unknown) => Promise<SendOutcome>>(async () => ({ ok: false, error: 'A chave de acesso é inválida ou venceu.', code: 190, retryable: false }) as SendOutcome)
    const s = await run(db, send)
    expect(send).toHaveBeenCalledTimes(1)
    expect(s.paused).toBe(1)
    const pause = updates.find((u) => u.table === 'meta_capi_settings')
    expect(pause?.patch).toEqual({ paused_reason: 'invalid_token' })
    expect(pause?.filters).toMatchObject({ account_id: 'a1', token_enc: 'enc' }) // only the token this run used
    // both rows stay pending (no status change): they wait for a new key
    expect(updates.filter((u) => u.table === 'meta_capi_events').every((u) => u.patch.status === undefined)).toBe(true)
  })

  it('cancels (never sends) an anonymized, deleted or non-Meta contact', async () => {
    const send = vi.fn<(a: unknown) => Promise<SendOutcome>>(async () => ok)
    const { db, updates } = fakeDb([
      claimed({ id: 'x1', contact_anonymized: true }),
      claimed({ id: 'x2', contact_id: null }),
      claimed({ id: 'x3', origin_channel: 'whatsapp_qr', origin_click_id_type: null }),
    ])
    const s = await run(db, send)
    expect(send).not.toHaveBeenCalled()
    expect(s.cancelled).toBe(3)
    expect(updates.every((u) => u.patch.status === 'cancelled')).toBe(true)
  })

  it('a missing WABA or channel row is a failure an admin can fix (retry), not a cancel', async () => {
    const send = vi.fn<(a: unknown) => Promise<SendOutcome>>(async () => ok)
    const { db, updates } = fakeDb([claimed({ waba_id: null })])
    const s = await run(db, send)
    expect(send).not.toHaveBeenCalled()
    expect(s).toMatchObject({ failed: 1, cancelled: 0 })
    expect(updates[0].patch).toMatchObject({ status: 'failed', last_error: expect.stringMatching(/WhatsApp/) })
  })

  it('counts and logs a status update that errors or matches no row (lease lost), without personal data', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const a = await run(fakeDb([claimed()], null, { updateError: { code: '42501' } }).db, async () => ok)
    expect(a.errors).toBe(1)
    const b = await run(fakeDb([claimed()], null, { matches: () => 0 }).db, async () => ok)
    expect(b.errors).toBe(1)
    const lines = log.mock.calls.map((c) => c.join(' ')).join(' | ')
    expect(lines).toMatch(/event e1/)
    expect(lines).toMatch(/42501/)
    expect(lines).not.toMatch(/5511900001111|CTWA/)
    log.mockRestore()
  })

  it('stops on the lease time budget and releases the rest (claimed_until null, nothing sent)', async () => {
    let t = NOW.getTime()
    const send = vi.fn<(a: unknown) => Promise<SendOutcome>>(async () => {
      t += 95_000 // each send eats most of a 120 s lease: after the first, less than 30 s are left
      return ok
    })
    const { db, updates } = fakeDb([claimed({ id: 'a' }), claimed({ id: 'b' }), claimed({ id: 'c' })])
    const s = await processCapiBatch({ db, now: () => new Date(t), decryptToken: () => 'T', send: send as never })
    expect(send).toHaveBeenCalledTimes(1)
    expect(s).toMatchObject({ sent: 1, released: 2 })
    const released = updates.filter((u) => u.filters.id !== 'a')
    expect(released).toHaveLength(2)
    expect(released.every((u) => u.patch.claimed_until === null && u.patch.status === undefined)).toBe(true)
  })

  it('error 1 and 2 from Meta are retried', async () => {
    expect(explainMetaError(1, 500).retryable).toBe(true)
    expect(explainMetaError(2, 500).retryable).toBe(true)
  })

  it('fails events older than 7 days without calling Meta', async () => {
    const send = vi.fn<(a: unknown) => Promise<SendOutcome>>(async () => ok)
    const { db } = fakeDb([claimed({ occurred_at: '2026-11-01T00:00:00Z' })])
    const s = await run(db, send)
    expect(send).not.toHaveBeenCalled()
    expect(s.failed).toBe(1)
  })

  it('a token that cannot be decrypted fails with a short message', async () => {
    const { db, updates } = fakeDb([claimed()])
    const s = await processCapiBatch({
      db,
      now: () => NOW,
      decryptToken: () => {
        throw new Error('bad')
      },
      send: vi.fn() as never,
    })
    expect(s.failed).toBe(1)
    expect(updates[0].patch.last_error).toMatch(/chave de acesso/)
  })

  it('throws when the claim itself fails (the route answers 500)', async () => {
    const { db } = fakeDb([], { code: '42501' })
    await expect(run(db, async () => ok)).rejects.toThrow(/meta_capi_claim failed/)
  })
})

describe('sendCapiEvents (fetch mocked, never the real Meta)', () => {
  const body = { data: [{ event_name: 'Lead' }] }
  const respond = (status: number, json: unknown) => async () => new Response(JSON.stringify(json), { status })

  it('posts to graph v27.0 with a bearer token, token never in the url or body', async () => {
    const f = vi.fn(respond(200, { events_received: 1 }))
    const r = await sendCapiEvents({ datasetId: '999', token: 'SECRET-TOKEN', body, fetchImpl: f })
    expect(r.ok).toBe(true)
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://graph.facebook.com/v27.0/999/events')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer SECRET-TOKEN')
    expect(String(init.body)).not.toContain('SECRET-TOKEN')
    expect(url).not.toContain('SECRET-TOKEN')
  })

  it('maps Meta errors to short Portuguese texts and flags retryable ones', async () => {
    expect(await sendCapiEvents({ datasetId: '1', token: 't', body, fetchImpl: respond(400, { error: { code: 190, message: 'raw secret detail' } }) })).toMatchObject({
      ok: false, code: 190, retryable: false, error: expect.stringMatching(/chave de acesso/),
    })
    const down = await sendCapiEvents({ datasetId: '1', token: 't', body, fetchImpl: respond(503, {}) })
    expect(down).toMatchObject({ ok: false, retryable: true })
    expect(JSON.stringify(down)).not.toContain('raw secret detail')
    expect(explainMetaError(4, 400).retryable).toBe(true)
  })

  it('network error and timeout are retryable', async () => {
    const r = await sendCapiEvents({ datasetId: '1', token: 't', body, fetchImpl: async () => { throw new Error('ECONNRESET') } })
    expect(r).toMatchObject({ ok: false, retryable: true })
  })
})
