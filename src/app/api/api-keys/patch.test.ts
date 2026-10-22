import { beforeEach, describe, expect, it, vi } from 'vitest'

type Result = { data?: unknown; error?: { message: string } | null; count?: number }

const h = vi.hoisted(() => ({
  results: {} as Record<string, Result>,
  patches: [] as unknown[],
  filters: [] as [string, unknown][],
}))

vi.mock('@/lib/webhooks/admin-guard', () => ({
  requireAdmin: async () => ({ ctx: { accountId: 'acc', userId: 'u1' } }),
}))
vi.mock('@/lib/webhooks/endpoint-url', () => ({
  validateEndpointUrl: async (u: string) => ({ ok: true, url: u }),
}))

function builder() {
  let op = 'select'
  const b: Record<string, unknown> = {}
  const done = () => h.results[op] ?? { data: null, error: null }
  for (const m of ['is', 'or', 'order', 'limit']) b[m] = () => b
  b.eq = (c: string, v: unknown) => (h.filters.push([c, v]), b)
  b.select = (_c?: string, o?: { head?: boolean }) => {
    if (o?.head) op = 'count'
    return b
  }
  b.insert = () => ((op = 'insert'), b)
  b.update = (p: unknown) => ((op = 'update'), h.patches.push(p), b)
  b.maybeSingle = async () => (op === 'select' ? h.results.current : done())
  b.single = async () => done()
  b.then = (resolve: (v: unknown) => unknown) => resolve(done())
  return b
}
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => ({ from: () => builder() }) }))

import { PATCH } from './[id]/route'
import { POST as createEndpoint } from '../webhooks/endpoints/route'
import { MAX_ENDPOINTS } from '@/lib/webhooks/limits'

const patch = (body: unknown) =>
  PATCH(new Request('https://app.test/api/api-keys/k1', { method: 'PATCH', body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: 'k1' }),
  })

const row = { id: 'k1', name: 'new', note: 'n', scopes: ['messages:send'], allowed_cidrs: null, revoked_at: null, expires_at: null }

describe('PATCH /api/api-keys/[id]', () => {
  beforeEach(() => {
    h.patches = []
    h.filters = []
    h.results = { current: { data: { revoked_at: null, expires_at: null }, error: null }, update: { data: row, error: null } }
  })

  it('edits name and note, scoped to the account', async () => {
    const res = await patch({ name: '  Produção  ', note: ' para o n8n ' })
    expect(res.status).toBe(200)
    expect(h.patches[0]).toEqual({ name: 'Produção', note: 'para o n8n' })
    expect(h.filters).toContainEqual(['account_id', 'acc'])
    expect((await res.json()).key.state).toBe('active')
  })

  it('clears the note and the IP list with empty values; validates IPs like creation', async () => {
    await patch({ note: '', allowed_cidrs: '' })
    expect(h.patches[0]).toEqual({ note: null, allowed_cidrs: null })
    expect((await patch({ allowed_cidrs: '1.2.3.4, nope' })).status).toBe(400)
    await patch({ allowed_cidrs: '203.0.113.7, 198.51.100.0/24' })
    expect(h.patches[1]).toEqual({ allowed_cidrs: ['203.0.113.7/32', '198.51.100.0/24'] })
  })

  it('rejects an empty or oversized name / note, and an empty patch', async () => {
    expect((await patch({ name: '   ' })).status).toBe(400)
    expect((await patch({ name: 'x'.repeat(81) })).status).toBe(400)
    expect((await patch({ note: 'x'.repeat(201) })).status).toBe(400)
    expect((await patch({})).status).toBe(400)
    expect(h.patches).toEqual([])
  })

  it('cannot change permissions or the key through this route', async () => {
    await patch({ name: 'a', scopes: ['contacts:read'], key_hash: 'x', revoked_at: null })
    expect(h.patches[0]).toEqual({ name: 'a' })
  })

  it('404 for a key of another account, 409 for a revoked key', async () => {
    h.results.current = { data: null, error: null }
    expect((await patch({ name: 'a' })).status).toBe(404)
    h.results.current = { data: { revoked_at: '2026-10-01T00:00:00Z', expires_at: null }, error: null }
    expect((await patch({ name: 'a' })).status).toBe(409)
  })
})

describe('POST /api/webhooks/endpoints limit', () => {
  const create = () =>
    createEndpoint(
      new Request('https://app.test/api/webhooks/endpoints', {
        method: 'POST',
        body: JSON.stringify({ url: 'https://hooks.example.com/in', events: ['*'] }),
      }),
    )

  it('allows 16 endpoints per account', async () => {
    expect(MAX_ENDPOINTS).toBe(16)
    h.results = { count: { count: 15 }, insert: { data: { id: 'e1' }, error: null } }
    expect((await create()).status).toBe(201)
    h.results = { count: { count: 16 } }
    expect((await create()).status).toBe(409)
  })
})
