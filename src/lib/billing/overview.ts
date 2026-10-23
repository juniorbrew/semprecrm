// ============================================================
// Settings → Plano: what the billing panel shows. Pure (the route reads
// the rows, this shapes them), so the rules are what the tests pin.
// ============================================================

import { ANNUAL_MONTHS_CHARGED, PAID_STATUSES, periodPriceCents, type BillingCycle } from './rules'

export interface CatalogPlan {
  plan: string
  priceMonthlyCents: number | null
}

export interface BillingRowView {
  plan: string
  cycle: BillingCycle
  valueCents: number
  status: string
  currentPeriodEnd: string | null
  subscriptionId: string | null
}

export interface PaymentRowView {
  id: string
  subscriptionId: string | null
  status: string
  dueDate: string | null
  valueCents: number
  invoiceUrl: string | null
}

export interface BillingOverview {
  /** Asaas keys are set on the server. */
  configured: boolean
  /** Only the owner subscribes or changes plan; admins just look. */
  canSubscribe: boolean
  /** Plans sold online (catalog price > 0). Empresa and the trial are "fale conosco". */
  plans: { plan: string; monthlyCents: number }[]
  billing: { plan: string; cycle: BillingCycle; valueCents: number; status: string; currentPeriodEnd: string | null } | null
  /** Link of the charge still to be paid (overdue first), if any. */
  pendingInvoiceUrl: string | null
  payments: { id: string; dueDate: string | null; valueCents: number; status: string; invoiceUrl: string | null }[]
}

const UNPAID = new Set(['PENDING', 'OVERDUE'])

/** Only https links are ever handed to the browser. */
export function safeInvoiceUrl(url: string | null | undefined): string | null {
  return typeof url === 'string' && /^https:\/\//i.test(url) ? url : null
}

export function buildOverview(input: {
  configured: boolean
  isOwner: boolean
  catalog: CatalogPlan[]
  billing: BillingRowView | null
  payments: PaymentRowView[]
}): BillingOverview {
  const { billing } = input
  const current = billing && billing.status !== 'canceled' ? billing.subscriptionId : null
  // Unpaid charges of a replaced subscription are noise: they will never be collected.
  const visible = input.payments.filter((p) => !UNPAID.has(p.status) || (current !== null && p.subscriptionId === current))
  const open = visible
    .filter((p) => UNPAID.has(p.status) && safeInvoiceUrl(p.invoiceUrl))
    .sort((a, b) => (a.status === b.status ? (a.dueDate ?? '').localeCompare(b.dueDate ?? '') : a.status === 'OVERDUE' ? -1 : 1))[0]
  return {
    configured: input.configured,
    canSubscribe: input.isOwner,
    plans: input.catalog
      .filter((c) => c.plan !== 'trial' && (c.priceMonthlyCents ?? 0) > 0)
      .map((c) => ({ plan: c.plan, monthlyCents: c.priceMonthlyCents as number })),
    billing: billing
      ? { plan: billing.plan, cycle: billing.cycle, valueCents: billing.valueCents, status: billing.status, currentPeriodEnd: billing.currentPeriodEnd }
      : null,
    pendingInvoiceUrl: open ? safeInvoiceUrl(open.invoiceUrl) : null,
    payments: [...visible]
      .sort((a, b) => (b.dueDate ?? '').localeCompare(a.dueDate ?? ''))
      .map((p) => ({ id: p.id, dueDate: p.dueDate, valueCents: p.valueCents, status: p.status, invoiceUrl: safeInvoiceUrl(p.invoiceUrl) })),
  }
}

/** Price of one period and what the annual cycle saves versus 12 monthly charges. */
export function cyclePricing(monthlyCents: number, cycle: BillingCycle) {
  return {
    periodCents: periodPriceCents(monthlyCents, cycle),
    freeMonths: 12 - ANNUAL_MONTHS_CHARGED,
    annualSavingsCents: monthlyCents * (12 - ANNUAL_MONTHS_CHARGED),
  }
}

export type Situation = 'trial' | 'trial_expired' | 'active' | 'past_due' | 'canceled' | 'suspended' | 'unavailable'

/** Plain-language situation of the account, from the resolved entitlements. */
export function situationOf(ent: { status: string; blocked: false | { reason: string } }): Situation {
  if (ent.blocked) {
    const r = ent.blocked.reason
    if (r === 'trial_expired' || r === 'past_due' || r === 'canceled' || r === 'suspended') return r
    return 'unavailable'
  }
  return ent.status === 'active' ? 'active' : 'trial'
}

/** English dictionary key of a charge status (the catalogue carries the pt-BR). */
export function paymentStatusKey(status: string): string {
  if (PAID_STATUSES.has(status)) return 'Paid'
  switch (status) {
    case 'PENDING':
      return 'Awaiting payment'
    case 'OVERDUE':
      return 'Charge overdue'
    case 'REFUNDED':
    case 'REFUND_REQUESTED':
    case 'REFUND_IN_PROGRESS':
      return 'Refunded'
    case 'CHARGEBACK_REQUESTED':
    case 'CHARGEBACK_DISPUTE':
      return 'Chargeback'
    default:
      return 'Other'
  }
}

export function formatBrl(cents: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100)
}

export type PlanAction = 'subscribe' | 'pay' | 'locked'

/**
 * What the button of a plan card does. An active subscription (or a platform
 * suspension) cannot be changed here: checkout answers 409/403 for those, so
 * the card says to talk to the team instead of offering a dead button.
 * Overdue + the same plan: pay the open charge.
 */
export function planAction(situation: Situation, isCurrentPlan: boolean): PlanAction {
  if (situation === 'active' || situation === 'suspended' || situation === 'unavailable') return 'locked'
  if (situation === 'past_due' && isCurrentPlan) return 'pay'
  return 'subscribe'
}
