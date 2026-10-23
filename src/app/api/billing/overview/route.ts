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
import { buildOverview, type BillingRowView, type PaymentRowView } from '@/lib/billing/overview'
import { isBillingCycle } from '@/lib/billing/rules'
import { loadCurrentPlanCatalog } from '@/lib/plan-catalog-server'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const ctx = await requireRole('admin')
    const [catalog, billingRes, paymentsRes] = await Promise.all([
      loadCurrentPlanCatalog(supabaseAdmin()),
      ctx.supabase
        .from('account_billing')
        .select('plan, cycle, value_cents, status, current_period_end, asaas_subscription_id')
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

    return NextResponse.json(
      buildOverview({
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
