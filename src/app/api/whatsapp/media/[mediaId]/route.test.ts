import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ------------------------------------------------------------
// GET /api/whatsapp/media/[mediaId] — session + membership, numeric
// media id before any Graph call, per-user limit, private caching.
// ------------------------------------------------------------

const h = vi.hoisted(() => ({ role: 'viewer' as string | null }))

vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'token' }))

// The token is read with the service role (migration 076).
vi.mock('@/lib/flows/admin-client', () => {
  const b: Record<string, unknown> = {}
  b.select = () => b
  b.eq = () => b
  b.single = async () => ({ data: { access_token: 'enc' }, error: null })
  return { supabaseAdmin: () => ({ from: () => b }) }
})

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>()
  const b: Record<string, unknown> = {}
  b.select = () => b
  b.eq = () => b
  b.single = async () => ({ data: { access_token: 'enc' }, error: null })
  return {
    ...actual,
    requireRole: vi.fn(async () => {
      if (!h.role) throw new actual.UnauthorizedError()
      return { supabase: { from: () => b }, userId: 'user-1', accountId: 'acct-1', role: h.role }
    }),
  }
})

import { __resetRateLimitForTests } from '@/lib/rate-limit'
import { GET } from './route'

const call = (mediaId: string) =>
  GET(new Request(`http://localhost/api/whatsapp/media/${mediaId}`), {
    params: Promise.resolve({ mediaId }),
  })

const fetchMock = vi.fn()

beforeEach(() => {
  h.role = 'viewer'
  __resetRateLimitForTests()
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (url: string) =>
    url.startsWith('https://graph.facebook.com')
      ? new Response(JSON.stringify({ url: 'https://lookaside.fbsbx.com/x', mime_type: 'image/jpeg' }))
      : new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } }),
  )
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('GET /api/whatsapp/media/[mediaId]', () => {
  it('401 without a session, before touching Meta', async () => {
    h.role = null
    expect((await call('1234567890')).status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['abc', '123', '../me', '123?fields=access_token', '1'.repeat(31)])(
    '400 for a non-numeric / malformed id %j, without touching Meta',
    async (id) => {
      expect((await call(id)).status).toBe(400)
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  it('serves the bytes with private caching', async () => {
    const res = await call('1234567890123')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, max-age=86400')
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/1234567890123$/)
  })

  it('429 past the per-user budget', async () => {
    fetchMock.mockImplementation(async () => new Response('x', { status: 500 }))
    let last = 0
    for (let i = 0; i < 301; i++) last = (await call('1234567890')).status
    expect(last).toBe(429)
  })
})
