import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeFakeDb } from '@/lib/lgpd/fake-db.test-helper'

import { extrasRpc } from './extras-fake.test-helper'

// The hourly sweep that carries scheduled removals of extras through their two steps:
// LOWER the Asaas value once the charge before the removal day is paid, APPLY on the day.

const h = vi.hoisted(() => ({
  fake: null as unknown as ReturnType<typeof import('@/lib/lgpd/fake-db.test-helper').makeFakeDb>,
  asaasValue: 89.9,
  calls: [] as { value: number; pending: boolean }[],
  payments: [] as { id: string; dueDate: string; status: string; value: number }[],
  oneOffs: [] as { value: number; dueDate: string }[],
  deleted: [] as string[],
  paymentStatus: 'PENDING' as string,
  paymentGone: false,
  deleteFails: false,
  used: { users: 1, channels: 1 },
  audits: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/audit-server', () => ({
  audit: vi.fn(async (e: Record<string, unknown>) => {
    h.audits.push(e)
    return true
  }),
}))
vi.mock('@/lib/billing/asaas', () => ({
  listSubscriptionPayments: vi.fn(async () => h.payments),
  createPayment: vi.fn(async (input: { value: number; dueDate: string }) => {
    h.oneOffs.push({ value: input.value, dueDate: input.dueDate })
    return { id: 'pay_diff', status: 'PENDING', invoiceUrl: 'https://asaas.invalid/i/diff' }
  }),
  deletePayment: vi.fn(async (id: string) => {
    if (h.deleteFails) throw new Error('Asaas refuses: the charge was paid')
    h.deleted.push(id)
    return {}
  }),
  getPayment: vi.fn(async (id: string) => {
    if (h.paymentGone) throw Object.assign(new Error('not found'), { status: 404 })
    return { id, status: h.paymentStatus }
  }),
  getSubscription: vi.fn(async (id: string) => ({ id, status: 'ACTIVE', value: h.asaasValue })),
  updateSubscriptionValue: vi.fn(async (_id: string, value: number, pending: boolean) => {
    h.calls.push({ value, pending })
    h.asaasValue = value
    return { id: 'sub_1', status: 'ACTIVE', value }
  }),
}))
vi.mock('@/lib/plans-server', async () => {
  const { resolveEntitlements } = await import('@/lib/plans')
  return {
    countConnectedChannels: vi.fn(async () => h.used.channels),
    loadAccountEntitlements: vi.fn(async () => {
      const row = h.fake.tables.account_billing[0] as { extra_users: number; extra_channels: number }
      return resolveEntitlements({
        plan: 'basico',
        plan_status: 'active',
        plan_version_id: '11111111-1111-4111-8111-111111111111',
        plan_definition: { modules: [], limits: { max_users: 3, max_channels: 1 } },
        extras: { users: row.extra_users, channels: row.extra_channels },
      })
    }),
  }
})

import { sweepExtrasRemovals } from './extras-sweep'

const row = () => h.fake.tables.account_billing[0]
const at = (iso: string) => new Date(`${iso}T15:00:00Z`)
const audit = (action: string) => h.fake.tables.audit_log.filter((a) => a.action === action)

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(h, {
    asaasValue: 89.9,
    calls: [],
    audits: [],
    used: { users: 1, channels: 1 },
    oneOffs: [],
    deleted: [],
    paymentStatus: 'PENDING',
    paymentGone: false,
    deleteFails: false,
    // monthly plan paid 01/12 and 01/01, the 01/02 charge already generated
    payments: [
      { id: 'p1', dueDate: '2026-12-01', status: 'RECEIVED', value: 89.9 },
      { id: 'p2', dueDate: '2027-01-01', status: 'RECEIVED', value: 89.9 },
      { id: 'p3', dueDate: '2027-02-01', status: 'PENDING', value: 89.9 },
    ],
  })
  h.fake = makeFakeDb(
    {
      account_billing: [
        {
          account_id: 'acct-1',
          asaas_customer_id: 'cus_1',
          asaas_subscription_id: 'sub_1',
          plan: 'basico',
          cycle: 'monthly',
          status: 'active',
          value_cents: 8990, // plan 59.90 + 2 extra users at 15.00
          extra_users: 2,
          extra_channels: 0,
          extra_user_price_cents: 1500,
          extra_channel_price_cents: null,
          extras_first_due: '2027-01-01',
          // asked on 10/12 to drop both: removal day 01/02
          pending_extra_users: 0,
          pending_extra_channels: 0,
          extras_reduce_due: '2027-02-01',
          extras_asaas_lowered: false,
          pending_add_users: null,
          pending_add_channels: null,
          pending_add_user_price_cents: null,
          pending_add_channel_price_cents: null,
          extras_oneoff_payment_id: null,
          extras_oneoff_url: null,
          extras_oneoff_cents: null,
          extras_oneoff_expires_at: null,
        },
        { account_id: 'acct-2', status: 'active', extra_users: 1, pending_extra_users: null },
      ],
      profiles: [],
      account_invitations: [],
      audit_log: [],
    },
    { rpc: extrasRpc },
  )
})

