// ============================================================
// Extras bookkeeping that waits for time or for money (migration 114), run by the
// hourly billing cron (and, for one account, when its owner opens the panel).
//
// 1. ANNUAL ADDS waiting for their one-off charge (`extras_oneoff_payment_id`):
//    paid (RECEIVED / CONFIRMED)  -> the extras are released and the subscription value
//                                    rises for the renewal (`updatePendingPayments: true`);
//    unpaid after the expiry      -> the one-off charge is cancelled in Asaas, the pending
//                                    add dropped, `billing.extras_add_cancelled` audited.
//
// 2. SCHEDULED REMOVALS (`extras_reduce_due` = due date D of the first charge that must not
//    include the extras), two steps, each a change through runExtrasChange:
//    LOWER  once the charge due just before D is PAID (so every extra was billed for its full
//           period) and the usage fits: the Asaas value drops, and with it the charges
//           generated for D onwards. From then on the removal cannot be cancelled.
//    APPLY  from day D on: the limit drops (the extras columns take the target).
//    If, when it takes effect, usage no longer fits, the extras are KEPT: the removal is
//    cancelled, Asaas is raised back for pending charges, and a one-off charge is created for
//    the difference of every lowered charge already paid that covers a period where the extras
//    stay. Audited as `billing.extras_removal_blocked`. Members are never touched.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { createPayment, deletePayment, getPayment, listSubscriptionPayments } from '@/lib/billing/asaas'
import { addCycles, addDays, extrasCostCents, nextChargeDue, type ExtrasState } from '@/lib/billing/extras'
import { accountUsage, pickNew, runExtrasChange, type BillingExtrasRow, type Decision } from '@/lib/billing/extras-service'
import { isBillingCycle, PAID_STATUSES, todayInSaoPaulo } from '@/lib/billing/rules'
import { loadAccountEntitlements } from '@/lib/plans-server'

type Skip = 'skip'
type Step = 'lowered' | 'applied' | 'blocked' | 'activated' | 'cancelled'
type Stepped = { refuse: Skip } | { step: Step; decision: Extract<Decision<Skip>, { next: unknown }> }

export interface SweepResult {
  lowered: number
  applied: number
  blocked: number
  activated: number
  cancelled: number
  errors: number
}

export async function sweepExtrasRemovals(db: SupabaseClient, now: Date = new Date()): Promise<SweepResult> {
  const out: SweepResult = { lowered: 0, applied: 0, blocked: 0, activated: 0, cancelled: 0, errors: 0 }
  const ids = new Set<string>()
  for (const column of ['pending_extra_users', 'pending_add_users']) {
    const { data, error } = await db.from('account_billing').select('account_id').eq('status', 'active').not(column, 'is', null).limit(200)
    if (error) throw new Error(`extras sweep read failed: ${error.message}`)
    for (const r of (data ?? []) as { account_id: string }[]) ids.add(r.account_id)
  }
  for (const accountId of ids) {
    try {
      await settleAccount(db, accountId, now, out)
    } catch (err) {
      out.errors++
      console.error('[billing/extras-sweep] account failed:', accountId, err instanceof Error ? err.message : err)
    }
  }
  return out
}

/** One account: the awaited purchase first, then the removal (lower, then apply when the day came). */
async function settleAccount(db: SupabaseClient, accountId: string, now: Date, out: SweepResult): Promise<void> {
  const today = todayInSaoPaulo(now)
  for (let pass = 0; pass < 3; pass++) {
    let step: Step | null = null
    const r = await runExtrasChange<Skip>(db, {
      accountId,
      actorId: null,
      maxPerDay: null,
      decide: async (row) => {
        const d = row.extras_oneoff_payment_id ? await decidePurchase(db, row, now, today) : await decideRemoval(db, row, today)
        if ('refuse' in d) return d
        step = d.step
        return d.decision
      },
    })
    if (!r.ok) {
      if (r.code === 'conflict' || r.code === 'provider') out.errors++
      return
    }
    if (step === 'lowered') out.lowered++
    else if (step === 'applied') out.applied++
    else if (step === 'blocked') out.blocked++
    else if (step === 'activated') out.activated++
    else if (step === 'cancelled') out.cancelled++
    // Only "lowered" has a natural next step (apply, if the day already came); a purchase may be followed by nothing.
    if (step !== 'lowered') return
  }
}

