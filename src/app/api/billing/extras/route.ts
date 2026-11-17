// ============================================================
// POST /api/billing/extras — buy extra users / WhatsApp numbers, schedule their
// removal, or cancel a scheduled removal (migration 114; spec
// 2026-11-15-indicadores-e-extras.md, Parte C).
//
// OWNER only (like checkout), active paid account only: trial, read-only and
// blocked accounts are refused. Body { kind: 'user' | 'channel', delta } or
// { cancel_removal: true }. The account is the session's, never the body's.
//
//   delta > 0  the limit grows now; the next charge carries the extra (Asaas
//              `updatePendingPayments: true`, no proration).
//   delta < 0  nothing drops now: the extras stay until the end of the paid
//              period (and for at least one full billed period); the sweep applies
//              it. The usage check runs now and again when it takes effect.
//
// The whole change runs through runExtrasChange (extras-service.ts): per-account
// claim, Asaas first, then one transaction for the extras and their audit row.
// ============================================================

import { NextResponse } from 'next/server'

import { requireRole, requireWritable, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { asaasConfigured, listSubscriptionPayments } from '@/lib/billing/asaas'
import {
  changeExtras,
  extrasCostCents,
  nextChargeDue,
  removalDueDate,
  addCycles,
  type ExtrasRefusal,
  type ExtrasState,
} from '@/lib/billing/extras'
import { accountUsage, pickNew, runExtrasChange, type BillingExtrasRow, type Decision } from '@/lib/billing/extras-service'
import { isBillingCycle, todayInSaoPaulo, type BillingCycle } from '@/lib/billing/rules'
import { loadCurrentPlanCatalog } from '@/lib/plan-catalog-server'
import { loadAccountEntitlements } from '@/lib/plans-server'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

/** Extras changes per account in 24 h (each one edits a real subscription in Asaas). */
export const MAX_EXTRAS_CHANGES_PER_DAY = 10

export const EXTRAS_ERRORS = {
  notConfigured: 'Online payment is not available yet. Talk to the SempreCRM team.',
  body: 'Choose what to change and how many.',
  unavailable: 'Extras are only available on an active paid subscription. Subscribe first, or wait until the payment is confirmed.',
  notOffered: 'Your plan does not offer this extra. Talk to the SempreCRM team.',
  unlimited: 'Your plan has no limit here, so there is nothing to add.',
  cap: 'You reached the maximum number of extras. Talk to the SempreCRM team.',
  belowUsage: 'You are using more than the new limit would allow. Free up a user or number first.',
  pendingRemoval: 'A removal is already scheduled. Cancel it first to change the extras.',
  noPendingRemoval: 'There is no scheduled removal to cancel.',
  tooMany: 'Too many changes in the last 24 hours. Try again tomorrow or talk to the SempreCRM team.',
  conflict: 'Your subscription changed while you were doing this. Reload the page and try again.',
  provider: 'Could not change it right now, try again.',
} as const

type Refusal = ExtrasRefusal | 'unavailable' | 'no_pending_removal'

const REFUSALS: Record<Refusal | 'busy' | 'daily_cap' | 'conflict' | 'provider' | 'none', [keyof typeof EXTRAS_ERRORS, number]> = {
  invalid: ['body', 400],
  not_offered: ['notOffered', 400],
  unlimited: ['unlimited', 400],
  cap: ['cap', 400],
  below_usage: ['belowUsage', 409],
  pending_removal: ['pendingRemoval', 409],
  unavailable: ['unavailable', 403],
  no_pending_removal: ['noPendingRemoval', 409],
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

        if (cancel) {
          if (!pending) return { refuse: 'no_pending_removal' }
          // Asaas was already lowered for the charge after the removal: raise it back.
          const restored = row.extras_asaas_lowered
            ? Number(row.value_cents) -
              extrasCostCents(cycle, { ...current, users: row.pending_extra_users ?? 0, channels: row.pending_extra_channels ?? 0 }) +
              extrasCostCents(cycle, current)
            : Number(row.value_cents)
          return {
            next: pickNew(row, {
              value_cents: restored,
              pending_extra_users: null,
              pending_extra_channels: null,
              extras_reduce_due: null,
              extras_asaas_lowered: false,
            }),
            asaas: row.extras_asaas_lowered ? { valueCents: restored, updatePending: true } : null,
            action: 'billing.extras_changed',
            metadata: { type: 'removal_cancelled', extra_users: row.extra_users, extra_channels: row.extra_channels, value_cents: restored },
          }
        }

        const k = kind as 'user' | 'channel'
        const d = delta as number
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
        })
        if (!change.ok) return { refuse: change.code }

        const payments = (await listSubscriptionPayments(subscriptionId)).map((p) => ({ dueDate: p.dueDate, status: p.status }))
        const nextDue = nextChargeDue(payments, cycle) ?? addCycles(todayInSaoPaulo(), cycle, 1)

        if (change.type === 'add') {
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
