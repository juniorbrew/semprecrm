import { describe, expect, it } from 'vitest'

import { STATE_MAX_AGE_MS, signState, verifyState } from './state'

const KEY = 'ab'.repeat(32)
const NOW = Date.parse('2026-09-14T12:00:00Z')

describe('OAuth state (HMAC-SHA256 over user + nonce + timestamp)', () => {
  it('round-trips and carries the user, provider and nonce', () => {
    const state = signState({ userId: 'user-1', provider: 'google', nonce: 'n0nce', now: NOW }, KEY)
    expect(state).toMatch(/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/)
    const parsed = verifyState(state, { provider: 'google', now: NOW + 1000, secret: KEY })
    expect(parsed).toEqual({ userId: 'user-1', provider: 'google', nonce: 'n0nce', issuedAt: NOW })
  })

  it('rejects a tampered payload or signature', () => {
    const state = signState({ userId: 'user-1', provider: 'google', now: NOW }, KEY)
    const [payload, sig] = state.split('.')
    const flipped = (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1)
    expect(verifyState(`${payload}.${flipped}`, { provider: 'google', now: NOW, secret: KEY })).toBeNull()
    const other = Buffer.from(JSON.stringify({ u: 'user-2', p: 'google', n: 'x', t: NOW }), 'utf8').toString('base64url')
    expect(verifyState(`${other}.${sig}`, { provider: 'google', now: NOW, secret: KEY })).toBeNull()
    // Signed with a different key.
    const foreign = signState({ userId: 'user-1', provider: 'google', now: NOW }, 'cd'.repeat(32))
    expect(verifyState(foreign, { provider: 'google', now: NOW, secret: KEY })).toBeNull()
  })

  it('expires after STATE_MAX_AGE_MS and refuses a future stamp', () => {
    const state = signState({ userId: 'user-1', provider: 'microsoft', now: NOW }, KEY)
    expect(verifyState(state, { provider: 'microsoft', now: NOW + STATE_MAX_AGE_MS - 1, secret: KEY })).not.toBeNull()
    expect(verifyState(state, { provider: 'microsoft', now: NOW + STATE_MAX_AGE_MS + 1, secret: KEY })).toBeNull()
    expect(verifyState(state, { provider: 'microsoft', now: NOW - 120_000, secret: KEY })).toBeNull()
  })

  it('binds the state to the provider whose callback verifies it', () => {
    const state = signState({ userId: 'user-1', provider: 'google', now: NOW }, KEY)
    expect(verifyState(state, { provider: 'microsoft', now: NOW, secret: KEY })).toBeNull()
  })

  it('returns null for garbage without throwing', () => {
    for (const bad of [null, undefined, '', 'abc', 'abc.def', '.'.repeat(3), 'x'.repeat(3000)]) {
      expect(verifyState(bad, { provider: 'google', now: NOW, secret: KEY })).toBeNull()
    }
  })
})
