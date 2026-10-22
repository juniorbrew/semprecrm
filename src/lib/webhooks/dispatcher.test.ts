import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'

import {
  buildEventBody,
  deliverClaimed,
  readSnippet,
  runDispatch,
  sendWebhookRequest,
  type ClaimedDelivery,
  type SendFn,
} from './dispatcher'
import { WEBHOOK_TEST_EVENT } from './events'
import { MAX_ATTEMPTS } from './retry'
import { SIGNATURE_HEADER, verifySignatureHeader } from './signing'

const NOW = new Date('2026-10-01T12:00:00Z')
const now = () => NOW
const identity = (s: string) => s

function claimed(over: Partial<ClaimedDelivery> = {}): ClaimedDelivery {
  return {
    delivery_id: 'd1',
    attempts: 0,
    delivery_created_at: NOW.toISOString(),
    event_id: '11111111-2222-3333-4444-555555555555',
    event_type: 'message.received',
    event_data: { id: 'm1', text: 'oi' },
    event_created_at: NOW.toISOString(),
    account_id: 'acc1',
    endpoint_id: 'e1',
    url: 'https://hooks.example.com/in',
    secret_enc: 'whsec_current',
    previous_secret_enc: null,
    previous_secret_expires_at: null,
    failing_since: null,
    ...over,
  }
}

/**
 * In-memory stand-in for the tables + the claim RPC. The RPC mirrors the SQL:
 * only pending rows whose lease is free, leased on the way out.
 */
function fakeDb(rows: ClaimedDelivery[]) {
  const state = new Map(rows.map((r) => [r.delivery_id, { row: r, status: 'pending', leaseUntil: 0 }]))
  const writes = {
    attempts: [] as Record<string, unknown>[],
    deliveries: [] as { id: unknown; patch: Record<string, unknown> }[],
    endpoints: [] as { id: unknown; patch: Record<string, unknown> }[],
  }
  const db = {
    rpc: async (_fn: string, args: { p_limit: number; p_lease_seconds: number; p_delivery_id: string | null }) => {
      const out: ClaimedDelivery[] = []
      for (const s of state.values()) {
        if (out.length >= args.p_limit) break
        if (args.p_delivery_id && s.row.delivery_id !== args.p_delivery_id) continue
        if (s.status !== 'pending' || s.leaseUntil > NOW.getTime()) continue
        s.leaseUntil = NOW.getTime() + args.p_lease_seconds * 1000
        out.push(s.row)
      }
      return { data: out, error: null }
    },
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        if (table === 'webhook_delivery_attempts') writes.attempts.push(row)
        return { error: null }
      },
      update: (patch: Record<string, unknown>) => ({
        eq: async (_col: string, id: unknown) => {
          if (table === 'webhook_deliveries') {
            writes.deliveries.push({ id, patch })
            const s = state.get(id as string)
            if (s && typeof patch.status === 'string') s.status = patch.status
          }
          if (table === 'webhook_endpoints') writes.endpoints.push({ id, patch })
          return { error: null }
        },
      }),
    }),
  }
  return { db: db as unknown as SupabaseClient, writes }
}

const ok: SendFn = async () => ({ statusCode: 200, error: null, snippet: 'ok', durationMs: 5 })
const fail: SendFn = async () => ({ statusCode: 500, error: null, snippet: 'boom', durationMs: 5 })