/** Settle the awaited annual purchase of ONE account (the owner opened the panel after paying). */
export async function settleExtrasPurchase(db: SupabaseClient, accountId: string, now: Date = new Date()): Promise<void> {
  const today = todayInSaoPaulo(now)
  await runExtrasChange<Skip>(db, {
    accountId,
    actorId: null,
    maxPerDay: null,
    decide: async (row) => {
      if (!row.extras_oneoff_payment_id) return { refuse: 'skip' }
      const d = await decidePurchase(db, row, now, today)
      return 'refuse' in d ? d : d.decision
    },
  })
}

const stateOf = (row: BillingExtrasRow): ExtrasState => ({
  users: row.extra_users,
  channels: row.extra_channels,
  userPriceCents: row.extra_user_price_cents,
  channelPriceCents: row.extra_channel_price_cents,
})

async function decidePurchase(db: SupabaseClient, row: BillingExtrasRow, now: Date, today: string): Promise<Stepped> {
  const paymentId = row.extras_oneoff_payment_id
  const cycle = row.cycle
  if (!paymentId || row.pending_add_users === null || row.pending_add_channels === null || !row.asaas_subscription_id || !isBillingCycle(cycle) || row.status !== 'active') {
    return { refuse: 'skip' }
  }
  const ent = await loadAccountEntitlements(db, row.account_id)
  if (!ent || ent.blocked) return { refuse: 'skip' }

  let status: string
  try {
    status = (await getPayment(paymentId)).status
  } catch (err) {
    if ((err as { status?: number }).status !== 404) throw err
    status = 'DELETED'
  }

  if (PAID_STATUSES.has(status)) {
    const current = stateOf(row)
    const after: ExtrasState = {
      users: row.extra_users + row.pending_add_users,
      channels: row.extra_channels + row.pending_add_channels,
      userPriceCents: row.pending_add_users > 0 ? row.pending_add_user_price_cents : row.extra_user_price_cents,
      channelPriceCents: row.pending_add_channels > 0 ? row.pending_add_channel_price_cents : row.extra_channel_price_cents,
    }
    const value = Number(row.value_cents) - extrasCostCents(cycle, current) + extrasCostCents(cycle, after)
    const payments = (await listSubscriptionPayments(row.asaas_subscription_id)).map((p) => ({ dueDate: p.dueDate, status: p.status }))
    const nextDue = nextChargeDue(payments, cycle, today) ?? addCycles(today, cycle, 1)
    return {
      step: 'activated',
      decision: {
        next: pickNew(row, {
          extra_users: after.users,
          extra_channels: after.channels,
          extra_user_price_cents: after.userPriceCents,
          extra_channel_price_cents: after.channelPriceCents,
          value_cents: value,
          // The one-off charge paid for the whole current period (until the renewal), so for the removal
          // rule the extra has been billed since the START of this period: it can leave at the renewal.
          extras_first_due: addCycles(nextDue, cycle, -1),
          ...clearedPurchase,
        }),
        // The renewal (possibly already generated) carries the extra from now on.
        asaas: { valueCents: value, updatePending: true },
        action: 'billing.extras_changed',
        metadata: {
          type: 'add_activated',
          payment_id: paymentId,
          from: { extra_users: row.extra_users, extra_channels: row.extra_channels, value_cents: Number(row.value_cents) },
          to: { extra_users: after.users, extra_channels: after.channels, value_cents: value },
        },
      },
    }
  }

  const expired = !!row.extras_oneoff_expires_at && Date.parse(row.extras_oneoff_expires_at) <= now.getTime()
  if (status !== 'DELETED' && !expired) return { refuse: 'skip' }
  // Unpaid and out of time: cancel the charge (Asaas refuses if it was paid meanwhile: the next run then activates it).
  if (status !== 'DELETED') await deletePayment(paymentId)
  return {
    step: 'cancelled',
    decision: {
      next: pickNew(row, clearedPurchase),
      asaas: null,
      action: 'billing.extras_add_cancelled',
      metadata: { reason: status === 'DELETED' ? 'charge gone in Asaas' : 'unpaid after the deadline', payment_id: paymentId, one_off_cents: row.extras_oneoff_cents },
    },
  }
}

const clearedPurchase = {
  pending_add_users: null,
  pending_add_channels: null,
  pending_add_user_price_cents: null,
  pending_add_channel_price_cents: null,
  extras_oneoff_payment_id: null,
  extras_oneoff_url: null,
  extras_oneoff_cents: null,
  extras_oneoff_expires_at: null,
} as const

