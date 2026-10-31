import { beforeEach, describe, expect, it, vi } from 'vitest'

// The idempotency hash of an Instagram / Messenger send uses `to` as given (an id is not a phone and
// must not go through the phone normaliser); WhatsApp keeps hashing the digits only.

const h = vi.hoisted(() => ({ hashed: [] as Record<string, unknown>[] }))

vi.mock('@/lib/api-keys/auth', async (orig) => ({
  ...(await orig<typeof import('@/lib/api-keys/auth')>()),
  authenticateApiKey: async () => ({ ok: true, ctx: { keyId: 'key1', accountId: 'acc', scopes: ['messages:send'], ip: null }, rate: {} }),
  respondLogged: (_c: unknown, _r: unknown, res: Response) => res,
}))
vi.mock('@/lib/api-keys/idempotency', async (orig) => {
  const real = await orig<typeof import('@/lib/api-keys/idempotency')>()
  return {
    ...real,
    requestHash: (input: Record<string, unknown>) => (h.hashed.push(input), real.requestHash(input)),
    // The claim store is not under test: run the handler straight away.
    runIdempotent: async (_db: unknown, _claim: unknown, run: () => Promise<unknown>) => ({ kind: 'done', outcome: await run() }),
  }
})
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => ({}) }))

import { POST } from './messages/route'

const post = (body: Record<string, unknown>) =>
  POST(new Request('https://app.test/api/v1/messages', { method: 'POST', headers: { 'Idempotency-Key': 'k1' }, body: JSON.stringify(body) })).catch(() => null)

beforeEach(() => {
  h.hashed = []
})

describe('POST /api/v1/messages idempotency hash', () => {
  it('Instagram / Messenger: `to` is hashed raw', async () => {
    await post({ to: '17841400000000001', text: 'oi', channel: 'instagram' })
    await post({ to: '5001234567890', text: 'oi', channel: 'messenger' })
    expect(h.hashed.map((x) => x.to)).toEqual(['17841400000000001', '5001234567890'])
    // not normalised: a value that the phone normaliser would change stays distinct
    await post({ to: '+1784 14', text: 'oi', channel: 'instagram' })
    expect(h.hashed[2].to).toBe('+1784 14')
  })

  it('WhatsApp: the phone is normalised to digits as before', async () => {
    await post({ to: '+55 (11) 99999-0000', text: 'oi' })
    await post({ to: '+55 (11) 99999-0000', text: 'oi', channel: 'qr' })
    expect(h.hashed.map((x) => x.to)).toEqual(['5511999990000', '5511999990000'])
  })
})
