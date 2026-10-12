// ============================================================
// Billing rules — pure, so they are what the tests pin
// (docs/superpowers/specs/2026-10-12-billing-asaas-design.md).
// ============================================================

export const BILLING_CYCLES = ['monthly', 'annual'] as const
export type BillingCycle = (typeof BILLING_CYCLES)[number]

export function isBillingCycle(value: unknown): value is BillingCycle {
  return value === 'monthly' || value === 'annual'
}

/** Annual = 12 months with 2 free (decision of 12/10/2026). */
export const ANNUAL_MONTHS_CHARGED = 10

/** Price of one billing period, in cents, from the catalog's monthly price. */
export function periodPriceCents(monthlyCents: number, cycle: BillingCycle): number {
  return cycle === 'annual' ? monthlyCents * ANNUAL_MONTHS_CHARGED : monthlyCents
}

export function asaasCycle(cycle: BillingCycle): 'MONTHLY' | 'YEARLY' {
  return cycle === 'annual' ? 'YEARLY' : 'MONTHLY'
}

/** Days of access after the paid period while the next charge settles. */
export const GRACE_DAYS = 5

/**
 * When access paid by a charge due on `dueDate` (YYYY-MM-DD) ends: one month
 * or one year later, plus the grace days, at the end of that day in
 * São Paulo (UTC-3, no DST since 2019).
 */
export function periodEnd(dueDate: string, cycle: BillingCycle): Date {
  const [y, m, d] = dueDate.split('-').map(Number)
  const end = new Date(Date.UTC(y, m - 1, d))
  if (cycle === 'annual') end.setUTCFullYear(end.getUTCFullYear() + 1)
  else end.setUTCMonth(end.getUTCMonth() + 1)
  end.setUTCDate(end.getUTCDate() + GRACE_DAYS)
  end.setUTCHours(23 + 3, 59, 59, 0) // 23:59:59 in São Paulo
  return end
}

/** Today's date in São Paulo, YYYY-MM-DD (the first charge is due today). */
export function todayInSaoPaulo(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(now)
}

export type BillingEffect = 'activate' | 'past_due' | 'record'

/** What an Asaas payment event does to the account. */
export function eventEffect(event: string): BillingEffect {
  switch (event) {
    case 'PAYMENT_CONFIRMED':
    case 'PAYMENT_RECEIVED':
      return 'activate'
    case 'PAYMENT_OVERDUE':
    case 'PAYMENT_REFUNDED':
    case 'PAYMENT_CHARGEBACK_REQUESTED':
      return 'past_due'
    default:
      return 'record'
  }
}

/** Payment statuses (from GET /payments/:id) that prove the money came in. */
export const PAID_STATUSES = new Set(['CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH'])
