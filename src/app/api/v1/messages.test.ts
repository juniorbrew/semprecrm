import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  update: { data: [{ key: 'k1' }], error: null } as { data?: unknown; error?: { message: string } | null },
  ops: [] as string[],
  providerCalled: false,
  claimIds: [] as (string | undefined)[],
}))

vi.mock('@/lib/api-keys/auth', async (orig) => ({
  ...(await orig<typeof import('@/lib/api-keys/auth')>()),
  authenticateApiKey: async () => ({ ok: true, ctx: { keyId: 'key1', accountId: 'acc', scopes: ['messages:send'], ip: null }, rate: {} }),
  respondLogged: (_c: unknown, _r: unknown, res: Response) => res,
}))

function builder() {
  let op = 'select'
  const b: Record<string, unknown> = {}
  const done = () => {
    h.ops.push(op)
    if (op === 'update') return { data: null, error: null, ...h.update }
    if (op === 'delete') return { data: [{ key: 'k1' }], error: null }
    return { data: null, error: null }
  }
  for (const m of ['eq', 'is', 'or', 'select', 'limit']) b[m] = () => b
  b.insert = () => ((op = 'insert'), b)
  b.update = () => ((op = 'update'), b)
  b.delete = () => ((op = 'delete'), b)
  b.then = (resolve: (v: unknown) => unknown) => resolve(done())
  return b
}
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => ({ from: () => builder() }) }))
vi.mock('@/lib/api-keys/send-message', async (orig) => ({
  ...(await orig<typeof import('@/lib/api-keys/send-message')>()),
  sendTextViaApi: async (
    _db: unknown,
    input: { claimId?: string; onBeforeSend?: (i: { conversationId: string; contactId: string; channel: 'official' }) => Promise<void> },
  ) => {
    h.claimIds.push(input.claimId)
    await input.onBeforeSend?.({ conversationId: 'conv1', contactId: 'c1', channel: 'official' })
    h.providerCalled = true
    return { message_id: 'm1', conversation_id: 'conv1', contact_id: 'c1', channel: 'official', whatsapp_message_id: 'w1' }
  },
}))

import { POST } from './messages/route'

const post = (headers: Record<string, string> = { 'Idempotency-Key': 'k1' }) =>
  POST(new Request('https://app.test/api/v1/messages', { method: 'POST', headers, body: JSON.stringify({ to: '5511999990000', text: 'oi' }) }))

describe('POST /api/v1/messages with Idempotency-Key', () => {
  beforeEach(() => {
    h.update = { data: [{ key: 'k1' }], error: null }
    h.ops = []
    h.providerCalled = false
    h.claimIds = []
  })

  it('records the send target on the claim, then sends with the claim id', async () => {
    const res = await post()
    expect(res.status).toBe(201)
    expect(h.providerCalled).toBe(true)
    expect(h.claimIds[0]).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('fails closed: when the target cannot be recorded nothing is sent, the key is released, 503', async () => {
    h.update = { data: null, error: { message: 'db down' } }
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const res = await post()
    expect(res.status).toBe(503)
    expect((await res.json()).error.code).toBe('temporarily_unavailable')
    expect(h.providerCalled).toBe(false)
    expect(h.ops).toContain('delete')
  })

  it('fails closed when the claim was taken over (0 rows updated)', async () => {
    h.update = { data: [], error: null }
    const res = await post()
    expect(res.status).toBe(503)
    expect(h.providerCalled).toBe(false)
  })

  it('without the header there is no claim and no target to record', async () => {
    const res = await post({})
    expect(res.status).toBe(201)
    expect(h.claimIds).toEqual([undefined])
    expect(h.ops).not.toContain('update')
  })
})
