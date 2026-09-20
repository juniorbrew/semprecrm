import { describe, expect, it } from 'vitest'

import { loginNoticeUrl, parseOtpType, safeNextPath } from './callback'

const origin = 'https://www.semprecrm.com.br'

describe('parseOtpType', () => {
  it('accepts GoTrue e-mail OTP types only', () => {
    expect(parseOtpType('signup')).toBe('signup')
    expect(parseOtpType('recovery')).toBe('recovery')
    expect(parseOtpType('sms')).toBeNull()
    expect(parseOtpType(null)).toBeNull()
  })
})

describe('safeNextPath', () => {
  it('keeps relative paths and same-origin URLs', () => {
    expect(safeNextPath('/join/abc', origin, 'signup')).toBe('/join/abc')
    expect(safeNextPath(`${origin}/join/abc?x=1`, origin, 'invite')).toBe('/join/abc?x=1')
  })

  it('falls back to /dashboard for foreign or malformed targets', () => {
    expect(safeNextPath(null, origin, 'signup')).toBe('/dashboard')
    expect(safeNextPath('https://evil.com/x', origin, 'signup')).toBe('/dashboard')
    expect(safeNextPath('//evil.com', origin, 'signup')).toBe('/dashboard')
    expect(safeNextPath('javascript:alert(1)', origin, 'signup')).toBe('/dashboard')
    expect(safeNextPath('/auth/callback?code=1', origin, 'signup')).toBe('/dashboard')
  })

  it('always sends a recovery link to the password form', () => {
    expect(safeNextPath('/dashboard', origin, 'recovery')).toBe('/reset-password')
    expect(safeNextPath(null, origin, 'recovery')).toBe('/reset-password')
  })
})

describe('loginNoticeUrl', () => {
  it('builds the login URL with the notice', () => {
    expect(loginNoticeUrl(origin, 'link_invalid')).toBe(`${origin}/login?notice=link_invalid`)
  })
})
