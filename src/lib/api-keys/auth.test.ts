import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it } from 'vitest'

import { __resetRateLimitForTests } from '@/lib/rate-limit'

import { API_BAD_KEY_RATE_LIMIT, API_KEY_RATE_LIMIT, __resetLastTouchedForTests, authenticateApiKey } from './auth'
import { generateApiKey } from './keys'

const NOW = new Date('2026-10-01T12:00:00Z')

function setup(row: Partial<{ scopes: string[]; revoked_at: string | null; expires_at: string | null }> | null) {
  const gen = generateApiKey()
  const updates: Record<string, unknown>[] = []
  const lookups: unknown[] = []
  const db = {
    from: () => ({
      select: () => ({
        eq: (_c: string, hash: string) => ({
          maybeSingle: async () => {
            lookups.push(hash)
            return {
              data:
                row && hash === gen.hash
                  ? { id: 'k1', account_id: 'acc1', scopes: ['messages:send'], revoked_at: null, expires_at: null, last_used_at: null, ...row }
                  : null,
              error: null,
            }
          },
        }),
      }),
      update: (p: Record<string, unknown>) => ({
        eq: () => {
          updates.push(p)
          return Promise.resolve({ error: null })
        },
      }),
    }),
  } as unknown as SupabaseClient
  const req = (key: string | null = gen.key) =>
    new Request('https://app.test/api/v1/me', {
      headers: key ? { authorization: `Bearer ${key}`, 'x-forwarded-for': '203.0.113.9' } : { 'x-forwarded-for': '203.0.113.9' },
    })
  return { gen, db, updates, lookups, req }
}

async function body(res: Response) {
  return (await res.json()) as { error: { code: string } }
}

describe('authenticateApiKey', () => {
  beforeEach(() => {
    __resetRateLimitForTests()
    __resetLastTouchedForTests()
  })

  it('accepts a valid key and resolves the account', async () => {
    const t = setup({})
    const r = await authenticateApiKey(t.req(), 'messages:send', { db: t.db, now: () => NOW })
    expect(r.ok && r.ctx).toEqual({ keyId: 'k1', accountId: 'acc1', scopes: ['messages:send'] })
  })

  it('looks the key up by hash, never by plaintext', async () => {
    const t = setup({})
    await authenticateApiKey(t.req(), null, { db: t.db, now: () => NOW })
    expect(t.lookups).toEqual([t.gen.hash])
    expect(t.lookups[0]).not.toBe(t.gen.key)
  })

  it('401 without a header, with a malformed key or an unknown key', async () => {
    const t = setup({})
    for (const [req, code] of [
      [t.req(null), 'missing_api_key'],
      [t.req('nope'), 'missing_api_key'],
      [t.req(generateApiKey().key), 'invalid_api_key'],
    ] as const) {
      const r = await authenticateApiKey(req, null, { db: t.db, now: () => NOW })
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.response.status).toBe(401)
        expect((await body(r.response)).error.code).toBe(code)
        expect(r.response.headers.get('www-authenticate')).toBe('Bearer')
      }
    }
  })

  it('401 for revoked keys and for keys past their rotation grace period', async () => {
    for (const [row, code] of [
      [{ revoked_at: '2026-09-30T00:00:00Z' }, 'api_key_revoked'],
      [{ expires_at: '2026-10-01T11:59:59Z' }, 'api_key_expired'],
    ] as const) {
      const t = setup(row)
      const r = await authenticateApiKey(t.req(), null, { db: t.db, now: () => NOW })
      expect(!r.ok && r.response.status).toBe(401)
      expect(!r.ok && (await body(r.response)).error.code).toBe(code)
    }
  })

  it('still accepts an old key inside its grace period', async () => {
    const t = setup({ expires_at: '2026-10-02T12:00:00Z' })
    expect((await authenticateApiKey(t.req(), null, { db: t.db, now: () => NOW })).ok).toBe(true)
  })

  it('403 when the key lacks the scope', async () => {
    const t = setup({ scopes: ['contacts:read'] })
    const r = await authenticateApiKey(t.req(), 'messages:send', { db: t.db, now: () => NOW })
    expect(!r.ok && r.response.status).toBe(403)
    expect(!r.ok && (await body(r.response)).error.code).toBe('insufficient_scope')
  })

  it('429 with Retry-After once the per-key budget is spent', async () => {
    const t = setup({})
    for (let i = 0; i < API_KEY_RATE_LIMIT.limit; i++) {
      expect((await authenticateApiKey(t.req(), null, { db: t.db, now: () => NOW })).ok).toBe(true)
    }
    const r = await authenticateApiKey(t.req(), null, { db: t.db, now: () => NOW })
    expect(!r.ok && r.response.status).toBe(429)
    expect(!r.ok && Number(r.response.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('throttles repeated bad keys per IP', async () => {
    const t = setup({})
    let last = 401
    for (let i = 0; i <= API_BAD_KEY_RATE_LIMIT.limit; i++) {
      const r = await authenticateApiKey(t.req(generateApiKey().key), null, { db: t.db, now: () => NOW })
      last = !r.ok ? r.response.status : 200
    }
    expect(last).toBe(429)
  })

  it('records last_used_at, at most once a minute per key', async () => {
    const t = setup({})
    await authenticateApiKey(t.req(), null, { db: t.db, now: () => NOW })
    await authenticateApiKey(t.req(), null, { db: t.db, now: () => new Date(NOW.getTime() + 10_000) })
    expect(t.updates).toEqual([{ last_used_at: NOW.toISOString() }])
    const later = new Date(NOW.getTime() + 61_000)
    await authenticateApiKey(t.req(), null, { db: t.db, now: () => later })
    expect(t.updates).toHaveLength(2)
    expect(t.updates[1]).toEqual({ last_used_at: later.toISOString() })
  })
})
