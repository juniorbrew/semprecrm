import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeFakeDb } from '@/lib/lgpd/fake-db.test-helper'

import { extrasRpc } from './extras-fake.test-helper'

// The hourly sweep that carries scheduled removals of extras through their two steps:
// LOWER the Asaas value once the charge before the removal day is paid, APPLY on the day.

const h = vi.hoisted(() => ({
  fake: null as unknown as ReturnType<typeof import('@/lib/lgpd/fake-db.test-helper').makeFakeDb>,
  asaasValue: 89.9,
  calls: [] as { value: number; pending: boolean }[],
  payments: [] as { id: string; dueDate: string; status: string }[],
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
    // monthly plan paid 01/12 and 01/01, the 01/02 charge already generated
    payments: [
      { id: 'p1', dueDate: '2026-12-01', status: 'RECEIVED' },
      { id: 'p2', dueDate: '2027-01-01', status: 'RECEIVED' },
      { id: 'p3', dueDate: '2027-02-01', status: 'PENDING' },
    ],
  })
  h.fake = makeFakeDb(
    {
      account_billing: [
        {
          account_id: 'acct-1',
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
    expect(await sweepExtrasRemovals(h.fake.db, at('2027-01-20'))).toEqual({ lowered: 0, applied: 0, blocked: 0, errors: 0 })
    expect(h.calls).toEqual([])
    expect(row()).toMatchObject({ extra_users: 2, value_cents: 8990, extras_asaas_lowered: false, extras_claim_token: null })
    // even on the day itself: an unpaid charge keeps the extras
    await sweepExtrasRemovals(h.fake.db, at('2027-02-02'))
    expect(row()).toMatchObject({ extra_users: 2, pending_extra_users: 0 })
  })

  it('step 1: once the charge before the day is paid, the Asaas value drops (pending charges follow); the limit does not', async () => {
    expect(await sweepExtrasRemovals(h.fake.db, at('2027-01-20'))).toEqual({ lowered: 1, applied: 0, blocked: 0, errors: 0 })
    expect(h.calls).toEqual([{ value: 59.9, pending: true }])
    expect(row()).toMatchObject({ extra_users: 2, value_cents: 5990, extras_asaas_lowered: true, pending_extra_users: 0 })
    expect(audit('billing.extras_removal_applied')).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ step: 'lowered' }) })])
    // the next hour changes nothing before the day
    expect(await sweepExtrasRemovals(h.fake.db, at('2027-01-21'))).toEqual({ lowered: 0, applied: 0, blocked: 0, errors: 0 })
    expect(h.calls).toHaveLength(1)
  })

  it('step 2: on the day the limit drops, the schedule is cleared and the price lock released', async () => {
    await sweepExtrasRemovals(h.fake.db, at('2027-01-20'))
    expect(await sweepExtrasRemovals(h.fake.db, at('2027-02-01'))).toEqual({ lowered: 0, applied: 1, blocked: 0, errors: 0 })
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
    expect(await sweepExtrasRemovals(h.fake.db, at('2027-02-03'))).toEqual({ lowered: 1, applied: 1, blocked: 0, errors: 0 })
    expect(row()).toMatchObject({ extra_users: 0, value_cents: 5990 })
  })

  it('usage that no longer fits when it takes effect keeps the extras, audits it, and raises Asaas back if it was lowered', async () => {
    await sweepExtrasRemovals(h.fake.db, at('2027-01-20')) // lowered to 59.90
    h.used.channels = 1
    h.fake.tables.profiles.push(...[1, 2, 3, 4].map((i) => ({ user_id: `u${i}`, account_id: 'acct-1' }))) // 4 members > plan 3 + 0
    expect(await sweepExtrasRemovals(h.fake.db, at('2027-02-01'))).toEqual({ lowered: 0, applied: 0, blocked: 1, errors: 0 })
    expect(row()).toMatchObject({ extra_users: 2, value_cents: 8990, pending_extra_users: null, extras_asaas_lowered: false })
    expect(h.calls.at(-1)).toEqual({ value: 89.9, pending: true })
    expect(audit('billing.extras_removal_blocked')).toHaveLength(1)
    expect(h.fake.tables.profiles).toHaveLength(4) // nobody was touched
  })

  it('before the day, a usage that does not fit just waits', async () => {
    h.fake.tables.profiles.push(...[1, 2, 3, 4].map((i) => ({ user_id: `u${i}`, account_id: 'acct-1' })))
    expect(await sweepExtrasRemovals(h.fake.db, at('2027-01-20'))).toEqual({ lowered: 0, applied: 0, blocked: 0, errors: 0 })
    expect(h.calls).toEqual([])
    expect(row().pending_extra_users).toBe(0)
  })

  it('never touches accounts without a scheduled removal', async () => {
    await sweepExtrasRemovals(h.fake.db, at('2027-02-03'))
    expect(h.fake.tables.account_billing[1]).toMatchObject({ account_id: 'acct-2', extra_users: 1 })
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
    h.payments = [{ id: 'p1', dueDate: '2026-12-01', status: 'RECEIVED' }]
    const { changeExtras, nextChargeDue, removalDueDate } = await import('./extras')

    // 05/12: add one
    const add = changeExtras({ cycle: 'monthly', currentValueCents: 5990, current: { users: 0, channels: 0, userPriceCents: null, channelPriceCents: null }, kind: 'user', delta: 1, offeredPriceCents: 1500, baseLimit: 3, usage: 1 })
    expect(add).toMatchObject({ ok: true, type: 'add', valueCents: 7490 })
    const firstCharge = nextChargeDue(h.payments, 'monthly')
    expect(firstCharge).toBe('2027-01-01')

    // 10/12: remove it
    expect(removalDueDate(nextChargeDue(h.payments, 'monthly') as string, firstCharge, 'monthly')).toBe('2027-02-01')

    // 01/01 charge paid, 01/02 generated: the sweep lowers, then applies on 01/02
    Object.assign(row(), { extra_users: 1, extra_user_price_cents: 1500, value_cents: 7490, extras_first_due: firstCharge, pending_extra_users: 0, pending_extra_channels: 0, extras_reduce_due: '2027-02-01' })
    h.asaasValue = 74.9
    h.payments = [
      { id: 'p1', dueDate: '2026-12-01', status: 'RECEIVED' },
      { id: 'p2', dueDate: '2027-01-01', status: 'RECEIVED' },
      { id: 'p3', dueDate: '2027-02-01', status: 'PENDING' },
    ]
    await sweepExtrasRemovals(h.fake.db, at('2027-01-05'))
    expect(h.asaasValue).toBe(59.9)
    expect(row()).toMatchObject({ extra_users: 1 }) // limit still +1 until the day
    await sweepExtrasRemovals(h.fake.db, at('2027-02-01'))
    expect(row()).toMatchObject({ extra_users: 0, value_cents: 5990 })
  })
})
