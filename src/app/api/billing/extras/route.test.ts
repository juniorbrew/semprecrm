import { beforeEach, describe, expect, it, vi } from 'vitest'

import { extrasRpc } from '@/lib/billing/extras-fake.test-helper'
import { makeFakeDb } from '@/lib/lgpd/fake-db.test-helper'

// ------------------------------------------------------------
// POST /api/billing/extras — OWNER only, active paid account only. Adding goes
// to Asaas first (pending charges follow), removing is only scheduled, one
// change at a time per account; never a real Asaas call.
// ------------------------------------------------------------

const VERSION = '11111111-1111-4111-8111-111111111111'

const h = vi.hoisted(() => ({
  fake: null as unknown as ReturnType<typeof import('@/lib/lgpd/fake-db.test-helper').makeFakeDb>,
  role: 'owner',
  readOnly: false,
  status: 'active',
  channels: 0,
  price: { user: 1500 as number | undefined, channel: 4000 as number | undefined },
  planLimits: { max_users: 3 as number | null, max_channels: 1 as number | null },
  asaasValue: 59.9,
  calls: [] as { id: string; value: number; pending: boolean }[],
  onAsaas: null as null | (() => void),
  updateFails: false as false | 'before' | 'after',
  getFails: false,
  payments: [{ id: 'p1', dueDate: '2026-12-01', status: 'RECEIVED', value: 59.9 }] as { id: string; dueDate: string; status: string; value: number }[],
  oneOffs: [] as { customer: string; value: number; dueDate: string }[],
  deleted: [] as string[],
  audits: [] as Record<string, unknown>[],
  /** 'landed' = the commit is applied but its answer is lost; 'lost' = it never reaches the database. */
  commitMode: null as null | 'landed' | 'lost',
}))

vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => h.fake.db }))
// The per-minute limiter is per process and would trip over this many requests; the daily cap is what is tested.
vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rate-limit')>()),
  checkRateLimit: () => ({ success: true }),
}))
vi.mock('@/lib/audit-server', () => ({
  audit: vi.fn(async (entry: Record<string, unknown>) => {
    h.audits.push(entry)
    return true
  }),
}))
vi.mock('@/lib/plan-catalog-server', () => ({
  loadCurrentPlanCatalog: vi.fn(async () => [
    {
      id: VERSION,
      plan: 'basico',
      revision: 2,
      definition: {
        modules: [],
        limits: h.planLimits,
        ...(h.price.user === undefined ? {} : { extra_user_price_cents: h.price.user }),
        ...(h.price.channel === undefined ? {} : { extra_channel_price_cents: h.price.channel }),
      },
      price_monthly_cents: 5990,
    },
  ]),
}))
vi.mock('@/lib/plans-server', async () => {
  const { resolveEntitlements } = await import('@/lib/plans')
  return {
    countConnectedChannels: vi.fn(async () => h.channels),
    loadAccountEntitlements: vi.fn(async () => {
      const row = h.fake.tables.account_billing[0] as { extra_users: number; extra_channels: number } | undefined
      return resolveEntitlements({
        plan: 'basico',
        plan_status: h.status,
        plan_version_id: '11111111-1111-4111-8111-111111111111',
        plan_definition: { modules: [], limits: h.planLimits },
        extras: row ? { users: row.extra_users, channels: row.extra_channels } : null,
      })
    }),
  }
})
vi.mock('@/lib/billing/asaas', () => ({
  asaasConfigured: vi.fn(() => true),
  listSubscriptionPayments: vi.fn(async () => h.payments),
  createPayment: vi.fn(async (input: { customer: string; value: number; dueDate: string }) => {
    h.oneOffs.push({ customer: input.customer, value: input.value, dueDate: input.dueDate })
    return { id: 'pay_oneoff_' + h.oneOffs.length, status: 'PENDING', invoiceUrl: 'https://asaas.invalid/i/oneoff' }
  }),
  deletePayment: vi.fn(async (id: string) => {
    h.deleted.push(id)
    return {}
  }),
  getSubscription: vi.fn(async (id: string) => {
    if (h.getFails) throw new Error('Asaas down')
    return { id, status: 'ACTIVE', value: h.asaasValue }
  }),
  updateSubscriptionValue: vi.fn(async (id: string, value: number, pending: boolean) => {
    h.calls.push({ id, value, pending })
    const mode = h.updateFails
    h.updateFails = false // one failure only: the reconcile call after it works
    if (mode === 'before') throw new Error('Asaas down')
    h.asaasValue = value
    if (mode === 'after') throw new Error('timeout: the value was applied')
    h.onAsaas?.()
    return { id, status: 'ACTIVE', value }
  }),
}))
vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>()
  return {
    ...actual,
    requireRole: vi.fn(async (min: string) => {
      if (min === 'owner' && h.role !== 'owner') throw new actual.ForbiddenError("This action requires the 'owner' role or higher")
      return { userId: `user-${h.role}`, accountId: 'acct-1', role: h.role }
    }),
    requireWritable: vi.fn(async (ctx: unknown) => {
      if (h.readOnly) throw new actual.ReadOnlyError('past_due')
      return ctx
    }),
  }
})

