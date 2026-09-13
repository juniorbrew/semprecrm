import { describe, expect, it } from 'vitest'

import {
  hasVerifiedTotp,
  isMfaEnrollAllowedPath,
  isMfaExemptPath,
  isMfaRequiredRole,
  isValidMfaCode,
  mustEnrollMfa,
  needsMfaChallenge,
  normalizeMfaCodeInput,
  resolveAssuranceLevels,
  safeNextPath,
  unverifiedTotpFactors,
  verifiedTotpFactors,
} from './mfa'

const verified = { id: 'f1', factor_type: 'totp', status: 'verified' }
const pending = { id: 'f2', factor_type: 'totp', status: 'unverified' }
const phone = { id: 'f3', factor_type: 'phone', status: 'verified' }

describe('needsMfaChallenge', () => {
  it('is true only for aal1 → aal2', () => {
    expect(needsMfaChallenge({ currentLevel: 'aal1', nextLevel: 'aal2' })).toBe(true)
  })

  it('is false when already aal2 or when no factor is enrolled', () => {
    expect(needsMfaChallenge({ currentLevel: 'aal2', nextLevel: 'aal2' })).toBe(false)
    expect(needsMfaChallenge({ currentLevel: 'aal1', nextLevel: 'aal1' })).toBe(false)
    expect(needsMfaChallenge({ currentLevel: null, nextLevel: null })).toBe(false)
  })

  it('fails open on missing data (a Supabase error must not lock the user out)', () => {
    expect(needsMfaChallenge(null)).toBe(false)
    expect(needsMfaChallenge(undefined)).toBe(false)
  })
})

describe('factor filters', () => {
  it('separates verified / unverified TOTP factors and ignores other types', () => {
    const all = [verified, pending, phone]
    expect(verifiedTotpFactors(all)).toEqual([verified])
    expect(unverifiedTotpFactors(all)).toEqual([pending])
    expect(hasVerifiedTotp(all)).toBe(true)
    expect(hasVerifiedTotp([pending, phone])).toBe(false)
    expect(hasVerifiedTotp(null)).toBe(false)
  })

  it('treats a factor without factor_type as totp', () => {
    expect(hasVerifiedTotp([{ id: 'x', status: 'verified' }])).toBe(true)
  })
})

describe('resolveAssuranceLevels', () => {
  it('raises nextLevel to aal2 when a verified factor exists', () => {
    expect(resolveAssuranceLevels('aal1', [verified])).toEqual({
      currentLevel: 'aal1',
      nextLevel: 'aal2',
    })
  })

  it('keeps nextLevel at the current level without factors', () => {
    expect(resolveAssuranceLevels('aal1', [])).toEqual({ currentLevel: 'aal1', nextLevel: 'aal1' })
    expect(resolveAssuranceLevels('aal1', [pending])).toEqual({
      currentLevel: 'aal1',
      nextLevel: 'aal1',
    })
    expect(resolveAssuranceLevels(null, undefined)).toEqual({ currentLevel: null, nextLevel: null })
  })

  it('composes with needsMfaChallenge', () => {
    expect(needsMfaChallenge(resolveAssuranceLevels('aal1', [verified]))).toBe(true)
    expect(needsMfaChallenge(resolveAssuranceLevels('aal2', [verified]))).toBe(false)
  })
})

describe('isMfaExemptPath', () => {
  it('allows the challenge page and our auth API', () => {
    expect(isMfaExemptPath('/mfa')).toBe(true)
    expect(isMfaExemptPath('/mfa/')).toBe(true)
    expect(isMfaExemptPath('/api/auth/mfa/audit')).toBe(true)
    expect(isMfaExemptPath('/_next/data/x')).toBe(true)
  })

  it('blocks everything else', () => {
    expect(isMfaExemptPath('/dashboard')).toBe(false)
    expect(isMfaExemptPath('/settings')).toBe(false)
    expect(isMfaExemptPath('/api/contacts')).toBe(false)
    expect(isMfaExemptPath('/mfaX')).toBe(false)
    expect(isMfaExemptPath('/login')).toBe(false)
  })
})

describe('mustEnrollMfa', () => {
  it('requires owners and admins without a verified factor when the toggle is on', () => {
    expect(mustEnrollMfa({ role: 'owner', requireMfaAdmins: true, hasVerifiedFactor: false })).toBe(true)
    expect(mustEnrollMfa({ role: 'admin', requireMfaAdmins: true, hasVerifiedFactor: false })).toBe(true)
  })

  it('never applies to agents / viewers / unknown roles', () => {
    expect(mustEnrollMfa({ role: 'agent', requireMfaAdmins: true, hasVerifiedFactor: false })).toBe(false)
    expect(mustEnrollMfa({ role: 'viewer', requireMfaAdmins: true, hasVerifiedFactor: false })).toBe(false)
    expect(mustEnrollMfa({ role: null, requireMfaAdmins: true, hasVerifiedFactor: false })).toBe(false)
  })

  it('is satisfied once a factor is verified, and off when the toggle is off', () => {
    expect(mustEnrollMfa({ role: 'admin', requireMfaAdmins: true, hasVerifiedFactor: true })).toBe(false)
    expect(mustEnrollMfa({ role: 'owner', requireMfaAdmins: false, hasVerifiedFactor: false })).toBe(false)
  })

  it('isMfaRequiredRole matches owner + admin only', () => {
    expect(isMfaRequiredRole('owner')).toBe(true)
    expect(isMfaRequiredRole('admin')).toBe(true)
    expect(isMfaRequiredRole('agent')).toBe(false)
    expect(isMfaRequiredRole(undefined)).toBe(false)
  })
})

describe('isMfaEnrollAllowedPath', () => {
  it('lets the settings area through and nothing else', () => {
    expect(isMfaEnrollAllowedPath('/settings')).toBe(true)
    expect(isMfaEnrollAllowedPath('/settings/anything')).toBe(true)
    expect(isMfaEnrollAllowedPath('/settingsx')).toBe(false)
    expect(isMfaEnrollAllowedPath('/dashboard')).toBe(false)
  })
})

describe('code helpers', () => {
  it('validates exactly six digits', () => {
    expect(isValidMfaCode('123456')).toBe(true)
    expect(isValidMfaCode('12345')).toBe(false)
    expect(isValidMfaCode('12345a')).toBe(false)
    expect(isValidMfaCode(123456)).toBe(false)
  })

  it('normalises pasted input', () => {
    expect(normalizeMfaCodeInput('123 456')).toBe('123456')
    expect(normalizeMfaCodeInput('12-34-56-78')).toBe('123456')
    expect(normalizeMfaCodeInput('abc')).toBe('')
  })
})

describe('safeNextPath', () => {
  it('accepts same-origin absolute paths', () => {
    expect(safeNextPath('/join/abc')).toBe('/join/abc')
    expect(safeNextPath('/inbox?x=1')).toBe('/inbox?x=1')
  })

  it('rejects external / protocol-relative / recursive targets', () => {
    expect(safeNextPath('https://evil.example')).toBe('/dashboard')
    expect(safeNextPath('//evil.example')).toBe('/dashboard')
    expect(safeNextPath('/\\evil.example')).toBe('/dashboard')
    expect(safeNextPath('/mfa')).toBe('/dashboard')
    expect(safeNextPath(null)).toBe('/dashboard')
    expect(safeNextPath('', '/x')).toBe('/x')
  })
})