describe('sweepExtrasRemovals', () => {
  it('waits while the charge before the removal day is not paid: nothing changes', async () => {
    h.payments[1].status = 'PENDING'
    expect(await sweepExtrasRemovals(h.fake.db, at('2027-01-20'))).toEqual({ lowered: 0, applied: 0, blocked: 0, activated: 0, cancelled: 0, errors: 0 })
    expect(h.calls).toEqual([])
    expect(row()).toMatchObject({ extra_users: 2, value_cents: 8990, extras_asaas_lowered: false, extras_claim_token: null })
    // even on the day itself: an unpaid charge keeps the extras
    await sweepExtrasRemovals(h.fake.db, at('2027-02-02'))
    expect(row()).toMatchObject({ extra_users: 2, pending_extra_users: 0 })
  })

  it('step 1: once the charge before the day is paid, the Asaas value drops (pending charges follow); the limit does not', async () => {
    expect(await sweepExtrasRemovals(h.fake.db, at('2027-01-20'))).toEqual({ lowered: 1, applied: 0, blocked: 0, activated: 0, cancelled: 0, errors: 0 })
    expect(h.calls).toEqual([{ value: 59.9, pending: true }])
    expect(row()).toMatchObject({ extra_users: 2, value_cents: 5990, extras_asaas_lowered: true, pending_extra_users: 0 })
    expect(audit('billing.extras_removal_applied')).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ step: 'lowered' }) })])
    // the next hour changes nothing before the day
    expect(await sweepExtrasRemovals(h.fake.db, at('2027-01-21'))).toEqual({ lowered: 0, applied: 0, blocked: 0, activated: 0, cancelled: 0, errors: 0 })
    expect(h.calls).toHaveLength(1)
  })

  it('step 2: on the day the limit drops, the schedule is cleared and the price lock released', async () => {
    await sweepExtrasRemovals(h.fake.db, at('2027-01-20'))
    expect(await sweepExtrasRemovals(h.fake.db, at('2027-02-01'))).toEqual({ lowered: 0, applied: 1, blocked: 0, activated: 0, cancelled: 0, errors: 0 })
    expect(row()).toMatchObject({
      extra_users: 0,
      extra_user_price_cents: null,
      value_cents: 5990,
      extras_first_due: null,
      pending_extra_users: null,
      extras_reduce_due: null,
      extras_asaas_lowered: false,
    })
    expect(h.calls).toHaveLength(1) // Asaas was already right
  })

  it('both steps in one run when the day already came and the charge is paid', async () => {
    expect(await sweepExtrasRemovals(h.fake.db, at('2027-02-03'))).toEqual({ lowered: 1, applied: 1, blocked: 0, activated: 0, cancelled: 0, errors: 0 })
    expect(row()).toMatchObject({ extra_users: 0, value_cents: 5990 })
  })

  it('usage that no longer fits when it takes effect keeps the extras, audits it, and raises Asaas back if it was lowered', async () => {
    await sweepExtrasRemovals(h.fake.db, at('2027-01-20')) // lowered to 59.90
    h.used.channels = 1
    h.fake.tables.profiles.push(...[1, 2, 3, 4].map((i) => ({ user_id: `u${i}`, account_id: 'acct-1' }))) // 4 members > plan 3 + 0
    expect(await sweepExtrasRemovals(h.fake.db, at('2027-02-01'))).toEqual({ lowered: 0, applied: 0, blocked: 1, activated: 0, cancelled: 0, errors: 0 })
    expect(row()).toMatchObject({ extra_users: 2, value_cents: 8990, pending_extra_users: null, extras_asaas_lowered: false })
    expect(h.calls.at(-1)).toEqual({ value: 89.9, pending: true })
    expect(audit('billing.extras_removal_blocked')).toHaveLength(1)
    expect(h.fake.tables.profiles).toHaveLength(4) // nobody was touched
  })

  it('before the day, a usage that does not fit just waits', async () => {
    h.fake.tables.profiles.push(...[1, 2, 3, 4].map((i) => ({ user_id: `u${i}`, account_id: 'acct-1' })))
    expect(await sweepExtrasRemovals(h.fake.db, at('2027-01-20'))).toEqual({ lowered: 0, applied: 0, blocked: 0, activated: 0, cancelled: 0, errors: 0 })
    expect(h.calls).toEqual([])
    expect(row().pending_extra_users).toBe(0)
  })

  it('never touches accounts without a scheduled removal', async () => {
    await sweepExtrasRemovals(h.fake.db, at('2027-02-03'))
    expect(h.fake.tables.account_billing[1]).toMatchObject({ account_id: 'acct-2', extra_users: 1 })
  })
})

