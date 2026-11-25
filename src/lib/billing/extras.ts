// ============================================================
// Extras beyond the plan (migration 116): one extra user / one extra WhatsApp
// number, each with a monthly price in the plan version. Pure, so the money
// rules are what the tests pin
// (docs/superpowers/specs/2026-11-15-indicadores-e-extras.md, Parte C).
//
// Rules (owner decisions):
//   * Annual = the same 12-for-10 as the plan (`periodPriceCents`).
//   * ADDING takes effect at once for the limit and goes into the next charge,
//     even one already generated (Asaas `updatePendingPayments: true`).
//   * REMOVING never lowers the limit now: the extras stay until the end of the
//     period that is already paid, and every extra is billed for at least one
//     full period (`removalDueDate`). The charge due on that date no longer
//     includes them; a sweep applies it (extras-sweep.ts).
//   * The price of an extra is locked when the first one of its kind is bought
//     and kept while any of that kind remains; at zero the lock is released.
//   * New value = stored subscription value + the change in extras cost, so a
//     legacy value is never recomputed from a catalog that has moved on.
//   * Nothing is offered without a price in the plan, and an unlimited plan
//     limit has nothing to extend (but extras left over can always be removed).
// ============================================================

import { MAX_EXTRAS } from '../plans'
import { periodPriceCents, type BillingCycle } from './rules'

export type ExtraKind = 'user' | 'channel'

export interface ExtrasState {
  users: number
  channels: number
  /** Locked monthly price (cents) of each kind; null while none is contracted. */
  userPriceCents: number | null
  channelPriceCents: number | null
}

/** Cost of the extras in one billing period, in cents. */
export function extrasCostCents(cycle: BillingCycle, e: ExtrasState): number {
  const part = (n: number, monthly: number | null) => (n > 0 && monthly !== null ? n * periodPriceCents(monthly, cycle) : 0)
  return part(e.users, e.userPriceCents) + part(e.channels, e.channelPriceCents)
}

/** Subscription value of one period: the plan's period price plus the extras. */
export function subscriptionValueCents(planMonthlyCents: number, cycle: BillingCycle, e: ExtrasState): number {
  return periodPriceCents(planMonthlyCents, cycle) + extrasCostCents(cycle, e)
}

// ---------------- dates (YYYY-MM-DD, due dates of Asaas charges) ----------------

/** `date` plus (or minus) `n` cycles, clamping to the last day of a shorter month. */
export function addCycles(date: string, cycle: BillingCycle, n: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const months = (cycle === 'annual' ? 12 : 1) * n
  const first = new Date(Date.UTC(y, m - 1 + months, 1))
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10)
}

/**
 * Due date of the next charge still to come: the earliest PENDING charge due today or later
 * (Asaas already generated it), otherwise one cycle after the latest charge. Overdue charges
 * never anchor it (the add path refuses while any is overdue). null with no charge at all.
 */
export function nextChargeDue(payments: { dueDate: string; status: string }[], cycle: BillingCycle, today: string): string | null {
  const coming = payments.filter((p) => p.status === 'PENDING' && p.dueDate >= today).map((p) => p.dueDate).sort()
  if (coming.length > 0) return coming[0]
  const latest = payments.map((p) => p.dueDate).sort().at(-1)
  return latest ? addCycles(latest, cycle, 1) : null
}

/** `date` plus `n` days (YYYY-MM-DD). */
export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
}

/** Whole days from `from` to `to` (YYYY-MM-DD), never negative. */
export function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)
  return Math.max(0, Math.round(ms / 86_400_000))
}

/**
 * Annual subscriptions charge an add at once, for the months left until the renewal:
 * ceil(days / 30.4), at least 1 and at most 12 (so never zero, never more than 12 x monthly).
 */
export function remainingMonths(today: string, renewalDue: string): number {
  return Math.min(12, Math.max(1, Math.ceil(daysBetween(today, renewalDue) / 30.4)))
}

/**
 * The one-off charge, in cents: months x quantity x the locked monthly price x 10/12 (the annual
 * discount: 12 months cost 10), rounded to the cent, never below 1 cent.
 */
export function oneOffCents(unitMonthlyCents: number, quantity: number, months: number): number {
  return Math.max(1, Math.round((months * quantity * unitMonthlyCents * 10) / 12))
}

/** A charge that no longer exists as something to pay: removed, refunded or charged back. */
export function chargeIsGone(p: { status: string; deleted?: boolean }): boolean {
  return p.deleted === true || p.status === 'DELETED' || p.status === 'REFUNDED' || p.status === 'REFUND_REQUESTED' || p.status.startsWith('CHARGEBACK')
}

/**
 * Due date of the first charge that must NOT include a removed extra, and the
 * day the limit drops. `nextDue` = the next unpaid charge (the end of the
 * paid period); `firstDue` = the first charge that included the newest extra.
 * Every extra is billed for one full period: removal waits until one cycle
 * after `firstDue`.
 */