describe('deliverClaimed', () => {
  it('posts a signed Stripe-style event and marks the delivery delivered', async () => {
    const { db, writes } = fakeDb([])
    let seen: { url: string; body: string; headers: Record<string, string> } | undefined
    const send: SendFn = async (url, body, headers) => {
      seen = { url, body, headers }
      return ok(url, body, headers)
    }
    const out = await deliverClaimed({ db, now, send, decryptSecret: identity }, claimed())
    expect(out).toBe('delivered')

    const payload = JSON.parse(seen!.body)
    expect(payload).toMatchObject({
      id: 'evt_11111111222233334444555555555555',
      object: 'event',
      type: 'message.received',
      account_id: 'acc1',
      data: { object: { id: 'm1', text: 'oi' } },
    })
    expect(seen!.headers['SempreCRM-Event-Id']).toBe(payload.id)
    expect(seen!.headers['SempreCRM-Attempt']).toBe('1')
    expect(
      verifySignatureHeader({
        header: seen!.headers[SIGNATURE_HEADER],
        rawBody: seen!.body,
        secrets: ['whsec_current'],
        nowSeconds: Math.floor(NOW.getTime() / 1000),
      }).ok,
    ).toBe(true)

    expect(writes.attempts[0]).toMatchObject({ delivery_id: 'd1', attempt_no: 1, status_code: 200, error: null })
    expect(writes.deliveries[0].patch).toMatchObject({ status: 'delivered', attempts: 1, claimed_until: null })
  })

  it('signs with both secrets while the previous one is inside its overlap window', async () => {
    const { db } = fakeDb([])
    const headers: Record<string, string>[] = []
    const send: SendFn = async (u, b, h) => (headers.push(h), ok(u, b, h))
    const base = { previous_secret_enc: 'whsec_old' }
    await deliverClaimed(
      { db, now, send, decryptSecret: identity },
      claimed({ ...base, previous_secret_expires_at: new Date(NOW.getTime() + 3600_000).toISOString() }),
    )
    await deliverClaimed(
      { db, now, send, decryptSecret: identity },
      claimed({ ...base, previous_secret_expires_at: new Date(NOW.getTime() - 1000).toISOString() }),
    )
    expect(headers[0][SIGNATURE_HEADER].match(/v1=/g)).toHaveLength(2)
    expect(headers[1][SIGNATURE_HEADER].match(/v1=/g)).toHaveLength(1)
  })

  it('schedules a retry on a non-2xx and starts the endpoint failure clock', async () => {
    const { db, writes } = fakeDb([])
    const out = await deliverClaimed({ db, now, send: fail, rand: () => 0.5, decryptSecret: identity }, claimed())
    expect(out).toBe('retrying')
    expect(writes.deliveries[0].patch).toMatchObject({
      status: 'pending',
      attempts: 1,
      last_status_code: 500,
      last_error: 'HTTP 500',
      next_attempt_at: new Date(NOW.getTime() + 60_000).toISOString(),
    })
    expect(writes.endpoints[0].patch).toEqual({ failing_since: NOW.toISOString() })
  })

  it('marks the delivery failed after the last attempt', async () => {
    const { db, writes } = fakeDb([])
    const out = await deliverClaimed(
      { db, now, send: fail, decryptSecret: identity },
      claimed({ attempts: MAX_ATTEMPTS - 1 }),
    )
    expect(out).toBe('failed')
    expect(writes.deliveries[0].patch).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS })
  })

  it('disables the endpoint once it has been failing for 48h', async () => {
    const { db, writes } = fakeDb([])
    const since = new Date(NOW.getTime() - 49 * 3600_000).toISOString()
    await deliverClaimed({ db, now, send: fail, decryptSecret: identity }, claimed({ failing_since: since }))
    expect(writes.endpoints[0].patch).toMatchObject({ enabled: false, disabled_reason: 'auto_failures' })
  })

  it('does not disable an endpoint that started failing recently', async () => {
    const { db, writes } = fakeDb([])
    const since = new Date(NOW.getTime() - 3600_000).toISOString()
    await deliverClaimed({ db, now, send: fail, decryptSecret: identity }, claimed({ failing_since: since }))
    expect(writes.endpoints).toHaveLength(0)
  })

  it('clears the failure clock on success', async () => {
    const { db, writes } = fakeDb([])
    const since = new Date(NOW.getTime() - 3600_000).toISOString()
    await deliverClaimed({ db, now, send: ok, decryptSecret: identity }, claimed({ failing_since: since }))
    expect(writes.endpoints[0].patch).toEqual({ failing_since: null })
  })

  it('test events are one-shot and never touch endpoint health', async () => {
    const { db, writes } = fakeDb([])
    const out = await deliverClaimed(
      { db, now, send: fail, decryptSecret: identity },
      claimed({ event_type: WEBHOOK_TEST_EVENT }),
    )
    expect(out).toBe('failed')
    expect(writes.endpoints).toHaveLength(0)
  })

  it('treats a network error as a failed attempt and records it', async () => {
    const { db, writes } = fakeDb([])
    const send: SendFn = async () => ({ statusCode: null, error: 'Timeout after 10s', snippet: null, durationMs: 10_000 })
    expect(await deliverClaimed({ db, now, send, decryptSecret: identity }, claimed())).toBe('retrying')
    expect(writes.attempts[0]).toMatchObject({ status_code: null, error: 'Timeout after 10s' })
  })
})

