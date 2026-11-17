import { describe, expect, it } from 'vitest'

import { addCycles, carryExtras, changeExtras, extrasCostCents, nextChargeDue, removalDueDate, subscriptionValueCents, type ExtrasState } from './extras'

const none: ExtrasState = { users: 0, channels: 0, userPriceCents: null, channelPriceCents: null }

describe('extras value math', () => {
  it('no extras costs nothing: value is the plan period price', () => {
    expect(extrasCostCents('monthly', none)).toBe(0)
    expect(subscriptionValueCents(8990, 'monthly', none)).toBe(8990)
    expect(subscriptionValueCents(8990, 'annual', none)).toBe(89900)
  })

  it('monthly: plan + extras x locked price', () => {
    const e: ExtrasState = { users: 2, channels: 1, userPriceCents: 1500, channelPriceCents: 4000 }
    expect(subscriptionValueCents(8990, 'monthly', e)).toBe(8990 + 3000 + 4000)
  })

  it('annual: extras follow the plan 12-for-10 rule', () => {
    const e: ExtrasState = { users: 2, channels: 1, userPriceCents: 1500, channelPriceCents: 4000 }
    expect(extrasCostCents('annual', e)).toBe(2 * 15000 + 40000)
    expect(subscriptionValueCents(8990, 'annual', e)).toBe(89900 + 70000)
  })

  it('a price without a quantity (or the reverse) costs nothing', () => {
    expect(extrasCostCents('monthly', { ...none, userPriceCents: 1500 })).toBe(0)
    expect(extrasCostCents('monthly', { ...none, users: 2 })).toBe(0)
  })
})

const base = { cycle: 'monthly' as const, currentValueCents: 8990, current: none, offeredPriceCents: 1500 as number | null, baseLimit: 10 as number | null, usage: 4 }

describe('changeExtras: adding', () => {
  it('locks the offered price for the first extra and adds it to the stored value', () => {
    expect(changeExtras({ ...base, kind: 'user', delta: 2 })).toEqual({ ok: true, type: 'add', next: { ...none, users: 2, userPriceCents: 1500 }, valueCents: 8990 + 3000 })
  })

  it('a locked price survives a new catalog price; more of the kind keep the locked price', () => {
    const current: ExtrasState = { ...none, users: 1, userPriceCents: 1000 }
    expect(changeExtras({ ...base, current, currentValueCents: 9990, kind: 'user', delta: 1, offeredPriceCents: 2500 })).toMatchObject({
      type: 'add',
      next: { users: 2, userPriceCents: 1000 },
      valueCents: 10990,
    })
  })

  it('annual change uses the annual extra price', () => {
    expect(changeExtras({ ...base, cycle: 'annual', currentValueCents: 89900, kind: 'channel', delta: 1, offeredPriceCents: 4000 })).toMatchObject({ valueCents: 89900 + 40000 })
  })

  it('refuses without a price, on an unlimited limit, bad quantities and the cap', () => {
    expect(changeExtras({ ...base, kind: 'user', delta: 1, offeredPriceCents: null })).toEqual({ ok: false, code: 'not_offered' })
    expect(changeExtras({ ...base, kind: 'user', delta: 1, baseLimit: null })).toEqual({ ok: false, code: 'unlimited' })
    for (const delta of [0, 1.5, NaN, 1000]) expect(changeExtras({ ...base, kind: 'user', delta })).toEqual({ ok: false, code: 'invalid' })
    const full: ExtrasState = { ...none, users: 100, userPriceCents: 1 }
    expect(changeExtras({ ...base, current: full, kind: 'user', delta: 1 })).toEqual({ ok: false, code: 'cap' })
  })

  it('refuses any change while a removal is pending', () => {
    expect(changeExtras({ ...base, kind: 'user', delta: 1, removalPending: true })).toEqual({ ok: false, code: 'pending_removal' })
    expect(changeExtras({ ...base, kind: 'user', delta: -1, removalPending: true })).toEqual({ ok: false, code: 'pending_removal' })
  })
})