export function removalDueDate(nextDue: string, firstDue: string | null, cycle: BillingCycle): string {
  if (!firstDue) return nextDue
  const floor = addCycles(firstDue, cycle, 1)
  return floor > nextDue ? floor : nextDue
}

// ---------------- changes ----------------

export type ExtrasRefusal =
  | 'invalid'
  | 'not_offered'
  | 'unlimited'
  | 'cap'
  | 'below_usage'
  | 'pending_removal'
  | 'pending_purchase'
  | 'overdue'
  | 'renewal_pending'

export type ExtrasChange =
  | { ok: true; type: 'add'; next: ExtrasState; valueCents: number }
  | { ok: true; type: 'remove'; target: { users: number; channels: number }; valueAfterCents: number }
  | { ok: false; code: ExtrasRefusal }

/**
 * Adds (`delta` > 0, immediate) or removes (`delta` < 0, scheduled) extras of one kind.
 * `baseLimit` is the plan limit WITHOUT extras (null = unlimited); `usage` is what the
 * account uses today (users = members + pending invites). `offeredPriceCents` is the plan's
 * current price for that extra (null = not offered). Only one removal can be pending, and
 * nothing can be added or removed while one is: cancel it first. Adds are also refused while a
 * purchase awaits payment or a charge is overdue.
 */
export function changeExtras(input: {
  cycle: BillingCycle
  currentValueCents: number
  current: ExtrasState
  kind: ExtraKind
  delta: number
  offeredPriceCents: number | null
  baseLimit: number | null
  usage: number
  removalPending?: boolean
  /** An annual add is waiting for its one-off charge to be paid. */
  purchasePending?: boolean
  /** Some charge of the subscription is overdue: nothing is added until it is regularised. */
  overdue?: boolean
  /** Annual only: the renewal charge is already generated, so a one-off priced against it would be stale. */
  renewalPending?: boolean
}): ExtrasChange {
  const { kind, delta, current } = input
  if (!Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > MAX_EXTRAS) return { ok: false, code: 'invalid' }
  if (input.purchasePending) return { ok: false, code: 'pending_purchase' }
  if (input.removalPending) return { ok: false, code: 'pending_removal' }
  const have = kind === 'user' ? current.users : current.channels
  const lockedPrice = kind === 'user' ? current.userPriceCents : current.channelPriceCents
  const total = have + delta
  if (total < 0) return { ok: false, code: 'invalid' }
  if (total > MAX_EXTRAS) return { ok: false, code: 'cap' }

  if (delta < 0) {
    // Leftover extras of an unlimited plan can always go; otherwise usage must fit the new limit.
    if (input.baseLimit !== null && input.usage > input.baseLimit + total) return { ok: false, code: 'below_usage' }
    const target = { users: current.users, channels: current.channels }
    if (kind === 'user') target.users = total
    else target.channels = total
    const after: ExtrasState = {
      users: target.users,
      channels: target.channels,
      userPriceCents: target.users === 0 ? null : current.userPriceCents,
      channelPriceCents: target.channels === 0 ? null : current.channelPriceCents,
    }
    const valueAfterCents = input.currentValueCents - extrasCostCents(input.cycle, current) + extrasCostCents(input.cycle, after)
    if (!Number.isSafeInteger(valueAfterCents) || valueAfterCents <= 0) return { ok: false, code: 'invalid' }
    return { ok: true, type: 'remove', target, valueAfterCents }
  }

  if (input.baseLimit === null) return { ok: false, code: 'unlimited' }
  if (input.overdue) return { ok: false, code: 'overdue' }
  if (input.renewalPending && input.cycle === 'annual') return { ok: false, code: 'renewal_pending' }
  const price = have === 0 ? input.offeredPriceCents : lockedPrice
  if (price === null) return { ok: false, code: 'not_offered' }
  const next: ExtrasState =
    kind === 'user' ? { ...current, users: total, userPriceCents: price } : { ...current, channels: total, channelPriceCents: price }
  const valueCents = input.currentValueCents - extrasCostCents(input.cycle, current) + extrasCostCents(input.cycle, next)
  if (!Number.isSafeInteger(valueCents) || valueCents <= 0) return { ok: false, code: 'invalid' }
  return { ok: true, type: 'add', next, valueCents }
}

/**
 * Extras that may stay on an account moving to a (new) plan: a kind whose limit in
 * the target plan is unlimited, or that the target plan sells no price for, is dropped
 * (with its locked price), so no useless extra keeps being billed.
 */
export function carryExtras(
  current: ExtrasState,
  target: { maxUsers: number | null; maxChannels: number | null; userPriceCents: number | null; channelPriceCents: number | null },
): ExtrasState {
  const keepUsers = current.users > 0 && target.maxUsers !== null && target.userPriceCents !== null
  const keepChannels = current.channels > 0 && target.maxChannels !== null && target.channelPriceCents !== null
  return {
    users: keepUsers ? current.users : 0,
    channels: keepChannels ? current.channels : 0,
    userPriceCents: keepUsers ? current.userPriceCents : null,
    channelPriceCents: keepChannels ? current.channelPriceCents : null,
  }
}