describe('runDispatch claim', () => {
  it('delivers every row exactly once when two ticks overlap', async () => {
    const rows = Array.from({ length: 7 }, (_, i) => claimed({ delivery_id: `d${i}` }))
    const { db } = fakeDb(rows)
    const sent: string[] = []
    const send: SendFn = async (u, b, h) => {
      sent.push(h['SempreCRM-Delivery-Id'])
      await new Promise((r) => setTimeout(r, 5))
      return ok(u, b, h)
    }
    const deps = { db, now, send, decryptSecret: identity, accountActive: async () => true }
    const [a, b] = await Promise.all([
      runDispatch(deps, { batchSize: 3, concurrency: 2 }),
      runDispatch(deps, { batchSize: 3, concurrency: 2 }),
    ])
    expect(sent.sort()).toEqual(rows.map((r) => r.delivery_id).sort())
    expect(a.delivered + b.delivered).toBe(7)
    expect(a.claimed + b.claimed).toBe(7)
  })

  it('a slow endpoint holds one worker, not a whole chunk of the batch', async () => {
    const rows = ['slow', 'b', 'c', 'd', 'e', 'f'].map((id) => claimed({ delivery_id: id }))
    const { db } = fakeDb(rows)
    const finished: string[] = []
    const send: SendFn = async (u, b, h) => {
      const id = h['SempreCRM-Delivery-Id']
      if (id === 'slow') await new Promise((r) => setTimeout(r, 80))
      finished.push(id)
      return ok(u, b, h)
    }
    await runDispatch({ db, now, send, decryptSecret: identity, accountActive: async () => true }, { concurrency: 3, batchSize: 10 })
    expect(finished).toHaveLength(6)
    // with fixed chunks of 3, d/e/f would have waited for "slow"
    expect(finished[finished.length - 1]).toBe('slow')
  })

  it('asks the database for at most 10 rows per account per call', async () => {
    const calls: Record<string, unknown>[] = []
    const db = { rpc: async (_f: string, a: Record<string, unknown>) => (calls.push(a), { data: [], error: null }) } as unknown as SupabaseClient
    await runDispatch({ db, now, accountActive: async () => true })
    expect(calls[0]).toMatchObject({ p_limit: 40, p_per_account: 10 })
  })

  it('does not claim a delivery that is already done', async () => {
    const { db } = fakeDb([claimed()])
    const first = await runDispatch({ db, now, send: ok, decryptSecret: identity, accountActive: async () => true }, { deliveryId: 'd1' })
    expect(first.delivered).toBe(1)
    const again = await runDispatch({ db, now, send: ok, decryptSecret: identity, accountActive: async () => true })
    expect(again.claimed).toBe(0)
  })

  it('counts a crashed delivery and keeps going', async () => {
    const { db } = fakeDb([claimed({ delivery_id: 'a' }), claimed({ delivery_id: 'b' })])
    const boom = (s: string) => {
      if (s === 'whsec_current') throw new Error('bad key')
      return s
    }
    const out = await runDispatch({ db, now, send: ok, decryptSecret: boom, accountActive: async () => true })
    expect(out.errors).toBe(2)
  })
})