async function decideRemoval(db: SupabaseClient, row: BillingExtrasRow, today: string): Promise<Stepped> {
  const due = row.extras_reduce_due
  const cycle = row.cycle
  if (!due || row.pending_extra_users === null || row.pending_extra_channels === null || !row.asaas_subscription_id || !isBillingCycle(cycle) || row.status !== 'active') {
    return { refuse: 'skip' }
  }
  const ent = await loadAccountEntitlements(db, row.account_id)
  if (!ent || ent.blocked) return { refuse: 'skip' }

  const current = stateOf(row)
  const target = { users: row.pending_extra_users, channels: row.pending_extra_channels }
  const targetState: ExtrasState = { ...current, users: target.users, channels: target.channels }
  const fullValue = row.extras_asaas_lowered
    ? Number(row.value_cents) - extrasCostCents(cycle, targetState) + extrasCostCents(cycle, current)
    : Number(row.value_cents)
  const loweredValue = fullValue - extrasCostCents(cycle, current) + extrasCostCents(cycle, targetState)

  const usage = await accountUsage(db, row.account_id)
  const baseUsers = ent.limits.max_users === null ? null : ent.limits.max_users - ent.extras.users
  const baseChannels = ent.limits.max_channels === null ? null : ent.limits.max_channels - ent.extras.channels
  const fits = (baseUsers === null || usage.users <= baseUsers + target.users) && (baseChannels === null || usage.channels <= baseChannels + target.channels)
  const dayCame = today >= due

  if (!fits) {
    if (!dayCame) return { refuse: 'skip' }
    // Keep the extras. If Asaas was lowered, charges already PAID at the lowered value cover periods
    // where the extras stay: bill the difference once, as a separate charge.
    let owedCents = 0
    if (row.extras_asaas_lowered) {
      const payments = await listSubscriptionPayments(row.asaas_subscription_id)
      for (const p of payments) {
        if (p.dueDate >= due && PAID_STATUSES.has(p.status)) owedCents += Math.max(0, fullValue - Math.round(p.value * 100))
      }
    }
    let charge: { id: string; invoiceUrl?: string | null } | null = null
    if (owedCents > 0) {
      if (!row.asaas_customer_id) throw new Error('cannot bill the difference: no Asaas customer')
      charge = await createPayment({
        customer: row.asaas_customer_id,
        value: owedCents / 100,
        dueDate: addDays(today, 3),
        description: 'SempreCRM extras mantidos (diferença de cobranças já pagas)',
        externalReference: row.account_id,
      })
    }
    const created = charge
    return {
      step: 'blocked',
      decision: {
        next: pickNew(row, { value_cents: fullValue, pending_extra_users: null, pending_extra_channels: null, extras_reduce_due: null, extras_asaas_lowered: false }),
        asaas: row.extras_asaas_lowered ? { valueCents: fullValue, updatePending: true } : null,
        action: 'billing.extras_removal_blocked',
        metadata: {
          target,
          usage,
          effective_date: due,
          kept: { extra_users: row.extra_users, extra_channels: row.extra_channels },
          owed_cents: owedCents,
          difference_payment_id: created?.id ?? null,
        },
        compensate: created ? async () => void (await deletePayment(created.id)) : undefined,
      },
    }
  }

  if (!row.extras_asaas_lowered) {
    // The charge due just before D must be paid: every extra was billed for its full period.
    const payments = await listSubscriptionPayments(row.asaas_subscription_id)
    const before = payments.filter((p) => p.dueDate < due).sort((a, b) => a.dueDate.localeCompare(b.dueDate)).at(-1)
    if (!before || !PAID_STATUSES.has(before.status)) return { refuse: 'skip' }
    return {
      step: 'lowered',
      decision: {
        next: pickNew(row, { value_cents: loweredValue, extras_asaas_lowered: true }),
        // Pending charges are all due on or after D, which no longer include the extras.
        asaas: { valueCents: loweredValue, updatePending: true },
        action: 'billing.extras_removal_applied',
        metadata: { step: 'lowered', effective_date: due, value_cents: loweredValue },
      },
    }
  }

  if (!dayCame) return { refuse: 'skip' }
  const none = target.users === 0 && target.channels === 0
  return {
    step: 'applied',
    decision: {
      next: pickNew(row, {
        extra_users: target.users,
        extra_channels: target.channels,
        extra_user_price_cents: target.users === 0 ? null : row.extra_user_price_cents,
        extra_channel_price_cents: target.channels === 0 ? null : row.extra_channel_price_cents,
        extras_first_due: none ? null : row.extras_first_due,
        pending_extra_users: null,
        pending_extra_channels: null,
        extras_reduce_due: null,
        extras_asaas_lowered: false,
      }),
      asaas: null,
      action: 'billing.extras_removal_applied',
      metadata: { step: 'applied', effective_date: due, from: { extra_users: row.extra_users, extra_channels: row.extra_channels }, to: { extra_users: target.users, extra_channels: target.channels } },
    },
  }
}
