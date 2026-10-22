import { beforeEach, describe, expect, it, vi } from 'vitest'

type Result = { data?: unknown; error?: { message: string } | null; count?: number }

const h = vi.hoisted(() => ({
  results: {} as Record<string, Result>,
  calls: [] as { table: string; op: string }[],
}))

vi.mock('@/lib/webhooks/admin-guard', () => ({
  requireAdmin: async () => ({ ctx: { accountId: 'acc', userId: 'u1' } }),
}))

/** Chainable stand-in: every method returns the builder; the result is picked by operation. */
function builder(table: string) {
  let op = 'select'
  const b: Record<string, unknown> = {}
  const done = () => {
    h.calls.push({ table, op })
    return h.results[op] ?? { data: null, error: null }
  }
  for (const m of ['eq', 'is', 'or', 'order', 'limit']) b[m] = () => b
  b.select = (_c?: string, o?: { head?: boolean }) => {
    if (o?.head) op = 'count'
    return b
  }
  b.insert = () => ((op = 'insert'), b)
  b.update = () => ((op = 'update'), b)
  b.delete = () => ((op = 'delete'), b)
  b.maybeSingle = async () => done()
  b.single = async () => done()
  b.then = (resolve: (v: unknown) => unknown) => resolve(done())
  return b
}
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => ({ from: (t: string) => builder(t) }) }))

import { POST as rotate } from './[id]/rotate/route'
import { POST as create } from './route'

const old = { id: 'k1', name: 'n8n', note: null, scopes: ['messages:send'], allowed_cidrs: null, revoked_at: null, expires_at: null }
const created = { id: 'k2', name: 'n8n', key_prefix: 'scrm_live_ab', key_last4: 'wxyz', scopes: ['messages:send'] }
const call = (body: unknown) =>
  rotate(new Request('https://app.test/api/api-keys/k1/rotate', { method: 'POST', body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: 'k1' }),
  })

describe('POST /api/api-keys/[id]/rotate', () => {
  beforeEach(() => {
    h.calls = []
    h.results = {
      select: { data: old, error: null },
      count: { count: 3 },
      insert: { data: created, error: null },
      update: { data: { id: 'k1' }, error: null },
      delete: { data: null, error: null },
    }
  })

  it('rotates, returns the plaintext once and forbids caching', async () => {
    const res = await call({ grace_hours: 24 })
    expect(res.status).toBe(201)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect((await res.json()).secret).toMatch(/^scrm_live_/)
  })

  it('refuses to rotate a key that is already in its grace period (would extend the old key)', async () => {
    h.results.select = { data: { ...old, expires_at: new Date(Date.now() + 3600_000).toISOString() }, error: null }
    const res = await call({ grace_hours: 24 })
    expect(res.status).toBe(409)
    expect(h.calls.some((c) => c.op === 'insert')).toBe(false)
  })

  it('applies the active-key limit when the old key stays alive, not for an immediate swap', async () => {
    h.results.count = { count: 20 }
    expect((await call({ grace_hours: 24 })).status).toBe(409)
    expect((await call({ grace_hours: 0 })).status).toBe(201)
  })

  it('removes the new key again when the old key cannot be updated (no half-rotated state)', async () => {
    h.results.update = { data: null, error: { message: 'db down' } }
    const res = await call({ grace_hours: 0 })
    expect(res.status).toBe(500)
    expect(h.calls.map((c) => c.op)).toContain('delete')
  })
})

describe('POST /api/api-keys', () => {
  it('counts only keys that still authenticate and answers with no-store', async () => {
    h.results = { count: { count: 0 }, insert: { data: created, error: null } }
    const res = await create(new Request('https://app.test/api/api-keys', { method: 'POST', body: JSON.stringify({ name: 'n8n', scopes: ['messages:send'] }) }))
    expect(res.status).toBe(201)
    expect(res.headers.get('cache-control')).toBe('no-store')
    h.results = { count: { count: 20 } }
    const full = await create(new Request('https://app.test/api/api-keys', { method: 'POST', body: JSON.stringify({ name: 'x', scopes: ['messages:send'] }) }))
    expect(full.status).toBe(409)
  })
})
