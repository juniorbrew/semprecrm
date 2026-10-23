import { describe, expect, it } from 'vitest'

import { PLAN_CATALOG, resolveEntitlements, type PlanAccountFields } from '@/lib/plans'

import { isFullyBlocked, READ_ONLY_MESSAGES, readOnlyReason } from './read-only'

const NOW = new Date('2026-10-22T12:00:00Z')
const VERSION = '39000000-0000-4000-8000-000000000001'

function account(patch: Partial<PlanAccountFields>) {
  return resolveEntitlements(
    {
      plan: 'pro',
      plan_status: 'active',
      plan_expires_at: null,
      plan_version_id: VERSION,
      plan_definition: PLAN_CATALOG.pro,
      ...patch,
    },
    NOW,
  )
}

describe('read-only decision (one rule for server and client)', () => {
  it('trial ended and payment overdue are read-only, not fully blocked', () => {
    const ended = account({ plan: 'trial', plan_status: 'trial', plan_expires_at: '2026-10-01T00:00:00Z', plan_definition: PLAN_CATALOG.trial })
    expect(readOnlyReason(ended)).toBe('trial_expired')
    expect(readOnlyReason(account({ plan_status: 'past_due' }))).toBe('past_due')
    expect(isFullyBlocked(ended)).toBe(false)
    expect(isFullyBlocked(account({ plan_status: 'past_due' }))).toBe(false)
  })

  it('a platform suspension and a cancellation stay fully blocked, never read-only', () => {
    for (const plan_status of ['suspended', 'canceled']) {
      const ent = account({ plan_status })
      expect(readOnlyReason(ent)).toBeNull()
      expect(isFullyBlocked(ent)).toBe(true)
    }
  })

  it('an unreadable plan is fully blocked (fail closed)', () => {
    const ent = resolveEntitlements(null, NOW)
    expect(readOnlyReason(ent)).toBeNull()
    expect(isFullyBlocked(ent)).toBe(true)
  })

  it('an active account is writable, even with a platform "valid until" in the past', () => {
    const ent = account({ plan_status: 'active', plan_expires_at: '2020-01-01T00:00:00Z' })
    expect(ent.blocked).toBe(false)
    expect(readOnlyReason(ent)).toBeNull()
    expect(isFullyBlocked(ent)).toBe(false)
    expect(readOnlyReason(null)).toBeNull()
  })

  it('has a pt-BR message per reason pointing to Configurações → Plano', () => {
    for (const msg of Object.values(READ_ONLY_MESSAGES)) expect(msg).toMatch(/somente leitura.*Plano/)
  })
})