describe('blocked after the lowered charge was already paid (the early-pay-then-cancel hole)', () => {
  const crowd = () => h.fake.tables.profiles.push(...[1, 2, 3, 4].map((n) => ({ user_id: `u${n}`, account_id: 'acct-1' })))

  it('keeps the extras, raises Asaas back, and bills the difference of the paid lowered charge once', async () => {
    await sweepExtrasRemovals(h.fake.db, at('2027-01-20')) // lowered to 59.90
    h.payments[2] = { id: 'p3', dueDate: '2027-02-01', status: 'RECEIVED', value: 59.9 } // the owner paid the lowered 01/02 charge early
    crowd()
    expect(await sweepExtrasRemovals(h.fake.db, at('2027-02-01'))).toEqual({ lowered: 0, applied: 0, blocked: 1, activated: 0, cancelled: 0, errors: 0 })
    expect(row()).toMatchObject({ extra_users: 2, value_cents: 8990, pending_extra_users: null, extras_asaas_lowered: false })
    expect(h.calls.at(-1)).toEqual({ value: 89.9, pending: true })
    expect(h.oneOffs).toEqual([{ value: 30, dueDate: '2027-02-04' }]) // 89,90 - 59,90, once
    expect(audit('billing.extras_removal_blocked')).toEqual([
      expect.objectContaining({ metadata: expect.objectContaining({ owed_cents: 3000, difference_payment_id: 'pay_diff' }) }),
    ])
  })

  it('nothing to bill when the lowered charge was not paid yet: pending charges just go back up', async () => {
    await sweepExtrasRemovals(h.fake.db, at('2027-01-20'))
    crowd()
    await sweepExtrasRemovals(h.fake.db, at('2027-02-01'))
    expect(h.oneOffs).toEqual([])
    expect(h.calls.at(-1)).toEqual({ value: 89.9, pending: true })
    expect(row()).toMatchObject({ extra_users: 2, pending_extra_users: null })
  })

  it('a removal never lowered owes nothing even when blocked', async () => {
    crowd()
    await sweepExtrasRemovals(h.fake.db, at('2027-02-01'))
    expect(h.oneOffs).toEqual([])
    expect(row()).toMatchObject({ extra_users: 2, value_cents: 8990 })
  })
})

