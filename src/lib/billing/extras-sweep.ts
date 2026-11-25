// ============================================================
// Extras bookkeeping that waits for time or for money (migration 116), run by the
// hourly billing cron (and, for one account, when its owner opens the panel).
//
// 1. ANNUAL ADDS waiting for their one-off charge (`extras_oneoff_payment_id`):
//    paid (RECEIVED / CONFIRMED)  -> the extras are released and the subscription value
//                                    rises for the renewal (`updatePendingPayments: true`),
//                                    BUT only if the charge is what we asked for (amount,
//                                    customer) and the renewal it was priced against has not
//                                    been paid meanwhile; otherwise nothing is released, the
//                                    purchase is dropped and `billing.extras_refund_needed`
//                                    is audited and logged `[billing:refund-needed]` (the
//                                    owner refunds by hand);
//    gone (404, deleted, refunded, charged back) -> the pending add is dropped, audited;
//    unpaid after the expiry      -> the one-off charge is cancelled in Asaas, the pending
//                                    add dropped, `billing.extras_add_cancelled` audited.
//
// 1b. DIFFERENCE CHARGES (`extras_diff_payment_id`, created when a removal is blocked): paid or
//    gone -> cleared (`billing.extras_diff_settled`); unpaid after 7 days -> cleared and the
//    subscription marked past_due (`billing.extras_diff_expired`).
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

import { createPayment, deletePayment, getPayment, listSubscriptionPayments, type AsaasPayment } from '@/lib/billing/asaas'
import { addCycles, addDays, chargeIsGone, extrasCostCents, nextChargeDue, type ExtrasState } from '@/lib/billing/extras'
import { accountUsage, pickNew, runExtrasChange, type BillingExtrasRow, type Decision } from '@/lib/billing/extras-service'
import { isBillingCycle, PAID_STATUSES, todayInSaoPaulo } from '@/lib/billing/rules'
import { loadAccountEntitlements } from '@/lib/plans-server'

type Skip = 'skip'
type Step = 'lowered' | 'applied' | 'blocked' | 'activated' | 'cancelled' | 'refund' | 'diff_settled' | 'diff_expired'
type Stepped = { refuse: Skip } | { step: Step; decision: Extract<Decision<Skip>, { next: unknown }> }

export interface SweepResult {
  lowered: number
  applied: number
  blocked: number
  activated: number
  cancelled: number
  /** Paid one-off charges that could not be released (the owner refunds them). */
  refunds: number
  /** Difference charges closed (paid, gone or expired). */
  diffs: number
  errors: number
}

const PAGE = 200
const COLUMNS = ['pending_extra_users', 'pending_add_users', 'extras_diff_payment_id']

/** Every active account with something to settle, paged by account_id (never a single capped read). */
async function accountsToSettle(db: SupabaseClient): Promise<Set<string>> {
  const ids = new Set<string>()
  for (const column of COLUMNS) {
    let last = ''
    for (;;) {
      let q = db.from('account_billing').select('account_id').eq('status', 'active').not(column, 'is', null).order('account_id').limit(PAGE)
      if (last) q = q.gt('account_id', last)
      const { data, error } = await q
      if (error) throw new Error(`extras sweep read failed: ${error.message}`)
      const rows = (data ?? []) as { account_id: string }[]
      for (const r of rows) ids.add(r.account_id)
      if (rows.length < PAGE) break
      last = rows[rows.length - 1].account_id
    }
  }
  return ids
}

export async function sweepExtrasRemovals(db: SupabaseClient, now: Date = new Date()): Promise<SweepResult> {
  const out: SweepResult = { lowered: 0, applied: 0, blocked: 0, activated: 0, cancelled: 0, refunds: 0, diffs: 0, errors: 0 }
  for (const accountId of await accountsToSettle(db)) {
    try {
      await settleAccount(db, accountId, now, out)
    } catch (err) {
      out.errors++
      console.error('[billing/extras-sweep] account failed:', accountId, err instanceof Error ? err.message : err)
    }
  }
  return out
}

