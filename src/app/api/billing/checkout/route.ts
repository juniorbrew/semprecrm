// ============================================================
// POST /api/billing/checkout — start (or resume) the account's paid
// subscription on Asaas (docs/superpowers/specs/2026-10-12-billing-asaas-design.md).
//
// Owner only. Body { plan, cycle: 'monthly' | 'annual' }. The account is
// the session's, never the body's. Returns { url }: the Asaas page where
// the customer pays the first charge by Pix, boleto or card.
//
// Plan, catalog version and price are frozen in account_billing at this
// moment; the account only changes when Asaas confirms the payment
// (webhook). Asking again for the same plan/cycle returns the same
// pending charge instead of a second subscription.
// ============================================================

import { NextResponse } from 'next/server'

import { AUDIT_ACTIONS } from '@/lib/audit'
import { audit } from '@/lib/audit-server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import {
  asaasConfigured,
  AsaasError,
  createCustomer,
  createSubscription,
  deleteSubscription,
  listSubscriptionPayments,
  type AsaasPayment,
} from '@/lib/billing/asaas'
import { asaasCycle, isBillingCycle, isNewPayment, periodPriceCents, todayInSaoPaulo, type BillingCycle } from '@/lib/billing/rules'
import { loadCurrentPlanCatalog } from '@/lib/plan-catalog-server'
import { PLANS, type Plan } from '@/lib/plans'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

export const CHECKOUT_ERRORS = {
  notConfigured: 'Online payment is not available yet. Talk to the SempreCRM team.',
  body: 'Choose a plan and a billing cycle.',
  notForSale: 'This plan is sold by our team. Talk to us to subscribe.',
  taxId: 'Add your CPF or CNPJ in Settings → Empresa before subscribing.',
  alreadyActive: 'This account already has an active subscription.',
  confirming: 'Your payment is being confirmed. This takes a few minutes.',
  suspended: 'This account is suspended. Talk to the SempreCRM team.',
  busy: 'Another subscription request is in progress. Try again.',
  provider: 'Could not reach the payment provider. Try again in a few minutes.',
} as const

