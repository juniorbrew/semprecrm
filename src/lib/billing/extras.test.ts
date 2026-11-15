import { describe, expect, it } from 'vitest'

import { changeExtras, extrasCostCents, subscriptionValueCents, type ExtrasState } from './extras'

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

describe('changeExtras', () => {
  it('adding the first extra locks the offered price and adds it to the stored value', () => {
    const r = changeExtras({ ...base, kind: 'user', delta: 2 })
    expect(r).toEqual({ ok: true, next: { ...none, users: 2, userPriceCents: 1500 }, valueCents: 8990 + 3000 })
  })

  it('a locked price survives a new catalog price; more extras of the kind keep the locked price', () => {
    const current: ExtrasState = { ...none, users: 1, userPriceCents: 1000 }
    const r = changeExtras({ ...base, current, currentValueCents: 9990, kind: 'user', delta: 1, offeredPriceCents: 2500 })
    expect(r).toMatchObject({ ok: true, next: { users: 2, userPriceCents: 1000 }, valueCents: 10990 })
  })

  it('a price removed from the plan blocks the first extra but not the removal', () => {
    const current: ExtrasState = { ...none, users: 1, userPriceCents: 1000 }
    expect(changeExtras({ ...base, kind: 'user', delta: 1, offeredPriceCents: null })).toEqual({ ok: false, code: 'not_offered' })
    expect(changeExtras({ ...base, current, currentValueCents: 9990, kind: 'user', delta: -1, offeredPriceCents: null })).toMatchObject({
      ok: true,
      next: { users: 0, userPriceCents: null },
      valueCents: 8990,
    })
  })

  it('annual change uses the annual extra price', () => {
    const r = changeExtras({ ...base, cycle: 'annual', currentValueCents: 89900, kind: 'channel', delta: 1, offeredPriceCents: 4000 })
    expect(r).toMatchObject({ ok: true, valueCents: 89900 + 40000 })
  })

  it('refuses removing below usage; allows it when usage fits', () => {
    const current: ExtrasState = { ...none, users: 2, userPriceCents: 1500 }
    const args = { ...base, current, currentValueCents: 11990, kind: 'user' as const, delta: -1 }
    expect(changeExtras({ ...args, baseLimit: 3, usage: 5 })).toEqual({ ok: false, code: 'below_usage' })
    expect(changeExtras({ ...args, baseLimit: 3, usage: 4 })).toMatchObject({ ok: true, next: { users: 1 } })
  })

  it('refuses unlimited limits, bad quantities, removing more than owned, and the cap', () => {
    expect(changeExtras({ ...base, kind: 'user', delta: 1, baseLimit: null })).toEqual({ ok: false, code: 'unlimited' })
    for (const delta of [0, 1.5, NaN, 1000]) expect(changeExtras({ ...base, kind: 'user', delta })).toEqual({ ok: false, code: 'invalid' })
    expect(changeExtras({ ...base, kind: 'user', delta: -1 })).toEqual({ ok: false, code: 'invalid' })
    const full: ExtrasState = { ...none, users: 100, userPriceCents: 1 }
    expect(changeExtras({ ...base, current: full, kind: 'user', delta: 1 })).toEqual({ ok: false, code: 'cap' })
  })
})