/** One account: the awaited purchase, the difference charge, then the removal (lower, then apply when the day came). */
async function settleAccount(db: SupabaseClient, accountId: string, now: Date, out: SweepResult): Promise<void> {
  const today = todayInSaoPaulo(now)
  for (let pass = 0; pass < 4; pass++) {
    let step: Step | null = null
    let subscriptionId: string | null = null
    const r = await runExtrasChange<Skip>(db, {
      accountId,
      actorId: null,
      maxPerDay: null,
      decide: async (row) => {
        subscriptionId = row.asaas_subscription_id
        const d = row.extras_oneoff_payment_id
          ? await decidePurchase(db, row, now, today)
          : row.extras_diff_payment_id
            ? await decideDiff(row, now)
            : await decideRemoval(db, row, today, now)
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
    else if (step === 'refund') out.refunds++
    else if (step === 'diff_settled' || step === 'diff_expired') out.diffs++
    if (step === 'diff_expired' && subscriptionId) {
      // The unpaid difference stops the account like an unpaid renewal does (the same RPC the webhook uses).
      const { error } = await db.rpc('billing_mark_past_due', { p_account_id: accountId, p_subscription_id: subscriptionId })
      if (error) throw new Error(`could not mark past_due after an unpaid difference charge: ${error.message}`)
    }
    if (step === null) return
  }
}

/** Settle the awaited annual purchase of ONE account (the webhook of its one-off charge). */
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

/** The charge as Asaas holds it, or null when Asaas says it does not exist (404). */
async function readCharge(id: string): Promise<AsaasPayment | null> {
  try {
    return await getPayment(id)
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null
    throw err
  }
}

/** Cancel a charge; one that is already gone is as good as cancelled. */
async function cancelCharge(id: string): Promise<void> {
  try {
    await deletePayment(id)
  } catch (err) {
    if ((err as { status?: number }).status !== 404) throw err
  }
}

/** A paid one-off that must not release the extras: nothing is granted, the purchase is dropped, the owner refunds. */
function refundNeeded(row: BillingExtrasRow, paid: AsaasPayment, reason: string): Stepped {
  const cents = Math.round(paid.value * 100)
  console.error('[billing:refund-needed]', reason, 'payment', paid.id, 'cents', cents, 'account', row.account_id)
  return {
    step: 'refund',
    decision: {
      next: pickNew(row, clearedPurchase),
      asaas: null,
      action: 'billing.extras_refund_needed',
      metadata: { reason, payment_id: paid.id, cents, expected_cents: row.extras_oneoff_cents, account_id: row.account_id },
    },
  }
}

async function decidePurchase(db: SupabaseClient, row: BillingExtrasRow, now: Date, today: string): Promise<Stepped> {
  const paymentId = row.extras_oneoff_payment_id
  const cycle = row.cycle
  if (!paymentId || row.pending_add_users === null || row.pending_add_channels === null || !row.asaas_subscription_id || !isBillingCycle(cycle) || row.status !== 'active') {
    return { refuse: 'skip' }
  }
  const ent = await loadAccountEntitlements(db, row.account_id)
  if (!ent || ent.blocked) return { refuse: 'skip' }

  const charge = await readCharge(paymentId)
  const gone = charge === null || chargeIsGone(charge)

  if (charge && !gone && PAID_STATUSES.has(charge.status)) {
    // Is it the charge we asked for? (Never release on a different amount or someone else's charge.)
    if (Math.round(charge.value * 100) !== Number(row.extras_oneoff_cents)) return refundNeeded(row, charge, 'paid amount differs from the purchase')
    if (charge.customer !== row.asaas_customer_id) return refundNeeded(row, charge, 'paid by a different customer')

    const payments = (await listSubscriptionPayments(row.asaas_subscription_id)).map((p) => ({ dueDate: p.dueDate, status: p.status }))
    const nextDue = nextChargeDue(payments, cycle, today) ?? addCycles(today, cycle, 1)
    // The price covered the months up to the renewal it was made against: if that renewal was paid meanwhile, the
    // months are already covered by the plan and releasing would bill the same period twice.
    if (nextDue !== row.extras_oneoff_renewal_due) return refundNeeded(row, charge, `renewal moved from ${row.extras_oneoff_renewal_due} to ${nextDue}`)

    const current = stateOf(row)
    const after: ExtrasState = {
      users: row.extra_users + row.pending_add_users,
      channels: row.extra_channels + row.pending_add_channels,
      userPriceCents: row.pending_add_users > 0 ? row.pending_add_user_price_cents : row.extra_user_price_cents,
      channelPriceCents: row.pending_add_channels > 0 ? row.pending_add_channel_price_cents : row.extra_channel_price_cents,
    }
    const value = Number(row.value_cents) - extrasCostCents(cycle, current) + extrasCostCents(cycle, after)
    return {
      step: 'activated',
      decision: {
        next: pickNew(row, {
          extra_users: after.users,
          extra_channels: after.channels,
          extra_user_price_cents: after.userPriceCents,
          extra_channel_price_cents: after.channelPriceCents,
          value_cents: value,
          // The one-off covered the period up to the renewal, and every extra is billed at least one FULL
          // period: the renewal charge is the first full one, so the earliest removal is the renewal after it.
          extras_first_due: nextDue,
          ...clearedPurchase,
          extras_oneoff_paid_id: paymentId,
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
  if (!gone && !expired) return { refuse: 'skip' }
  // Gone, or unpaid and out of time: cancel the charge (Asaas refuses if it was paid meanwhile: the next run then activates it).
  if (!gone) await cancelCharge(paymentId)
  return {
    step: 'cancelled',
    decision: {
      next: pickNew(row, clearedPurchase),
      asaas: null,
      action: 'billing.extras_add_cancelled',
      metadata: { reason: gone ? 'charge gone in Asaas' : 'unpaid after the deadline', payment_id: paymentId, one_off_cents: row.extras_oneoff_cents },
    },
  }
}

/** The difference charge of a blocked removal: paid or gone closes it; unpaid past its expiry stops the account. */
async function decideDiff(row: BillingExtrasRow, now: Date): Promise<Stepped> {
  const id = row.extras_diff_payment_id
  if (!id || row.status !== 'active') return { refuse: 'skip' }
  const charge = await readCharge(id)
  const cleared = { extras_diff_payment_id: null, extras_diff_expires_at: null }
  if (charge === null || chargeIsGone(charge) || PAID_STATUSES.has(charge.status)) {
    const reason = charge === null || chargeIsGone(charge) ? 'gone' : 'paid'
    return {
      step: 'diff_settled',
      decision: { next: pickNew(row, cleared), asaas: null, action: 'billing.extras_diff_settled', metadata: { reason, payment_id: id, status: charge?.status ?? 'NOT_FOUND' } },
    }
  }
  if (!row.extras_diff_expires_at || Date.parse(row.extras_diff_expires_at) > now.getTime()) return { refuse: 'skip' }
  return {
    step: 'diff_expired',
    decision: { next: pickNew(row, cleared), asaas: null, action: 'billing.extras_diff_expired', metadata: { payment_id: id, status: charge.status, expires_at: row.extras_diff_expires_at } },
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
  extras_oneoff_renewal_due: null,
} as const

/** Days the owner has to pay the difference charge of a blocked removal before the account is marked past_due. */
const DIFF_EXPIRES_DAYS = 7

async function decideRemoval(db: SupabaseClient, row: BillingExtrasRow, today: string, now: Date): Promise<Stepped> {
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
        // ponytail: one difference charge is tracked at a time; a second blocked removal inside its 7 days replaces the id.
        next: pickNew(row, {
          value_cents: fullValue,
          pending_extra_users: null,
          pending_extra_channels: null,
          extras_reduce_due: null,
          extras_asaas_lowered: false,
          ...(created ? { extras_diff_payment_id: created.id, extras_diff_expires_at: new Date(now.getTime() + DIFF_EXPIRES_DAYS * 86_400_000).toISOString() } : {}),
        }),
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
        sideEffect: created ? { paymentId: created.id, cents: owedCents } : undefined,
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
