import { describe, expect, it } from 'vitest'

import {
  hashGatePassword,
  isAcceptableGatePassword,
  normalizeGateUsername,
  signGateToken,
  verifyGatePassword,
  verifyGateToken,
} from './gate-crypto'

describe('gate password hashing', () => {
  it('verifies the password it hashed and rejects others', () => {
    const stored = hashGatePassword('correct horse battery')
    expect(stored.startsWith('scrypt$32768$8$1$')).toBe(true)
    expect(verifyGatePassword('correct horse battery', stored)).toBe(true)
    expect(verifyGatePassword('correct horse batter', stored)).toBe(false)
    expect(verifyGatePassword('', stored)).toBe(false)
  })

  it('salts: two hashes of the same password differ', () => {
    expect(hashGatePassword('same')).not.toBe(hashGatePassword('same'))
  })

  it('rejects malformed stored values instead of throwing', () => {
    expect(verifyGatePassword('x', '')).toBe(false)
    expect(verifyGatePassword('x', 'bcrypt$whatever')).toBe(false)
    expect(verifyGatePassword('x', 'scrypt$abc$8$1$AAAA$BBBB')).toBe(false)
  })
})

describe('gate session token', () => {
  const secret = 's3cret'
  const user = '11111111-2222-3333-4444-555555555555'

  it('round-trips for the same user, generation and secret', () => {
    const token = signGateToken(secret, user, 100, 2000)
    expect(verifyGateToken(secret, token, user, 100, 1999)).toEqual({ userId: user, expiresAtSec: 2000 })
  })

  it('fails when expired, for another user, another generation or another secret', () => {
    const token = signGateToken(secret, user, 100, 2000)
    expect(verifyGateToken(secret, token, user, 100, 2000)).toBeNull()
    expect(verifyGateToken(secret, token, 'other-user', 100, 1)).toBeNull()
    expect(verifyGateToken(secret, token, user, 101, 1)).toBeNull()
    expect(verifyGateToken('nope', token, user, 100, 1)).toBeNull()
  })

  it('fails on tampering and garbage', () => {
    const token = signGateToken(secret, user, 100, 2000)
    expect(verifyGateToken(secret, token.replace('.2000.', '.9000.'), user, 100, 1)).toBeNull()
    expect(verifyGateToken(secret, undefined, user, 100, 1)).toBeNull()
    expect(verifyGateToken(secret, 'v1.a.b', user, 100, 1)).toBeNull()
    expect(verifyGateToken(secret, 'v0.' + token.slice(3), user, 100, 1)).toBeNull()
  })
})

describe('input rules', () => {
  it('normalises usernames', () => {
    expect(normalizeGateUsername('  Dono ')).toBe('dono')
    expect(normalizeGateUsername('rj.solucoes@x')).toBe('rj.solucoes@x')
    expect(normalizeGateUsername('ab')).toBeNull()
    expect(normalizeGateUsername('has space')).toBeNull()
    expect(normalizeGateUsername(42)).toBeNull()
  })

  it('bounds passwords', () => {
    expect(isAcceptableGatePassword('1234567')).toBe(false)
    expect(isAcceptableGatePassword('12345678')).toBe(true)
    expect(isAcceptableGatePassword('x'.repeat(129))).toBe(false)
  })
})