import * as asaas from '@/lib/billing/asaas'
import { POST } from './route'

function change(body: unknown) {
  return POST(new Request('http://localhost/api/billing/extras', { method: 'POST', body: JSON.stringify(body) }))
}
const billing = () => h.fake.tables.account_billing[0]
const changed = () => h.fake.tables.audit_log.filter((a) => a.action === 'billing.extras_changed')

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(h, {
    role: 'owner',
    readOnly: false,
    status: 'active',
    channels: 0,
    price: { user: 1500, channel: 4000 },
    planLimits: { max_users: 3, max_channels: 1 },
    asaasValue: 59.9,
    calls: [],
    onAsaas: null,
    updateFails: false,
    getFails: false,
    payments: [{ id: 'p1', dueDate: '2026-12-01', status: 'RECEIVED', value: 59.9 }],
    oneOffs: [],
    deleted: [],
    audits: [],
    commitMode: null,
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
          value_cents: 5990,
          extra_users: 0,
          extra_channels: 0,
          extra_user_price_cents: null,
          extra_channel_price_cents: null,
          extras_first_due: null,
          pending_extra_users: null,
          pending_extra_channels: null,
          extras_reduce_due: null,
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
      ],
      profiles: [{ user_id: 'u1', account_id: 'acct-1' }, { user_id: 'u2', account_id: 'acct-1' }],
      account_invitations: [],
      audit_log: [],
    },
    {
      rpc: (fn, args, tables) => {
        if (fn === 'billing_extras_commit' && h.commitMode) {
          if (h.commitMode === 'landed') extrasRpc(fn, args, tables)
          return { data: null, error: { message: 'connection reset' } }
        }
        return extrasRpc(fn, args, tables)
      },
    },
  )
})

