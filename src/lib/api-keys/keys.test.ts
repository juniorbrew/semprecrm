import { describe, expect, it } from 'vitest'

import {
  API_KEY_PREFIX,
  generateApiKey,
  hasScope,
  hashApiKey,
  keyState,
  normalizeScopes,
  parseBearerKey,
} from './keys'

describe('api keys', () => {
  it('generates prefixed, unique keys and stores only a hash', () => {
    const a = generateApiKey()
    expect(a.key).toMatch(/^scrm_live_[A-Za-z0-9_-]{32}$/)
    expect(a.prefix).toBe(a.key.slice(0, API_KEY_PREFIX.length + 4))
    expect(a.last4).toBe(a.key.slice(-4))
    expect(a.hash).toBe(hashApiKey(a.key))
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(a.hash).not.toContain(a.key)
    expect(generateApiKey().key).not.toBe(a.key)
  })

  it('parses only well-formed Bearer headers', () => {
    const { key } = generateApiKey()
    expect(parseBearerKey(`Bearer ${key}`)).toBe(key)
    expect(parseBearerKey(`bearer   ${key}`)).toBe(key)
    for (const bad of [null, undefined, '', key, `Basic ${key}`, `Bearer ${key}x`, 'Bearer scrm_live_short', `Bearer sk_${key}`]) {
      expect(parseBearerKey(bad)).toBeNull()
    }
  })

  it('validates scopes', () => {
    expect(normalizeScopes(['messages:send', 'messages:send'])).toEqual(['messages:send'])
    expect(normalizeScopes([])).toBeNull()
    expect(normalizeScopes(['admin'])).toBeNull()
    expect(normalizeScopes('messages:send')).toBeNull()
    expect(hasScope(['contacts:read'], 'messages:send')).toBe(false)
    expect(hasScope(['contacts:read', 'messages:send'], 'messages:send')).toBe(true)
  })

  it('reports revoked, expired (rotation grace over) and active states', () => {
    const now = new Date('2026-10-01T12:00:00Z')
    expect(keyState({ revoked_at: null, expires_at: null }, now)).toBe('active')
    expect(keyState({ revoked_at: null, expires_at: '2026-10-02T12:00:00Z' }, now)).toBe('active')
    expect(keyState({ revoked_at: null, expires_at: '2026-10-01T12:00:00Z' }, now)).toBe('expired')
    expect(keyState({ revoked_at: '2026-09-01T00:00:00Z', expires_at: null }, now)).toBe('revoked')
  })
})
