import { describe, expect, it } from 'vitest'

import { addCycles, addDays, carryExtras, chargeIsGone, oneOffCents, remainingMonths, changeExtras, extrasCostCents, nextChargeDue, removalDueDate, subscriptionValueCents, type ExtrasState } from './extras'

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

  it('refuses an add while a charge is overdue or a purchase awaits payment', () => {
    expect(changeExtras({ ...base, kind: 'user', delta: 1, overdue: true })).toEqual({ ok: false, code: 'overdue' })
    expect(changeExtras({ ...base, kind: 'user', delta: 1, purchasePending: true })).toEqual({ ok: false, code: 'pending_purchase' })
    // removing is not an add: an overdue charge does not stop it (the account is read-only anyway)
    expect(changeExtras({ ...base, current: { ...none, users: 1, userPriceCents: 1500 }, currentValueCents: 10490, kind: 'user', delta: -1, overdue: true })).toMatchObject({ ok: true, type: 'remove' })
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

  it('the next charge is the earliest PENDING one due today or later; else one cycle after the latest', () => {
    const paid = { dueDate: '2026-12-01', status: 'RECEIVED' }
    expect(nextChargeDue([paid], 'monthly', '2026-12-05')).toBe('2027-01-01')
    expect(nextChargeDue([paid, { dueDate: '2027-01-01', status: 'PENDING' }, { dueDate: '2027-02-01', status: 'PENDING' }], 'monthly', '2026-12-05')).toBe('2027-01-01')
    expect(nextChargeDue([], 'monthly', '2026-12-05')).toBeNull()
  })

  it('an overdue or past charge never anchors the next one', () => {
    const old = { dueDate: '2026-11-01', status: 'OVERDUE' }
    expect(nextChargeDue([old, { dueDate: '2026-12-01', status: 'PENDING' }], 'monthly', '2026-11-20')).toBe('2026-12-01')
    expect(nextChargeDue([old], 'monthly', '2026-11-20')).toBe('2026-12-01') // from the latest, not from the overdue one itself
    expect(nextChargeDue([{ dueDate: '2026-11-01', status: 'PENDING' }], 'monthly', '2026-11-20')).toBe('2026-12-01')
  })

  it('the order of the list does not matter, even with more than ten charges', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ dueDate: addCycles('2025-11-01', 'monthly', i), status: 'RECEIVED' }))
    expect(nextChargeDue(many, 'monthly', '2026-12-05')).toBe('2027-01-01')
    expect(nextChargeDue([...many].reverse(), 'monthly', '2026-12-05')).toBe('2027-01-01')
  })

  it('annual one-off: months left until the renewal, rounded up, between 1 and 12', () => {
    expect(remainingMonths('2026-12-05', '2027-12-01')).toBe(12) // 361 days
    expect(remainingMonths('2027-05-01', '2027-12-01')).toBe(8) // 214 days / 30.4 = 7.04, rounded up
    expect(remainingMonths('2027-11-30', '2027-12-01')).toBe(1)
    expect(remainingMonths('2027-12-01', '2027-12-01')).toBe(1) // never zero
    expect(remainingMonths('2026-01-01', '2030-01-01')).toBe(12) // never more than 12
    // 12 months cost 10 (the annual discount): months x quantity x monthly x 10/12, rounded, at least 1 cent
    expect(oneOffCents(1500, 2, 12)).toBe(30000)
    expect(oneOffCents(1500, 1, 1)).toBe(1250)
    expect(oneOffCents(1001, 1, 1)).toBe(834) // 834.17 rounds to the cent
    expect(oneOffCents(1, 1, 1)).toBe(1) // 0.83 never rounds to a free charge
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02')
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

describe('charges that no longer exist, and the annual renewal rule', () => {
  it('removed, refunded and charged-back charges are gone; open and paid ones are not', () => {
    for (const status of ['DELETED', 'REFUNDED', 'REFUND_REQUESTED', 'CHARGEBACK_REQUESTED', 'CHARGEBACK_DISPUTE']) expect(chargeIsGone({ status }), status).toBe(true)
    expect(chargeIsGone({ status: 'PENDING', deleted: true })).toBe(true)
    for (const status of ['PENDING', 'RECEIVED', 'CONFIRMED', 'OVERDUE']) expect(chargeIsGone({ status }), status).toBe(false)
  })

  it('an annual add is refused while the renewal charge is already generated; a monthly one is not', () => {
    const base = { currentValueCents: 59900, current: none, kind: 'user' as const, delta: 1, offeredPriceCents: 1500, baseLimit: 3, usage: 1, renewalPending: true }
    expect(changeExtras({ ...base, cycle: 'annual' })).toEqual({ ok: false, code: 'renewal_pending' })
    expect(changeExtras({ ...base, cycle: 'monthly', currentValueCents: 5990 })).toMatchObject({ ok: true, type: 'add' })
    expect(changeExtras({ ...base, cycle: 'annual', renewalPending: false })).toMatchObject({ ok: true, type: 'add' })
  })
})