describe('annual adds waiting for their one-off charge', () => {
  const awaiting = () =>
    Object.assign(row(), {
      cycle: 'annual',
      extra_users: 0,
      extra_user_price_cents: null,
      value_cents: 59900,
      extras_first_due: null,
      pending_extra_users: null,
      pending_extra_channels: null,
      extras_reduce_due: null,
      pending_add_users: 2,
      pending_add_channels: 0,
      pending_add_user_price_cents: 1500,
      pending_add_channel_price_cents: null,
      extras_oneoff_payment_id: 'pay_oneoff',
      extras_oneoff_url: 'https://asaas.invalid/i/oneoff',
      extras_oneoff_cents: 36000,
      extras_oneoff_expires_at: '2026-12-12T00:00:00.000Z',
    })
  beforeEach(() => {
    h.payments = [{ id: 'r1', dueDate: '2027-12-01', status: 'PENDING', value: 599 }]
    h.asaasValue = 599
  })

  it('paid: the limit is released, the renewal value rises (pending charges follow), the first recurring charge is the renewal', async () => {
    awaiting()
    h.paymentStatus = 'RECEIVED'
    expect(await sweepExtrasRemovals(h.fake.db, at('2026-12-06'))).toEqual({ lowered: 0, applied: 0, blocked: 0, activated: 1, cancelled: 0, errors: 0 })
    expect(h.calls).toEqual([{ value: 899, pending: true }])
    expect(row()).toMatchObject({
      extra_users: 2,
      extra_user_price_cents: 1500,
      value_cents: 89900,
      extras_first_due: '2026-12-01', // billed since the start of this annual period (the one-off)
      pending_add_users: null,
      extras_oneoff_payment_id: null,
      extras_oneoff_url: null,
    })
    expect(audit('billing.extras_changed')).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ type: 'add_activated', payment_id: 'pay_oneoff' }) })])
  })

  it('annual timeline: paid 01/12/2026, added 05/12, removed 10/12 -> billed by the one-off alone, gone at the renewal 01/12/2027', async () => {
    awaiting()
    h.paymentStatus = 'RECEIVED'
    await sweepExtrasRemovals(h.fake.db, at('2026-12-06')) // activated: limit +2, renewal value up
    // 10/12: the owner removes both. The removal day is the renewal itself (the extra was billed for this whole period).
    const { removalDueDate } = await import('./extras')
    expect(removalDueDate('2027-12-01', String(row().extras_first_due), 'annual')).toBe('2027-12-01')
    Object.assign(row(), { pending_extra_users: 0, pending_extra_channels: 0, extras_reduce_due: '2027-12-01' })
    h.payments = [
      { id: 'a1', dueDate: '2026-12-01', status: 'RECEIVED', value: 599 },
      { id: 'a2', dueDate: '2027-12-01', status: 'PENDING', value: 899 },
    ]
    h.asaasValue = 899
    await sweepExtrasRemovals(h.fake.db, at('2026-12-11')) // the 2026 charge is paid: the renewal charge drops to the plan price
    expect(h.asaasValue).toBe(599)
    expect(row()).toMatchObject({ extra_users: 2, value_cents: 59900, extras_asaas_lowered: true })
    await sweepExtrasRemovals(h.fake.db, at('2027-12-01')) // renewal day: the limit drops
    expect(row()).toMatchObject({ extra_users: 0, value_cents: 59900, pending_extra_users: null })
  })

  it('CONFIRMED counts as paid too', async () => {
    awaiting()
    h.paymentStatus = 'CONFIRMED'
    await sweepExtrasRemovals(h.fake.db, at('2026-12-06'))
    expect(row().extra_users).toBe(2)
  })

  it('unpaid before the deadline: nothing happens', async () => {
    awaiting()
    expect(await sweepExtrasRemovals(h.fake.db, at('2026-12-06'))).toEqual({ lowered: 0, applied: 0, blocked: 0, activated: 0, cancelled: 0, errors: 0 })
    expect(row()).toMatchObject({ extra_users: 0, extras_oneoff_payment_id: 'pay_oneoff' })
    expect(h.deleted).toEqual([])
  })

  it('unpaid after the deadline: the charge is cancelled, the pending add dropped, nothing granted, audited', async () => {
    awaiting()
    expect(await sweepExtrasRemovals(h.fake.db, at('2026-12-13'))).toEqual({ lowered: 0, applied: 0, blocked: 0, activated: 0, cancelled: 1, errors: 0 })
    expect(h.deleted).toEqual(['pay_oneoff'])
    expect(h.calls).toEqual([]) // the subscription value was never raised, nothing to revert
    expect(row()).toMatchObject({ extra_users: 0, value_cents: 59900, pending_add_users: null, extras_oneoff_payment_id: null })
    expect(audit('billing.extras_add_cancelled')).toHaveLength(1)
  })

  it('if Asaas refuses to cancel (it was paid meanwhile) the next run activates it instead', async () => {
    awaiting()
    h.deleteFails = true
    expect((await sweepExtrasRemovals(h.fake.db, at('2026-12-13'))).errors).toBe(1)
    expect(row()).toMatchObject({ extra_users: 0, extras_oneoff_payment_id: 'pay_oneoff' })
    h.deleteFails = false
    h.paymentStatus = 'RECEIVED'
    expect((await sweepExtrasRemovals(h.fake.db, at('2026-12-13'))).activated).toBe(1)
    expect(row().extra_users).toBe(2)
  })

  it('a charge that no longer exists in Asaas drops the pending add', async () => {
    awaiting()
    h.paymentGone = true
    expect((await sweepExtrasRemovals(h.fake.db, at('2026-12-06'))).cancelled).toBe(1)
    expect(h.deleted).toEqual([])
    expect(row().extras_oneoff_payment_id).toBeNull()
  })
})