type BillingRow = {
  asaas_customer_id: string | null
  asaas_subscription_id: string | null
  plan: string
  cycle: string
  status: string
  current_period_end: string | null
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('owner')
    const limit = checkRateLimit(`billing:checkout:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    if (!asaasConfigured()) return NextResponse.json({ error: CHECKOUT_ERRORS.notConfigured }, { status: 503 })

    const body = (await request.json().catch(() => null)) as { plan?: unknown; cycle?: unknown } | null
    const plan = body?.plan
    const cycle = body?.cycle
    if (typeof plan !== 'string' || !(PLANS as readonly string[]).includes(plan) || plan === 'trial' || !isBillingCycle(cycle)) {
      return NextResponse.json({ error: CHECKOUT_ERRORS.body }, { status: 400 })
    }

    const db = supabaseAdmin()
    const version = (await loadCurrentPlanCatalog(db)).find((v) => v.plan === (plan as Plan))
    const monthly = version?.price_monthly_cents ?? null
    if (!version || !monthly || monthly <= 0) {
      return NextResponse.json({ error: CHECKOUT_ERRORS.notForSale }, { status: 400 })
    }

    const { data: account, error: accErr } = await db
      .from('accounts')
      .select('id, name, legal_name, tax_id, email, phone, plan_status')
      .eq('id', ctx.accountId)
      .single()
    if (accErr || !account) throw new Error(`account read failed: ${accErr?.message ?? 'not found'}`)
    if (account.plan_status === 'suspended') {
      return NextResponse.json({ error: CHECKOUT_ERRORS.suspended }, { status: 403 })
    }
    const taxId = String(account.tax_id ?? '').replace(/\D/g, '')
    if (taxId.length !== 11 && taxId.length !== 14) {
      return NextResponse.json({ error: CHECKOUT_ERRORS.taxId }, { status: 400 })
    }

    const { data: existing, error: billErr } = await db
      .from('account_billing')
      .select('asaas_customer_id, asaas_subscription_id, plan, cycle, status, current_period_end')
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (billErr) throw new Error(`billing read failed: ${billErr.message}`)
    const current = existing as BillingRow | null
    if (current?.status === 'active') {
      return NextResponse.json({ error: CHECKOUT_ERRORS.alreadyActive }, { status: 409 })
    }

    // pending: the first charge is still to be paid. past_due: a renewal is
    // overdue. Either way the subscription's charges tell what to do.
    const covered = coveredUntilMs(current)
    if ((current?.status === 'pending' || current?.status === 'past_due') && current.asaas_subscription_id) {
      const payments = await syncPayments(db, ctx.accountId, current.asaas_subscription_id)
      // Paid, webhook not here yet: never drop a paid subscription.
      if (payments.some((p) => isNewPayment(p, current.cycle as BillingCycle, covered))) {
        return NextResponse.json({ error: CHECKOUT_ERRORS.confirming }, { status: 409 })
      }
      // Same plan/cycle still unpaid: hand back the same charge.
      const url = openInvoice(payments)
      if (url && current.plan === plan && current.cycle === cycle) return NextResponse.json({ url })
      // A different choice replaces the old subscription (below, once the new one exists).
    }

    const customerId =
      current?.asaas_customer_id ??
      (
        await createCustomer({
          name: String(account.legal_name || account.name),
          cpfCnpj: taxId,
          email: account.email,
          mobilePhone: account.phone,
          externalReference: ctx.accountId,
        })
      ).id

    const value = periodPriceCents(monthly, cycle)
    const label = plan === 'pro' ? 'Pro' : plan === 'basico' ? 'Básico' : plan
    const subscription = await createSubscription({
      customer: customerId,
      value: value / 100,
      nextDueDate: todayInSaoPaulo(),
      cycle: asaasCycle(cycle),
      description: `SempreCRM ${label} (${cycle === 'annual' ? 'anual' : 'mensal'})`,
      externalReference: ctx.accountId,
    })

    // From here the new subscription exists in Asaas: if it does not end up
    // as the account's one, cancel it so it never charges anybody.
    try {
      const row = {
        asaas_customer_id: customerId,
        asaas_subscription_id: subscription.id,
        plan,
        plan_version_id: version.id,
        cycle,
        value_cents: value,
        status: 'pending',
      }
      // Compare-and-swap against what was read: a concurrent checkout loses.
      const swap = current
        ? db.from('account_billing').update(row).eq('account_id', ctx.accountId).eq('status', current.status)
        : null
      // An insert either succeeds or hits the primary key (23505): someone else won.
      const { data: swapped, error: upErr } = swap
        ? await (current?.asaas_subscription_id
            ? swap.eq('asaas_subscription_id', current.asaas_subscription_id)
            : swap.is('asaas_subscription_id', null)
          ).select('account_id')
        : await db.from('account_billing').insert({ account_id: ctx.accountId, ...row }).then((r) => ({ ...r, data: r.error ? [] : [row] }))
      if (upErr && upErr.code !== '23505') throw new Error(`billing save failed: ${upErr.message}`)
      if (upErr || !swapped?.length) {
        await cancelQuietly(subscription.id)
        return NextResponse.json({ error: CHECKOUT_ERRORS.busy }, { status: 409 })
      }
    } catch (err) {
      // The swap may have committed with only its reply lost: never cancel
      // the subscription the account now points to.
      const { data: now } = await db.from('account_billing').select('asaas_subscription_id').eq('account_id', ctx.accountId).maybeSingle()
      if (now?.asaas_subscription_id !== subscription.id) await cancelQuietly(subscription.id)
      throw err
    }
    if (current?.asaas_subscription_id) await cancelReplaced(current.asaas_subscription_id, current.cycle as BillingCycle, covered)
    const url = openInvoice(await syncPayments(db, ctx.accountId, subscription.id))

    await audit({
      accountId: ctx.accountId,
      actorUserId: ctx.userId,
      action: AUDIT_ACTIONS.BILLING_CHECKOUT,
      entityType: 'account_billing',
      entityId: ctx.accountId,
      metadata: { plan, cycle, value_cents: value },
    })
    if (!url) return NextResponse.json({ error: CHECKOUT_ERRORS.provider }, { status: 502 })
    return NextResponse.json({ url })
  } catch (err) {
    if (err instanceof AsaasError) {
      console.error('[billing/checkout] provider error:', err.message)
      return NextResponse.json({ error: CHECKOUT_ERRORS.provider }, { status: 502 })
    }
    return toErrorResponse(err)
  }
}

/**
 * Best effort cancel of a subscription that is not the account's.
 * ponytail: a failed cancel is only logged; the leftover keeps sending
 * charges until cancelled by hand in Asaas. Add a retry queue (hourly
 * billing cron) if these logs ever show up.
 */
async function cancelQuietly(subscriptionId: string): Promise<void> {
  try {
    await deleteSubscription(subscriptionId)
  } catch (err) {
    console.error('[billing/checkout] ORPHAN subscription, cancel it in Asaas:', subscriptionId, err instanceof Error ? err.message : err)
  }
}

/**
 * The replaced subscription may have been paid meanwhile: then keep it and flag it for a refund.
 * Only a payment that extends access beyond `coveredUntilMs` counts: an overdue
 * subscription has paid history, and replacing it must still cancel it.
 */
async function cancelReplaced(subscriptionId: string, cycle: BillingCycle, coveredUntilMs: number): Promise<void> {
  try {
    const payments = await listSubscriptionPayments(subscriptionId)
    if (payments.some((p) => isNewPayment(p, cycle, coveredUntilMs))) {
      console.error('[billing/checkout] REPLACED subscription was paid, refund it in Asaas:', subscriptionId)
      return
    }
  } catch (err) {
    console.error('[billing/checkout] could not re-check replaced subscription', subscriptionId, err instanceof Error ? err.message : err)
    return
  }
  await cancelQuietly(subscriptionId)
}

/** Access already paid for (past_due keeps its period end); -Infinity = nothing is. */
function coveredUntilMs(current: BillingRow | null): number {
  if (current?.status !== 'past_due' || !current.current_period_end) return -Infinity
  const ms = Date.parse(current.current_period_end)
  return Number.isFinite(ms) ? ms : -Infinity
}

/** Stores the subscription's charges (as Asaas has them) and returns them. */
async function syncPayments(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  subscriptionId: string,
): Promise<AsaasPayment[]> {
  const payments = await listSubscriptionPayments(subscriptionId)
  if (payments.length > 0) {
    const { error } = await db.from('billing_payments').upsert(
      payments.map((p) => ({
        asaas_payment_id: p.id,
        account_id: accountId,
        asaas_subscription_id: subscriptionId,
        status: p.status,
        billing_type: p.billingType ?? null,
        value_cents: Math.round(p.value * 100),
        due_date: p.dueDate,
        invoice_url: p.invoiceUrl ?? null,
      })),
      { onConflict: 'asaas_payment_id' },
    )
    if (error) throw new Error(`payments save failed: ${error.message}`)
  }
  return payments
}

/** The payment page of the charge still to be paid. */
function openInvoice(payments: AsaasPayment[]): string | null {
  return payments.find((p) => p.status === 'PENDING' || p.status === 'OVERDUE')?.invoiceUrl ?? null
}
