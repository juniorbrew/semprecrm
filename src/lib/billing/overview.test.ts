import { describe, expect, it } from 'vitest'

import { buildOverview, cyclePricing, formatBrl, paymentStatusKey, planAction, safeInvoiceUrl, situationOf, type PaymentRowView } from './overview'

const catalog = [
  { plan: 'trial', priceMonthlyCents: null },
  { plan: 'basico', priceMonthlyCents: 5990 },
  { plan: 'pro', priceMonthlyCents: 8990 },
  { plan: 'empresa', priceMonthlyCents: null },
]
const pay = (over: Partial<PaymentRowView>): PaymentRowView => ({
  id: 'p1',
  subscriptionId: 'sub_1',
  status: 'PENDING',
  dueDate: '2026-10-12',
  valueCents: 8990,
  invoiceUrl: 'https://asaas.test/i/1',
  ...over,
})
const billing = { plan: 'pro', cycle: 'monthly' as const, valueCents: 8990, status: 'past_due', currentPeriodEnd: null, subscriptionId: 'sub_1' }

describe('buildOverview', () => {
  it('sells only plans with a catalog price; Empresa and the trial are not offered', () => {
    const o = buildOverview({ configured: true, isOwner: true, catalog, billing: null, payments: [] })
    expect(o.plans).toEqual([
      { plan: 'basico', monthlyCents: 5990 },
      { plan: 'pro', monthlyCents: 8990 },
    ])
    expect(o.canSubscribe).toBe(true)
    expect(buildOverview({ configured: true, isOwner: false, catalog, billing: null, payments: [] }).canSubscribe).toBe(false)
  })

  it('offers the overdue charge first, then the oldest pending one', () => {
    const o = buildOverview({
      configured: true,
      isOwner: true,
      catalog,
      billing,
      payments: [
        pay({ id: 'a', status: 'PENDING', dueDate: '2026-11-12', invoiceUrl: 'https://x/a' }),
        pay({ id: 'b', status: 'OVERDUE', dueDate: '2026-10-12', invoiceUrl: 'https://x/b' }),
        pay({ id: 'c', status: 'RECEIVED', dueDate: '2026-09-12', invoiceUrl: 'https://x/c' }),
      ],
    })
    expect(o.pendingInvoiceUrl).toBe('https://x/b')
    expect(o.payments.map((p) => p.id)).toEqual(['a', 'b', 'c']) // newest first
  })

  it('hides unpaid charges of a replaced subscription and never offers a non-https link', () => {
    const o = buildOverview({
      configured: true,
      isOwner: true,
      catalog,
      billing,
      payments: [
        pay({ id: 'old', subscriptionId: 'sub_old', status: 'PENDING' }),
        pay({ id: 'bad', status: 'OVERDUE', invoiceUrl: 'javascript:alert(1)' }),
        pay({ id: 'paidold', subscriptionId: 'sub_old', status: 'RECEIVED' }),
      ],
    })
    expect(o.payments.map((p) => p.id)).toEqual(['bad', 'paidold'])
    expect(o.payments[0].invoiceUrl).toBeNull()
    expect(o.pendingInvoiceUrl).toBeNull()
  })

  it('no subscription, no charges: empty but valid', () => {
    const o = buildOverview({ configured: false, isOwner: true, catalog, billing: null, payments: [] })
    expect(o).toMatchObject({ configured: false, billing: null, pendingInvoiceUrl: null, payments: [] })
  })
})

describe('plan view helpers', () => {
  it('annual = 10 months, 2 free, from the catalog', () => {
    expect(cyclePricing(8990, 'monthly')).toEqual({ periodCents: 8990, freeMonths: 2, annualSavingsCents: 17980 })
    expect(cyclePricing(8990, 'annual').periodCents).toBe(89900)
  })

  it('situation in plain terms', () => {
    expect(situationOf({ status: 'trial', blocked: false })).toBe('trial')
    expect(situationOf({ status: 'active', blocked: false })).toBe('active')
    expect(situationOf({ status: 'trial', blocked: { reason: 'trial_expired' } })).toBe('trial_expired')
    expect(situationOf({ status: 'past_due', blocked: { reason: 'past_due' } })).toBe('past_due')
    expect(situationOf({ status: 'suspended', blocked: { reason: 'suspended' } })).toBe('suspended')
    expect(situationOf({ status: 'trial', blocked: { reason: 'plan_unavailable' } })).toBe('unavailable')
  })

  it('charge status keys, links and money', () => {
    expect(['RECEIVED', 'CONFIRMED', 'PENDING', 'OVERDUE', 'REFUNDED', 'WHATEVER'].map(paymentStatusKey)).toEqual([
      'Paid',
      'Paid',
      'Awaiting payment',
      'Charge overdue',
      'Refunded',
      'Other',
    ])
    expect(safeInvoiceUrl('http://insecure')).toBeNull()
    expect(safeInvoiceUrl('https://ok')).toBe('https://ok')
    expect(formatBrl(8990).replace(/\s/g, ' ')).toBe('R$ 89,90')
  })
})

describe('planAction', () => {
  it('subscribe while trial / expired / canceled; pay the open charge when overdue on the same plan', () => {
    expect(planAction('trial', false)).toBe('subscribe')
    expect(planAction('trial_expired', false)).toBe('subscribe')
    expect(planAction('canceled', true)).toBe('subscribe')
    expect(planAction('past_due', true)).toBe('pay')
    expect(planAction('past_due', false)).toBe('subscribe')
  })
  it('an active subscription and a suspension cannot be changed from the panel', () => {
    expect(planAction('active', true)).toBe('locked')
    expect(planAction('active', false)).toBe('locked')
    expect(planAction('suspended', false)).toBe('locked')
  })
})