describe('changeExtras: removing is a schedule, not a change of the limit', () => {
  const current: ExtrasState = { ...none, users: 2, userPriceCents: 1500 }
  const args = { ...base, current, currentValueCents: 11990, kind: 'user' as const, delta: -1 }

  it('returns the target counts and the value AFTER the removal; nothing else moves', () => {
    expect(changeExtras({ ...args, baseLimit: 3, usage: 4 })).toEqual({ ok: true, type: 'remove', target: { users: 1, channels: 0 }, valueAfterCents: 10490 })
    expect(changeExtras({ ...args, delta: -2, baseLimit: 3, usage: 3 })).toMatchObject({ type: 'remove', target: { users: 0 }, valueAfterCents: 8990 })
  })

  it('refuses below what is in use, checked against the new limit', () => {
    expect(changeExtras({ ...args, baseLimit: 3, usage: 5 })).toEqual({ ok: false, code: 'below_usage' })
  })

  it('leftover extras of an unlimited plan can always be removed; removing more than owned is invalid', () => {
    expect(changeExtras({ ...args, baseLimit: null, usage: 99 })).toMatchObject({ ok: true, type: 'remove' })
    expect(changeExtras({ ...args, delta: -3 })).toEqual({ ok: false, code: 'invalid' })
  })
})

describe('charge dates', () => {
  it('addCycles keeps the day and clamps to short months', () => {
    expect(addCycles('2026-12-01', 'monthly', 1)).toBe('2027-01-01')
    expect(addCycles('2026-01-31', 'monthly', 1)).toBe('2026-02-28')
    expect(addCycles('2026-03-15', 'annual', 1)).toBe('2027-03-15')
    expect(addCycles('2027-01-01', 'monthly', -1)).toBe('2026-12-01')
  })

  it('the next unpaid charge is the earliest unpaid one; else one cycle after the latest', () => {
    const paid = { dueDate: '2026-12-01', status: 'RECEIVED' }
    expect(nextChargeDue([paid], 'monthly')).toBe('2027-01-01')
    expect(nextChargeDue([paid, { dueDate: '2027-01-01', status: 'PENDING' }, { dueDate: '2027-02-01', status: 'PENDING' }], 'monthly')).toBe('2027-01-01')
    expect(nextChargeDue([], 'monthly')).toBeNull()
  })

  it('removal day: an extra already paid for leaves at the next charge; a fresh one is billed one full period first', () => {
    // paid 01/12, extra bought 05/12 (first charge 01/01), removal asked 10/12 -> still billed 01/01, gone from 01/02
    expect(removalDueDate('2027-01-01', '2027-01-01', 'monthly')).toBe('2027-02-01')
    // extra billed since an older charge: leaves at the very next charge
    expect(removalDueDate('2027-01-01', '2026-10-01', 'monthly')).toBe('2027-01-01')
    expect(removalDueDate('2027-01-01', null, 'monthly')).toBe('2027-01-01')
    expect(removalDueDate('2027-03-15', '2027-03-15', 'annual')).toBe('2028-03-15')
  })
})

describe('carryExtras (resubscribing)', () => {
  const held: ExtrasState = { users: 2, channels: 1, userPriceCents: 1500, channelPriceCents: 4000 }
  const plan = { maxUsers: 10, maxChannels: 2, userPriceCents: 1800, channelPriceCents: 4500 }

  it('keeps extras, with their locked prices, where the target plan can use them', () => {
    expect(carryExtras(held, plan)).toEqual(held)
  })

  it('drops a kind whose limit is unlimited or that the target plan sells no price for', () => {
    expect(carryExtras(held, { ...plan, maxUsers: null })).toEqual({ ...held, users: 0, userPriceCents: null })
    expect(carryExtras(held, { ...plan, channelPriceCents: null })).toEqual({ ...held, channels: 0, channelPriceCents: null })
    expect(carryExtras(held, { maxUsers: null, maxChannels: null, userPriceCents: null, channelPriceCents: null })).toEqual(none)
  })
})
