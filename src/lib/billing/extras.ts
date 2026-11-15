// ============================================================
// Extras beyond the plan (migration 114): one extra user / one extra WhatsApp
// number, each with a monthly price in the plan version. Pure, so the money
// rules are what the tests pin
// (docs/superpowers/specs/2026-11-15-indicadores-e-extras.md, Parte C).
//
// Rules:
//   * Annual = the same 12-for-10 as the plan (`periodPriceCents`).
//   * The price of an extra is locked when the first one of its kind is bought
//     and kept while any of that kind remains (more of the same kind are added
//     at the locked price); at zero the lock is released.
//   * New value = stored subscription value + the change in extras cost, so a
//     legacy value is never recomputed from a catalog that has moved on.
//   * Nothing is offered without a price in the plan, and an unlimited plan
//     limit has nothing to extend.
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

export type ExtrasRefusal = 'invalid' | 'not_offered' | 'unlimited' | 'cap' | 'below_usage'

export type ExtrasChange =
  | { ok: true; next: ExtrasState; valueCents: number }
  | { ok: false; code: ExtrasRefusal }

/**
 * Adds (`delta` > 0) or removes (`delta` < 0) extras of one kind.
 * `baseLimit` is the plan limit WITHOUT extras (null = unlimited);
 * `usage` is what the account uses today (users = members + pending invites).
 * `offeredPriceCents` is the plan's current price for that extra (null = not offered).
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
}): ExtrasChange {
  const { kind, delta, current } = input
  if (!Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > MAX_EXTRAS) return { ok: false, code: 'invalid' }
  const have = kind === 'user' ? current.users : current.channels
  const lockedPrice = kind === 'user' ? current.userPriceCents : current.channelPriceCents
  const total = have + delta
  if (total < 0) return { ok: false, code: 'invalid' }
  if (total > MAX_EXTRAS) return { ok: false, code: 'cap' }
  if (input.baseLimit === null) return { ok: false, code: 'unlimited' }

  let price = lockedPrice
  if (delta > 0) {
    if (have === 0) price = input.offeredPriceCents
    if (price === null) return { ok: false, code: 'not_offered' }
  } else if (input.usage > input.baseLimit + total) {
    return { ok: false, code: 'below_usage' }
  }
  if (total === 0) price = null

  const next: ExtrasState =
    kind === 'user'
      ? { ...current, users: total, userPriceCents: price }
      : { ...current, channels: total, channelPriceCents: price }
  const valueCents = input.currentValueCents - extrasCostCents(input.cycle, current) + extrasCostCents(input.cycle, next)
  if (!Number.isSafeInteger(valueCents) || valueCents <= 0) return { ok: false, code: 'invalid' }
  return { ok: true, next, valueCents }
}