describe('adding extras', () => {
  it('Asaas gets the new value first (pending charges follow), then the row and its audit row are saved together', async () => {
    const res = await change({ kind: 'user', delta: 2, account_id: 'acct-other' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ extras: { users: 2, channels: 0 }, valueCents: 8990, pendingRemoval: null, pendingPurchase: null })
    expect(h.calls).toEqual([{ id: 'sub_1', value: 89.9, pending: true }])
    expect(billing()).toMatchObject({ extra_users: 2, extra_user_price_cents: 1500, value_cents: 8990, extras_first_due: '2027-01-01', extras_claim_token: null })
    expect(changed()).toEqual([
      expect.objectContaining({
        account_id: 'acct-1',
        actor_user_id: 'user-owner',
        metadata: expect.objectContaining({
          type: 'add',
          kind: 'user',
          delta: 2,
          from: { extra_users: 0, extra_channels: 0, value_cents: 5990 },
          to: { extra_users: 2, extra_channels: 0, value_cents: 8990 },
        }),
      }),
    ])
  })

  it('OVERDUE charge: nothing is added until it is regularised', async () => {
    h.payments = [{ id: 'p1', dueDate: '2026-11-01', status: 'OVERDUE', value: 59.9 }]
    const res = await change({ kind: 'user', delta: 1 })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Regularize the pending payment first.' })
    expect(h.calls).toEqual([])
    expect(billing().extra_users).toBe(0)
  })

  it('a PENDING charge whose due date passed counts as overdue (Asaas has not flagged it yet)', async () => {
    h.payments = [
      { id: 'p1', dueDate: '2026-12-01', status: 'RECEIVED', value: 59.9 },
      { id: 'p2', dueDate: '2020-01-01', status: 'PENDING', value: 59.9 },
    ]
    expect((await change({ kind: 'user', delta: 1 })).status).toBe(409)
    expect(h.calls).toEqual([])
  })

  it('the charge list is read whole: >10 charges oldest-first still find the right next charge', async () => {
    h.payments = Array.from({ length: 14 }, (_, i) => ({ id: 'p' + i, dueDate: new Date(Date.UTC(2025, 11 + i, 1)).toISOString().slice(0, 10), status: 'RECEIVED', value: 59.9 }))
    // latest charge 2027-01-01 (index 13): next charge 2027-02-01
    expect((await change({ kind: 'user', delta: 1 })).status).toBe(200)
    expect(billing().extras_first_due).toBe('2027-02-01')
  })

  it('a locked price survives a new plan price', async () => {
    Object.assign(billing(), { extra_users: 1, extra_user_price_cents: 1000, value_cents: 6990 })
    h.price.user = 2500
    expect(await (await change({ kind: 'user', delta: 1 })).json()).toMatchObject({ extras: { users: 2 }, valueCents: 7990 })
    expect(billing().extra_user_price_cents).toBe(1000)
  })

  it('offers nothing without a price, and nothing on an unlimited limit', async () => {
    h.price.user = undefined
    expect((await change({ kind: 'user', delta: 1 })).status).toBe(400)
    h.price.user = 1500
    h.planLimits.max_users = null
    expect((await change({ kind: 'user', delta: 1 })).status).toBe(400)
    expect(asaas.updateSubscriptionValue).not.toHaveBeenCalled()
    expect(billing()).toMatchObject({ extra_users: 0, value_cents: 5990 })
  })

  it('rejects bad bodies', async () => {
    for (const body of [null, {}, { kind: 'plan', delta: 1 }, { kind: 'user', delta: '1' }, { kind: 'user', delta: 0 }, { kind: 'user', delta: 1.5 }, { kind: 'user', delta: 101 }]) {
      expect((await change(body)).status, JSON.stringify(body)).toBe(400)
    }
    expect(asaas.updateSubscriptionValue).not.toHaveBeenCalled()
  })
})