// The timeline the owner asked for: monthly plan paid 01/12, extra added 05/12, removed 10/12.
//   05/12  limit +1 at once; Asaas value up for the next charge (pending charges follow)
//   10/12  removal scheduled for 01/02; the limit stays
//   01/01  charge WITH the extra (its first and only full period), paid
//   after  the Asaas value drops (cron, hourly); the 01/02 charge is generated without it
//   01/02  the limit drops
describe('timeline: paid 01/12, added 05/12, removed 10/12', () => {
  it('bills the extra exactly once and drops the limit on 01/02', async () => {
    Object.assign(row(), { extra_users: 0, extra_user_price_cents: null, value_cents: 5990, extras_first_due: null, pending_extra_users: null, pending_extra_channels: null, extras_reduce_due: null })
    h.asaasValue = 59.9
    h.payments = [{ id: 'p1', dueDate: '2026-12-01', status: 'RECEIVED', value: 89.9 }]
    const { changeExtras, nextChargeDue, removalDueDate } = await import('./extras')

    // 05/12: add one
    const add = changeExtras({ cycle: 'monthly', currentValueCents: 5990, current: { users: 0, channels: 0, userPriceCents: null, channelPriceCents: null }, kind: 'user', delta: 1, offeredPriceCents: 1500, baseLimit: 3, usage: 1 })
    expect(add).toMatchObject({ ok: true, type: 'add', valueCents: 7490 })
    const firstCharge = nextChargeDue(h.payments, 'monthly', '2026-12-05')
    expect(firstCharge).toBe('2027-01-01')

    // 10/12: remove it
    expect(removalDueDate(nextChargeDue(h.payments, 'monthly', '2026-12-05') as string, firstCharge, 'monthly')).toBe('2027-02-01')

    // 01/01 charge paid, 01/02 generated: the sweep lowers, then applies on 01/02
    Object.assign(row(), { extra_users: 1, extra_user_price_cents: 1500, value_cents: 7490, extras_first_due: firstCharge, pending_extra_users: 0, pending_extra_channels: 0, extras_reduce_due: '2027-02-01' })
    h.asaasValue = 74.9
    h.payments = [
      { id: 'p1', dueDate: '2026-12-01', status: 'RECEIVED', value: 89.9 },
      { id: 'p2', dueDate: '2027-01-01', status: 'RECEIVED', value: 89.9 },
      { id: 'p3', dueDate: '2027-02-01', status: 'PENDING', value: 89.9 },
    ]
    await sweepExtrasRemovals(h.fake.db, at('2027-01-05'))
    expect(h.asaasValue).toBe(59.9)
    expect(row()).toMatchObject({ extra_users: 1 }) // limit still +1 until the day
    await sweepExtrasRemovals(h.fake.db, at('2027-02-01'))
    expect(row()).toMatchObject({ extra_users: 0, value_cents: 5990 })
  })
})
