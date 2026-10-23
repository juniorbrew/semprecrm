import { describe, expect, it } from 'vitest'

import { asaasCycle, eventEffect, isNewPayment, periodEnd, periodPriceCents, todayInSaoPaulo } from './rules'

describe('billing rules', () => {
  it('annual is 10 months (2 free); monthly is the catalog price', () => {
    expect(periodPriceCents(8990, 'monthly')).toBe(8990)
    expect(periodPriceCents(8990, 'annual')).toBe(89900)
    expect(periodPriceCents(5990, 'annual')).toBe(59900)
    expect(asaasCycle('annual')).toBe('YEARLY')
    expect(asaasCycle('monthly')).toBe('MONTHLY')
  })

  it('a payment pays one period plus 5 grace days, ending 23:59:59 in São Paulo', () => {
    expect(periodEnd('2026-10-12', 'monthly').toISOString()).toBe('2026-11-18T02:59:59.000Z')
    expect(periodEnd('2026-10-12', 'annual').toISOString()).toBe('2027-10-18T02:59:59.000Z')
    // Month overflow: Jan 31 + 1 month lands in early March, never earlier than a month.
    expect(periodEnd('2027-01-31', 'monthly').getTime()).toBeGreaterThan(new Date('2027-02-28T00:00:00Z').getTime())
  })

  it('today is the São Paulo date, not the UTC one', () => {
    expect(todayInSaoPaulo(new Date('2026-10-13T02:00:00Z'))).toBe('2026-10-12')
    expect(todayInSaoPaulo(new Date('2026-10-13T04:00:00Z'))).toBe('2026-10-13')
  })

  it('maps Asaas events to effects', () => {
    expect(eventEffect('PAYMENT_CONFIRMED')).toBe('activate')
    expect(eventEffect('PAYMENT_RECEIVED')).toBe('activate')
    expect(eventEffect('PAYMENT_OVERDUE')).toBe('past_due')
    expect(eventEffect('PAYMENT_REFUNDED')).toBe('past_due')
    expect(eventEffect('PAYMENT_CHARGEBACK_REQUESTED')).toBe('past_due')
    expect(eventEffect('PAYMENT_CREATED')).toBe('record')
    expect(eventEffect('SOMETHING_NEW')).toBe('record')
  })
})

describe('isNewPayment', () => {
  const covered = Date.parse('2026-10-17T23:59:59-03:00')
  it('a paid charge extending access counts; the already covered one does not', () => {
    expect(isNewPayment({ status: 'RECEIVED', dueDate: '2026-10-12' }, 'monthly', covered)).toBe(true)
    expect(isNewPayment({ status: 'RECEIVED', dueDate: '2026-09-12' }, 'monthly', covered)).toBe(false)
  })
  it('unpaid never counts; with nothing covered any paid charge counts', () => {
    expect(isNewPayment({ status: 'OVERDUE', dueDate: '2026-10-12' }, 'monthly', covered)).toBe(false)
    expect(isNewPayment({ status: 'CONFIRMED', dueDate: '2020-01-01' }, 'monthly', -Infinity)).toBe(true)
  })
})
