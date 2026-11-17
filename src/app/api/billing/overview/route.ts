// ============================================================
// GET /api/billing/overview — what Settings → Plano shows: plans sold online
// with their catalog price, the account's subscription, the charge still to
// be paid and the payment history. Owner and admins only (the billing tables
// are RLS-restricted the same way). Reachable while the account is read-only:
// it checks the role, never the plan.
// ============================================================

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { asaasConfigured } from '@/lib/billing/asaas'
import { buildExtrasView, buildOverview, type BillingRowView, type PaymentRowView } from '@/lib/billing/overview'
import { isBillingCycle } from '@/lib/billing/rules'
import { loadCurrentPlanCatalog } from '@/lib/plan-catalog-server'
import { countConnectedChannels, loadAccountEntitlements } from '@/lib/plans-server'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const ctx = await requireRole('admin')
    const [catalog, billingRes, paymentsRes] = await Promise.all([
      loadCurrentPlanCatalog(supabaseAdmin()),
      ctx.supabase
        .from('account_billing')
        .select(
          'plan, cycle, value_cents, status, current_period_end, asaas_subscription_id, extra_user_price_cents, extra_channel_price_cents, pending_extra_users, pending_extra_channels, extras_reduce_due',
        )
        .eq('account_id', ctx.accountId)
        .maybeSingle(),
      ctx.supabase
        .from('billing_payments')
        .select('asaas_payment_id, asaas_subscription_id, status, value_cents, due_date, invoice_url')
        .eq('account_id', ctx.accountId)
        .order('due_date', { ascending: false })
        .limit(36),
    ])
    if (billingRes.error) throw new Error(`billing read failed: ${billingRes.error.message}`)
    if (paymentsRes.error) throw new Error(`payments read failed: ${paymentsRes.error.message}`)

    const b = billingRes.data as Record<string, unknown> | null
    const billing: BillingRowView | null =
      b && isBillingCycle(b.cycle)
        ? {
            plan: String(b.plan),
            cycle: b.cycle,
            valueCents: Number(b.value_cents),
            status: String(b.status),
            currentPeriodEnd: (b.current_period_end as string | null) ?? null,
            subscriptionId: (b.asaas_subscription_id as string | null) ?? null,
          }
        : null
    const payments: PaymentRowView[] = ((paymentsRes.data ?? []) as Record<string, unknown>[]).map((p) => ({
      id: String(p.asaas_payment_id),
      subscriptionId: (p.asaas_subscription_id as string | null) ?? null,
      status: String(p.status),
      dueDate: (p.due_date as string | null) ?? null,
      valueCents: Number(p.value_cents),
      invoiceUrl: (p.invoice_url as string | null) ?? null,
    }))

    // Extras (migration 114): only on an active paid subscription of an account that is not blocked.
    let extras = null
    if (billing?.status === 'active' && billing.subscriptionId) {
      const admin = supabaseAdmin()
      const ent = await loadAccountEntitlements(admin, ctx.accountId)
      if (ent && !ent.blocked && ent.status === 'active') {
        const offered = catalog.find((v) => v.plan === ent.plan)?.definition
        const nowIso = new Date().toISOString()
        const [members, invites, channels] = await Promise.all([
          admin.from('profiles').select('user_id', { count: 'exact', head: true }).eq('account_id', ctx.accountId),
          admin
            .from('account_invitations')
            .select('id', { count: 'exact', head: true })
            .eq('account_id', ctx.accountId)
            .is('accepted_at', null)
            .gt('expires_at', nowIso),
          countConnectedChannels(admin, ctx.accountId),
        ])
        if (members.error || invites.error) throw new Error('usage read failed')
        extras = buildExtrasView({
          ent,
          offered: { userCents: offered?.extra_user_price_cents ?? null, channelCents: offered?.extra_channel_price_cents ?? null },
          locked: { userCents: toCents(b?.extra_user_price_cents), channelCents: toCents(b?.extra_channel_price_cents) },
          usage: { users: (members.count ?? 0) + (invites.count ?? 0), channels },
          pending: {
            users: toCount(b?.pending_extra_users),
            channels: toCount(b?.pending_extra_channels),
            effectiveDate: typeof b?.extras_reduce_due === 'string' ? b.extras_reduce_due : null,
          },
          isOwner: ctx.role === 'owner',
        })
      }
    }

    return NextResponse.json(
      buildOverview({
        extras,
        configured: asaasConfigured(),
        isOwner: ctx.role === 'owner',
        catalog: catalog.map((v) => ({ plan: v.plan, priceMonthlyCents: v.price_monthly_cents })),
        billing,
        payments,
      }),
    )
  } catch (err) {
    return toErrorResponse(err)
  }
}

function toCount(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null
}

function toCents(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) ? v : null
}
