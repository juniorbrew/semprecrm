// ============================================================
// POST /api/billing/extras — buy extra users / WhatsApp numbers, schedule their
// removal, or cancel a scheduled removal (migration 114; spec
// 2026-11-15-indicadores-e-extras.md, Parte C).
//
// OWNER only (like checkout), active paid account only: trial, read-only and
// blocked accounts are refused. Body { kind: 'user' | 'channel', delta } or
// { cancel_removal: true }. The account is the session's, never the body's.
//
//   delta > 0, monthly  the limit grows now; the next charge carries the extra (Asaas
//                       `updatePendingPayments: true`, no proration).
//   delta > 0, annual   an immediate one-off charge for the months left until the renewal;
//                       the limit is released when it is paid (extras-sweep.ts), and the
//                       subscription value rises for the renewal at that moment.
//   delta < 0           nothing drops now: the extras stay until the end of the paid
//                       period (and for at least one full billed period); the sweep applies
//                       it. The usage check runs now and again when it takes effect.
//
// The whole change runs through runExtrasChange (extras-service.ts): per-account
// claim, Asaas first, then one transaction for the extras and their audit row.
// ============================================================

import { NextResponse } from 'next/server'

import { requireRole, requireWritable, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { asaasConfigured, createPayment, deletePayment, listSubscriptionPayments } from '@/lib/billing/asaas'
import {
  addCycles,
  addDays,
  changeExtras,
  nextChargeDue,
  oneOffCents,
  remainingMonths,
  removalDueDate,
  type ExtrasRefusal,
  type ExtrasState,
} from '@/lib/billing/extras'
import { EXTRAS_ERRORS, MAX_EXTRAS_CHANGES_PER_DAY, ONE_OFF_DUE_DAYS, ONE_OFF_EXPIRES_DAYS } from '@/lib/billing/extras-errors'
import { accountUsage, pickNew, runExtrasChange, type BillingExtrasRow, type Decision } from '@/lib/billing/extras-service'
import { safeInvoiceUrl } from '@/lib/billing/overview'
import { isBillingCycle, todayInSaoPaulo, type BillingCycle } from '@/lib/billing/rules'
import { loadCurrentPlanCatalog } from '@/lib/plan-catalog-server'
import { loadAccountEntitlements } from '@/lib/plans-server'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'


type Refusal = ExtrasRefusal | 'unavailable' | 'no_pending_removal' | 'removal_locked'

const REFUSALS: Record<Refusal | 'busy' | 'daily_cap' | 'conflict' | 'provider' | 'none', [keyof typeof EXTRAS_ERRORS, number]> = {
  invalid: ['body', 400],
  not_offered: ['notOffered', 400],
  unlimited: ['unlimited', 400],
  cap: ['cap', 400],
  below_usage: ['belowUsage', 409],
  pending_removal: ['pendingRemoval', 409],
  pending_purchase: ['pendingPurchase', 409],
  overdue: ['overdue', 409],
  renewal_pending: ['renewalPending', 409],
  unavailable: ['unavailable', 403],
  no_pending_removal: ['noPendingRemoval', 409],
  removal_locked: ['removalLocked', 409],
  busy: ['conflict', 409],
  daily_cap: ['tooMany', 429],
  conflict: ['conflict', 409],
  provider: ['provider', 502],
  none: ['unavailable', 403],
}

export async function POST(request: Request) {
  try {
    const ctx = await requireWritable(await requireRole('owner'))
    const limit = checkRateLimit(`billing:extras:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    if (!asaasConfigured()) return NextResponse.json({ error: EXTRAS_ERRORS.notConfigured }, { status: 503 })

    const body = (await request.json().catch(() => null)) as { kind?: unknown; delta?: unknown; cancel_removal?: unknown } | null
    const cancel = body?.cancel_removal === true
    const kind = body?.kind
    const delta = body?.delta
    if (!cancel && ((kind !== 'user' && kind !== 'channel') || typeof delta !== 'number')) {
      return NextResponse.json({ error: EXTRAS_ERRORS.body }, { status: 400 })
    }

    const db = supabaseAdmin()
    const today = todayInSaoPaulo()
    const result = await runExtrasChange<Refusal>(db, {
      accountId: ctx.accountId,
      actorId: ctx.userId,
      maxPerDay: MAX_EXTRAS_CHANGES_PER_DAY,
      decide: async (row): Promise<Decision<Refusal>> => {
        const cycle = row.cycle
        const subscriptionId = row.asaas_subscription_id
        const ent = await loadAccountEntitlements(db, ctx.accountId)
        if (!ent || ent.blocked || ent.status !== 'active' || row.status !== 'active' || !subscriptionId || !isBillingCycle(cycle)) {
          return { refuse: 'unavailable' }
        }
        const current = stateOf(row)
        const pending = row.pending_extra_users !== null
        const purchasePending = row.extras_oneoff_payment_id !== null

        if (cancel) {
          if (purchasePending) return { refuse: 'pending_purchase' }
          if (!pending) return { refuse: 'no_pending_removal' }
          // Once the lowered value is in Asaas the next charge may already be paid without the
          // extra: cancelling would hand out free extras. Buying again bills normally.
          if (row.extras_asaas_lowered) return { refuse: 'removal_locked' }
          return {
            next: pickNew(row, { pending_extra_users: null, pending_extra_channels: null, extras_reduce_due: null }),
            asaas: null,
            action: 'billing.extras_changed',
            metadata: { type: 'removal_cancelled', extra_users: row.extra_users, extra_channels: row.extra_channels, value_cents: Number(row.value_cents) },
          }
        }

        const k = kind as 'user' | 'channel'
        const d = delta as number
        const payments = (await listSubscriptionPayments(subscriptionId)).map((p) => ({ dueDate: p.dueDate, status: p.status }))
        const catalogDefinition = d > 0 ? (await loadCurrentPlanCatalog(db)).find((v) => v.plan === ent.plan)?.definition : undefined
        const baseLimit = baseOf(k === 'user' ? ent.limits.max_users : ent.limits.max_channels, k === 'user' ? ent.extras.users : ent.extras.channels)
        const change = changeExtras({
          cycle,
          currentValueCents: Number(row.value_cents),
          current,
          kind: k,
          delta: d,
          offeredPriceCents: (k === 'user' ? catalogDefinition?.extra_user_price_cents : catalogDefinition?.extra_channel_price_cents) ?? null,
          baseLimit,
          usage: d < 0 ? (await accountUsage(db, ctx.accountId))[k === 'user' ? 'users' : 'channels'] : 0,
          removalPending: pending,
          purchasePending,
          // A PENDING charge whose due date has passed (Asaas has not flagged it yet) is overdue too.
          overdue: payments.some((p) => p.status === 'OVERDUE' || (p.status === 'PENDING' && p.dueDate < today)),
          renewalPending: payments.some((p) => p.status === 'PENDING'),
        })
        if (!change.ok) return { refuse: change.code }

        const nextDue = nextChargeDue(payments, cycle, today) ?? addCycles(today, cycle, 1)

        if (change.type === 'add' && cycle === 'monthly') {
          return {
            next: pickNew(row, {
              extra_users: change.next.users,
              extra_channels: change.next.channels,
              extra_user_price_cents: change.next.userPriceCents,
              extra_channel_price_cents: change.next.channelPriceCents,
              value_cents: change.valueCents,
              extras_first_due: nextDue,
            }),
            // Already-generated charges follow: the extra goes into the very next charge.
            asaas: { valueCents: change.valueCents, updatePending: true },
            action: 'billing.extras_changed',
            metadata: {
              type: 'add',
              kind: k,
              delta: d,
              from: { extra_users: row.extra_users, extra_channels: row.extra_channels, value_cents: Number(row.value_cents) },
              to: { extra_users: change.next.users, extra_channels: change.next.channels, value_cents: change.valueCents },
              first_charge_due: nextDue,
            },
          }
        }

        if (change.type === 'add') {
          // Annual: charge now for the months until the renewal; the limit is released when paid.
          const unit = (k === 'user' ? change.next.userPriceCents : change.next.channelPriceCents) as number
          const months = remainingMonths(today, nextDue)
          const cents = oneOffCents(unit, d, months)
          if (!row.asaas_customer_id) return { refuse: 'unavailable' }
          const payment = await createPayment({
            customer: row.asaas_customer_id,
            value: cents / 100,
            dueDate: addDays(today, ONE_OFF_DUE_DAYS),
            description: `SempreCRM extras (${d} ${k === 'user' ? 'usuário(s)' : 'número(s)'} extra(s), ${months} mes(es) até a renovação)`,
            externalReference: ctx.accountId,
          })
          return {
            next: pickNew(row, {
              pending_add_users: k === 'user' ? d : 0,
              pending_add_channels: k === 'channel' ? d : 0,
              pending_add_user_price_cents: k === 'user' ? unit : null,
              pending_add_channel_price_cents: k === 'channel' ? unit : null,
              extras_oneoff_payment_id: payment.id,
              extras_oneoff_url: safeInvoiceUrl(payment.invoiceUrl),
              extras_oneoff_cents: cents,
              extras_oneoff_expires_at: new Date(Date.now() + ONE_OFF_EXPIRES_DAYS * 86_400_000).toISOString(),
              extras_oneoff_renewal_due: nextDue,
            }),
            asaas: null,
            action: 'billing.extras_changed',
            metadata: { type: 'add_awaiting_payment', kind: k, delta: d, months, one_off_cents: cents, payment_id: payment.id, renewal_due: nextDue },
            sideEffect: { paymentId: payment.id, cents },
            compensate: async () => {
              await deletePayment(payment.id)
            },
          }
        }

        const effective = removalDueDate(nextDue, row.extras_first_due, cycle as BillingCycle)
        return {
          next: pickNew(row, {
            pending_extra_users: change.target.users,
            pending_extra_channels: change.target.channels,
            extras_reduce_due: effective,
            extras_asaas_lowered: false,
          }),
          asaas: null,
          action: 'billing.extras_changed',
          metadata: {
            type: 'removal_scheduled',
            kind: k,
            delta: d,
            effective_date: effective,
            from: { extra_users: row.extra_users, extra_channels: row.extra_channels },
            to: { extra_users: change.target.users, extra_channels: change.target.channels },
          },
        }
      },
    })

    if (!result.ok) {
      const [key, status] = REFUSALS[result.code]
      return NextResponse.json({ error: EXTRAS_ERRORS[key] }, { status })
    }
    const r = result.row
    return NextResponse.json({
      extras: { users: r.extra_users, channels: r.extra_channels },
      valueCents: r.value_cents,
      pendingRemoval:
        r.pending_extra_users === null ? null : { users: r.pending_extra_users, channels: r.pending_extra_channels, effectiveDate: r.extras_reduce_due },
      pendingPurchase: r.extras_oneoff_payment_id === null ? null : { cents: r.extras_oneoff_cents, url: r.extras_oneoff_url },
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

function stateOf(row: BillingExtrasRow): ExtrasState {
  return {
    users: row.extra_users,
    channels: row.extra_channels,
    userPriceCents: row.extra_user_price_cents,
    channelPriceCents: row.extra_channel_price_cents,
  }
}

/** Plan limit without the extras (null = unlimited). */
function baseOf(effective: number | null, extras: number): number | null {
  return effective === null ? null : effective - extras
}