describe('blocked accounts', () => {
  it('holds the delivery for an hour without sending or counting an attempt', async () => {
    const { db, writes } = fakeDb([])
    let sends = 0
    const send: SendFn = async (u, b, h) => (sends++, ok(u, b, h))
    const out = await deliverClaimed({ db, now, send, decryptSecret: identity, accountActive: async () => false }, claimed())
    expect(out).toBe('held')
    expect(sends).toBe(0)
    expect(writes.attempts).toHaveLength(0)
    expect(writes.deliveries[0].patch).toEqual({ claimed_until: null, next_attempt_at: new Date(NOW.getTime() + 3600_000).toISOString() })
  })

  it('fails a held delivery once it is past the 72h horizon', async () => {
    const { db, writes } = fakeDb([])
    const old = claimed({ delivery_created_at: new Date(NOW.getTime() - 73 * 3600_000).toISOString() })
    expect(await deliverClaimed({ db, now, send: ok, decryptSecret: identity, accountActive: async () => false }, old)).toBe('held')
    expect(writes.deliveries[0].patch).toMatchObject({ status: 'failed' })
  })

  it('runDispatch looks the plan up once per account and treats an unreadable plan as blocked', async () => {
    const rows = [claimed({ delivery_id: 'a' }), claimed({ delivery_id: 'b' })]
    const { db } = fakeDb(rows)
    let sends = 0
    const send: SendFn = async (u, b, h) => (sends++, ok(u, b, h))
    // the fake client has no accounts table: the real check fails closed
    const out = await runDispatch({ db, now, send, decryptSecret: identity })
    expect(sends).toBe(0)
    expect(out.errors + out.held).toBe(2)
  })
})

describe('response snippet', () => {
  const res = (body: string, type: string) => new Response(body, { headers: { 'content-type': type } })
  it('keeps at most 256 bytes of text / JSON', async () => {
    expect(await readSnippet(res('{"ok":true}', 'application/json'))).toBe('{"ok":true}')
    expect(await readSnippet(res('x'.repeat(5000), 'text/plain; charset=utf-8'))).toHaveLength(256)
    expect(await readSnippet(res('{"a":1}', 'application/problem+json'))).toBe('{"a":1}')
  })
  it('drops HTML, binaries and bodies without a content type (nothing to read back from internal pages)', async () => {
    expect(await readSnippet(res('<html>secret</html>', 'text/html; charset=utf-8'))).toBeNull()
    expect(await readSnippet(res('PK', 'application/zip'))).toBeNull()
    expect(await readSnippet(new Response(new Uint8Array([104, 105])))).toBeNull()
  })
})

describe('delivery destination rules', () => {
  it.each(['https://hooks.example.com:8443/x', 'http://hooks.example.com/x', 'not a url'])('refuses %s without connecting', async (url) => {
    const r = await sendWebhookRequest(url, '{}', {})
    expect(r.statusCode).toBeNull()
    expect(r.error).toMatch(/not allowed/i)
  })
})

describe('SSRF guard on delivery', () => {
  it.each([
    'https://127.0.0.1/hook',
    'https://169.254.169.254/latest/meta-data',
    'https://10.0.0.5/x',
    'https://[::1]/x',
    'http://192.168.1.1/x',
  ])('never connects to %s', async (url) => {
    const r = await sendWebhookRequest(url, '{}', {})
    expect(r.statusCode).toBeNull()
    expect(r.error).toMatch(/not allowed/i)
  })

  it('a blocked destination is a failed attempt that will be retried', async () => {
    const { db, writes } = fakeDb([])
    const out = await deliverClaimed(
      { db, now, decryptSecret: identity, rand: () => 0.5 },
      claimed({ url: 'https://127.0.0.1/hook' }),
    )
    expect(out).toBe('retrying')
    expect(writes.attempts[0].error).toMatch(/not allowed/i)
  })
})

describe('buildEventBody', () => {
  it('is stable for the same event (dedupe id) and carries unix time', () => {
    const row = claimed()
    expect(buildEventBody(row)).toBe(buildEventBody({ ...row }))
    expect(JSON.parse(buildEventBody(row)).created).toBe(Math.floor(NOW.getTime() / 1000))
  })
})