describe('annual subscriptions: a one-off charge now, the limit when it is paid', () => {
  const annual = () => Object.assign(billing(), { cycle: 'annual', value_cents: 59900 })
  beforeEach(() => {
    h.payments = [{ id: 'p1', dueDate: '2026-12-01', status: 'RECEIVED', value: 599 }] // paid; the renewal (2027-12-01) is not generated yet
  })

  it('creates the prorated one-off charge (months to the renewal x monthly price), changes neither limit nor subscription value', async () => {
    annual()
    const res = await change({ kind: 'user', delta: 2 })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.extras).toEqual({ users: 0, channels: 0 })
    expect(body.pendingPurchase).toEqual({ cents: expect.any(Number), url: 'https://asaas.invalid/i/oneoff' })
    // months = ceil(days to 01/12/2027 / 30.4), 1..12; amount = months x 2 x 15,00
    expect(h.oneOffs).toHaveLength(1)
    const cents = body.pendingPurchase.cents
    // 12 months cost 10: months x 2 x 15,00 x 10/12 = months x 25,00
    expect(cents % 2500).toBe(0)
    expect(cents / 2500).toBeGreaterThanOrEqual(1)
    expect(cents / 2500).toBeLessThanOrEqual(12)
    expect(h.oneOffs[0]).toMatchObject({ customer: 'cus_1', value: cents / 100 })
    expect(h.calls).toEqual([]) // the subscription value waits for the payment
    expect(billing()).toMatchObject({
      extra_users: 0,
      value_cents: 59900,
      pending_add_users: 2,
      pending_add_channels: 0,
      pending_add_user_price_cents: 1500,
      extras_oneoff_payment_id: 'pay_oneoff_1',
      extras_oneoff_url: 'https://asaas.invalid/i/oneoff',
      extras_oneoff_cents: cents,
      extras_oneoff_renewal_due: '2027-12-01',
    })
    expect(new Date(String(billing().extras_oneoff_expires_at)).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000)
    expect(changed()).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ type: 'add_awaiting_payment', payment_id: 'pay_oneoff_1', one_off_cents: cents }) })])
  })

  it('while a purchase awaits payment nothing else can be changed or cancelled', async () => {
    annual()
    await change({ kind: 'user', delta: 1 })
    for (const body of [{ kind: 'user', delta: 1 }, { kind: 'channel', delta: 1 }, { kind: 'user', delta: -1 }, { cancel_removal: true }]) {
      expect((await change(body)).status, JSON.stringify(body)).toBe(409)
    }
    expect(h.oneOffs).toHaveLength(1)
  })

  it('if the commit is lost, the one-off charge is cancelled again (no orphan charge)', async () => {
    annual()
    // another change wins the compare-and-swap while ours is in Asaas
    vi.mocked(asaas.createPayment).mockImplementationOnce(async () => {
      Object.assign(billing(), { value_cents: 61900 })
      return { id: 'pay_lost', status: 'PENDING', invoiceUrl: 'https://asaas.invalid/i/lost' } as never
    })
    expect((await change({ kind: 'user', delta: 1 })).status).toBe(409)
    expect(h.deleted).toEqual(['pay_lost'])
    expect(billing().extras_oneoff_payment_id).toBeNull()
  })

  it('refuses while the renewal charge is already generated (the price would be stale)', async () => {
    annual()
    h.payments = [
      { id: 'p1', dueDate: '2026-12-01', status: 'RECEIVED', value: 599 },
      { id: 'p2', dueDate: '2027-12-01', status: 'PENDING', value: 599 },
    ]
    const res = await change({ kind: 'user', delta: 1 })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/renewal charge was already generated/)
    expect(h.oneOffs).toEqual([])
  })

  it('a commit whose answer is lost but that DID land keeps the charge (the row points to it)', async () => {
    annual()
    h.commitMode = 'landed'
    const res = await change({ kind: 'user', delta: 1 })
    expect(res.status).toBe(200)
    expect(h.deleted).toEqual([])
    expect(billing().extras_oneoff_payment_id).toBe('pay_oneoff_1')
  })

  it('a commit that is lost and did NOT land cancels the charge', async () => {
    annual()
    h.commitMode = 'lost'
    expect((await change({ kind: 'user', delta: 1 })).status).toBe(500)
    expect(h.deleted).toEqual(['pay_oneoff_1'])
    expect(billing().extras_oneoff_payment_id).toBeNull()
  })

  it('if the charge cannot be cancelled either: an audit row and a [billing:refund-needed] log', async () => {
    annual()
    h.commitMode = 'lost'
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(asaas.deletePayment).mockRejectedValueOnce(new Error('Asaas down'))
    expect((await change({ kind: 'user', delta: 1 })).status).toBe(500)
    expect(log.mock.calls.some((c) => String(c[0]).includes('[billing:refund-needed]'))).toBe(true)
    expect(h.audits).toEqual([expect.objectContaining({ action: 'billing.extras_refund_needed', accountId: 'acct-1', metadata: expect.objectContaining({ payment_id: 'pay_oneoff_1' }) })])
    log.mockRestore()
  })

  it('monthly accounts are unchanged: no one-off charge, the value goes up for the next charge', async () => {
    h.payments = [{ id: 'p1', dueDate: '2026-12-01', status: 'RECEIVED', value: 59.9 }]
    expect((await change({ kind: 'user', delta: 1 })).status).toBe(200)
    expect(h.oneOffs).toEqual([])
    expect(h.calls).toEqual([{ id: 'sub_1', value: 74.9, pending: true }])
  })
})

describe('a removal already lowered in Asaas cannot be cancelled', () => {
  it('refuses (409) once the lowered value is in Asaas; before that it can be cancelled', async () => {
    Object.assign(billing(), { extra_users: 2, extra_user_price_cents: 1500, value_cents: 8990, extras_first_due: '2026-10-01' })
    await change({ kind: 'user', delta: -2 })
    Object.assign(billing(), { value_cents: 5990, extras_asaas_lowered: true }) // what the sweep does
    const res = await change({ cancel_removal: true })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/already in your next charge/)
    expect(billing()).toMatchObject({ extra_users: 2, pending_extra_users: 0, extras_asaas_lowered: true })
    expect(h.calls).toEqual([])
  })
})

