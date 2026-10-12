import { describe, expect, it } from 'vitest'

import { onboardingComplete, onboardingStatus, trialDaysLeft } from './onboarding'

const base = { officialStatus: null, qrStatus: null, contacts: 0, members: 1, pendingInvites: 0, aiEnabled: false }

describe('onboardingStatus', () => {
  it('a brand-new account has nothing done', () => {
    expect(onboardingStatus(base)).toEqual({ whatsapp: false, contacts: false, team: false, ai: false })
  })

  it('WhatsApp counts on either channel, only when connected', () => {
    expect(onboardingStatus({ ...base, officialStatus: 'connected' }).whatsapp).toBe(true)
    expect(onboardingStatus({ ...base, qrStatus: 'connected' }).whatsapp).toBe(true)
    expect(onboardingStatus({ ...base, qrStatus: 'qr' }).whatsapp).toBe(false)
    expect(onboardingStatus({ ...base, officialStatus: 'pending' }).whatsapp).toBe(false)
  })

  it('the team step is done with a second member or a pending invite', () => {
    expect(onboardingStatus({ ...base, members: 2 }).team).toBe(true)
    expect(onboardingStatus({ ...base, pendingInvites: 1 }).team).toBe(true)
  })

  it('complete ignores the optional AI step', () => {
    const done = onboardingStatus({ ...base, qrStatus: 'connected', contacts: 3, members: 2 })
    expect(done.ai).toBe(false)
    expect(onboardingComplete(done)).toBe(true)
    expect(onboardingComplete({ ...done, contacts: false })).toBe(false)
  })
})

describe('trialDaysLeft', () => {
  const now = new Date('2026-10-12T12:00:00Z')
  it('rounds up the days left of a trial and never goes negative', () => {
    expect(trialDaysLeft('trial', '2026-10-26T03:52:10Z', now)).toBe(14)
    expect(trialDaysLeft('trial', '2026-10-12T13:00:00Z', now)).toBe(1)
    expect(trialDaysLeft('trial', '2026-10-01T00:00:00Z', now)).toBe(0)
  })
  it('is null outside a trial or without a date', () => {
    expect(trialDaysLeft('active', '2026-10-26T00:00:00Z', now)).toBeNull()
    expect(trialDaysLeft('trial', null, now)).toBeNull()
  })
})
