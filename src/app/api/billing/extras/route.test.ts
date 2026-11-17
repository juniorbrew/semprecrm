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
  payments: [{ id: 'p1', dueDate: '2026-12-01', status: 'RECEIVED' }] as { id: string; dueDate: string; status: string }[],
  audits: [] as Record<string, unknown>[],
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
    payments: [{ id: 'p1', dueDate: '2026-12-01', status: 'RECEIVED' }],
    audits: [],
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
        },
      ],
      profiles: [{ user_id: 'u1', account_id: 'acct-1' }, { user_id: 'u2', account_id: 'acct-1' }],
      account_invitations: [],
      audit_log: [],
    },
    { rpc: extrasRpc },
  )
})

describe('adding extras', () => {
  it('Asaas gets the new value first (pending charges follow), then the row and its audit row are saved together', async () => {
    const res = await change({ kind: 'user', delta: 2, account_id: 'acct-other' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ extras: { users: 2, channels: 0 }, valueCents: 8990, pendingRemoval: null })
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

  it('annual accounts pay the extra at 10 months', async () => {
    Object.assign(billing(), { cycle: 'annual', value_cents: 59900 })
    const res = await change({ kind: 'channel', delta: 1 })
    expect(await res.json()).toMatchObject({ valueCents: 59900 + 40000 })
    expect(h.calls).toEqual([{ id: 'sub_1', value: 999, pending: true }])
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
    h.payments = [{ id: 'p1', dueDate: '2026-12-01', status: 'RECEIVED' }]
    const res = await change({ kind: 'user', delta: -1 })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ extras: { users: 2 }, valueCents: 8990, pendingRemoval: { users: 1, channels: 0, effectiveDate: '2027-01-01' } })
    expect(h.calls).toEqual([])
    expect(billing()).toMatchObject({ extra_users: 2, value_cents: 8990, pending_extra_users: 1, pending_extra_channels: 0, extras_reduce_due: '2027-01-01', extras_asaas_lowered: false })
    expect(changed()).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ type: 'removal_scheduled', effective_date: '2027-01-01' }) })])
  })

  it('an extra bought this period is still billed one full period: bought 05/12, removed 10/12 -> gone from 01/02', async () => {
    h.payments = [{ id: 'p1', dueDate: '2026-12-01', status: 'RECEIVED' }]
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

  it('cancelling after Asaas was already lowered raises it back for the pending charges', async () => {
    withTwoUsers()
    await change({ kind: 'user', delta: -2 })
    Object.assign(billing(), { value_cents: 5990, extras_asaas_lowered: true }) // what the sweep does
    const res = await change({ cancel_removal: true })
    expect(res.status).toBe(200)
    expect(h.calls).toEqual([{ id: 'sub_1', value: 89.9, pending: true }])
    expect(billing()).toMatchObject({ value_cents: 8990, extras_asaas_lowered: false, pending_extra_users: null })
  })
})