describe('who and when', () => {
  it('only the OWNER may change extras (admins and agents get 403 and Asaas is never called)', async () => {
    for (const role of ['admin', 'agent']) {
      h.role = role
      expect((await change({ kind: 'user', delta: 1 })).status, role).toBe(403)
    }
    expect(asaas.updateSubscriptionValue).not.toHaveBeenCalled()
    h.role = 'owner'
    expect((await change({ kind: 'user', delta: 1 })).status).toBe(200)
  })

  it('refuses read-only accounts, trials and accounts without an active paid subscription', async () => {
    h.readOnly = true
    expect((await change({ kind: 'user', delta: 1 })).status).toBe(402)
    h.readOnly = false
    h.status = 'trial'
    expect((await change({ kind: 'user', delta: 1 })).status).toBe(403)
    h.status = 'active'
    billing().status = 'pending'
    expect((await change({ kind: 'user', delta: 1 })).status).toBe(403)
    billing().status = 'active'
    h.fake.tables.account_billing.length = 0
    expect((await change({ kind: 'user', delta: 1 })).status).toBe(403)
    expect(asaas.updateSubscriptionValue).not.toHaveBeenCalled()
  })

  it('answers 503 and sends nothing when Asaas is not configured', async () => {
    vi.mocked(asaas.asaasConfigured).mockReturnValueOnce(false)
    expect((await change({ kind: 'user', delta: 1 })).status).toBe(503)
    expect(asaas.updateSubscriptionValue).not.toHaveBeenCalled()
  })

  it('caps changes per account per day (429), counted from the audit rows of this account only', async () => {
    const recent = new Date().toISOString()
    for (let i = 0; i < 10; i++) h.fake.tables.audit_log.push({ id: i, account_id: 'acct-1', action: 'billing.extras_changed', created_at: recent })
    h.fake.tables.audit_log.push({ id: 98, account_id: 'acct-1', action: 'billing.checkout', created_at: recent })
    expect((await change({ kind: 'user', delta: 1 })).status).toBe(429)
    expect(asaas.updateSubscriptionValue).not.toHaveBeenCalled()
    h.fake.tables.audit_log.forEach((r) => (r.created_at = '2020-01-01T00:00:00.000Z'))
    expect((await change({ kind: 'user', delta: 1 })).status).toBe(200)
  })
})

describe('Asaas and the database never silently disagree', () => {
  it('Asaas refuses: nothing is written, 502, the claim is released and Asaas is checked, not blindly restored', async () => {
    h.updateFails = 'before'
    const res = await change({ kind: 'user', delta: 1 })
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'Could not change it right now, try again.' })
    expect(billing()).toMatchObject({ extra_users: 0, value_cents: 5990, extra_user_price_cents: null, extras_claim_token: null })
    expect(changed()).toEqual([])
    expect(h.audits).toEqual([]) // Asaas still holds 59.90: it matched, so no mismatch
    expect(h.calls).toHaveLength(1) // no restore call was needed
  })

  it('a timeout after Asaas applied the value: the value is read, found different, and put back to the database one', async () => {
    h.updateFails = 'after'
    expect((await change({ kind: 'user', delta: 1 })).status).toBe(502)
    expect(h.asaasValue).toBe(59.9)
    expect(h.calls.map((c) => c.value)).toEqual([74.9, 59.9])
    expect(billing()).toMatchObject({ extra_users: 0, value_cents: 5990 })
    expect(h.audits).toEqual([])
  })

  it('when Asaas cannot be reached to check, a queryable mismatch audit row is left', async () => {
    h.updateFails = 'before'
    h.getFails = true
    expect((await change({ kind: 'user', delta: 1 })).status).toBe(502)
    expect(h.audits).toEqual([
      expect.objectContaining({ accountId: 'acct-1', action: 'billing.extras_mismatch', metadata: expect.objectContaining({ subscription_id: 'sub_1', db_value_cents: 5990 }) }),
    ])
  })

  it('a commit that loses the compare-and-swap puts Asaas back to what the database holds', async () => {
    h.onAsaas = () => {
      Object.assign(billing(), { extra_channels: 1, extra_channel_price_cents: 4000, value_cents: 9990 })
      h.onAsaas = null
    }
    const res = await change({ kind: 'user', delta: 1 })
    expect(res.status).toBe(409)
    expect(billing()).toMatchObject({ extra_users: 0, extra_channels: 1, value_cents: 9990, extras_claim_token: null })
    expect(h.asaasValue).toBe(99.9)
    expect(changed()).toEqual([])
    expect(h.audits).toEqual([])
  })

  it('two simultaneous clicks add once: the second finds the account claimed', async () => {
    const [a, b] = await Promise.all([change({ kind: 'user', delta: 1 }), change({ kind: 'user', delta: 1 })])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect(billing()).toMatchObject({ extra_users: 1, value_cents: 7490 })
    expect(h.asaasValue).toBe(74.9)
    expect(h.calls).toHaveLength(1)
    expect(changed()).toHaveLength(1)
  })
})

describe('removing extras is scheduled', () => {
  const withTwoUsers = () =>
    Object.assign(billing(), { extra_users: 2, extra_user_price_cents: 1500, value_cents: 8990, extras_first_due: '2026-10-01' })

  it('keeps the extras and the limit, touches nothing in Asaas, and says the day (end of the paid period)', async () => {
    withTwoUsers()
    h.payments = [{ id: 'p1', dueDate: '2026-12-01', status: 'RECEIVED', value: 89.9 }]
    const res = await change({ kind: 'user', delta: -1 })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ extras: { users: 2 }, valueCents: 8990, pendingRemoval: { users: 1, channels: 0, effectiveDate: '2027-01-01' } })
    expect(h.calls).toEqual([])
    expect(billing()).toMatchObject({ extra_users: 2, value_cents: 8990, pending_extra_users: 1, pending_extra_channels: 0, extras_reduce_due: '2027-01-01', extras_asaas_lowered: false })
    expect(changed()).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ type: 'removal_scheduled', effective_date: '2027-01-01' }) })])
  })

  it('an extra bought this period is still billed one full period: bought 05/12, removed 10/12 -> gone from 01/02', async () => {
    h.payments = [{ id: 'p1', dueDate: '2026-12-01', status: 'RECEIVED', value: 89.9 }]
    expect((await change({ kind: 'user', delta: 1 })).status).toBe(200) // first charge 01/01
    expect(billing().extras_first_due).toBe('2027-01-01')
    const res = await change({ kind: 'user', delta: -1 })
    expect(await res.json()).toMatchObject({ extras: { users: 1 }, pendingRemoval: { users: 0, effectiveDate: '2027-02-01' } })
  })

  it('refuses to remove below what is in use (users = members + pending invites), and when it fits it is scheduled', async () => {
    withTwoUsers()
    h.fake.tables.profiles.push({ user_id: 'u3', account_id: 'acct-1' }, { user_id: 'u4', account_id: 'acct-1' })
    h.fake.tables.account_invitations.push({ id: 'i1', account_id: 'acct-1', accepted_at: null, expires_at: '2999-01-01T00:00:00.000Z' })
    expect((await change({ kind: 'user', delta: -1 })).status).toBe(409) // 5 in use, 3 + 1 would allow 4
    expect(billing().pending_extra_users).toBeNull()
    h.fake.tables.account_invitations.length = 0
    expect((await change({ kind: 'user', delta: -1 })).status).toBe(200)
  })

  it('removing channels counts connected numbers', async () => {
    Object.assign(billing(), { extra_channels: 1, extra_channel_price_cents: 4000, value_cents: 9990 })
    h.channels = 2
    expect((await change({ kind: 'channel', delta: -1 })).status).toBe(409)
    h.channels = 1
    expect((await change({ kind: 'channel', delta: -1 })).status).toBe(200)
  })

  it('leftover extras on an unlimited plan can still be removed', async () => {
    withTwoUsers()
    h.planLimits.max_users = null
    expect((await change({ kind: 'user', delta: -2 })).status).toBe(200)
  })

  it('while a removal is pending nothing else can be changed, and it can be cancelled', async () => {
    withTwoUsers()
    await change({ kind: 'user', delta: -1 })
    expect((await change({ kind: 'user', delta: 1 })).status).toBe(409)
    expect((await change({ kind: 'user', delta: -1 })).status).toBe(409)
    const res = await change({ cancel_removal: true })
    expect(res.status).toBe(200)
    expect(billing()).toMatchObject({ extra_users: 2, pending_extra_users: null, extras_reduce_due: null, value_cents: 8990 })
    expect(h.calls).toEqual([]) // Asaas had not been lowered yet
    expect((await change({ cancel_removal: true })).status).toBe(409) // nothing left to cancel
  })
})

describe('route files export only handlers and segment config (Next 16 rejects the rest)', () => {
  it('extras and checkout routes', async () => {
    const allowed = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'dynamic', 'runtime', 'revalidate', 'maxDuration'])
    for (const mod of [await import('./route'), await import('../checkout/route')]) {
      for (const name of Object.keys(mod)) expect(allowed.has(name), name).toBe(true)
    }
  })
})
