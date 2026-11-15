import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeFakeDb } from '@/lib/lgpd/fake-db.test-helper'

// ------------------------------------------------------------
// POST /api/billing/extras — owner/admin only, active paid account only,
// Asaas first, then a compare-and-swap; never a real Asaas call.
// ------------------------------------------------------------

const VERSION = '11111111-1111-4111-8111-111111111111'

const h = vi.hoisted(() => ({
  fake: null as unknown as ReturnType<typeof import('@/lib/lgpd/fake-db.test-helper').makeFakeDb>,
  role: 'admin',
  readOnly: false,
  status: 'active',
  channels: 0,
  price: { user: 1500 as number | undefined, channel: 4000 as number | undefined },
  planLimits: { max_users: 3 as number | null, max_channels: 1 as number | null },
  asaasCalls: [] as { id: string; value: number }[],
  onAsaas: null as null | (() => void),
  asaasFail: false,
  audits: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => h.fake.db }))
vi.mock('@/lib/audit-server', () => ({
  audit: vi.fn(async (entry: Record<string, unknown>) => {
    h.audits.push(entry)
    h.fake.tables.audit_log.push({ id: h.audits.length, account_id: entry.accountId, action: entry.action, created_at: new Date().toISOString() })
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
      const row = h.fake.tables.account_billing[0] as { extra_users: number; extra_channels: number }
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
  updateSubscriptionValue: vi.fn(async (id: string, value: number) => {
    h.asaasCalls.push({ id, value })
    if (h.asaasFail) throw new Error('Asaas down')
    h.onAsaas?.()
    return { id, status: 'ACTIVE' }
  }),
}))
vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>()
  return {
    ...actual,
    requireRole: vi.fn(async (min: string) => {
      if (min === 'admin' && !['owner', 'admin'].includes(h.role)) throw new actual.ForbiddenError("This action requires the 'admin' role or higher")
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

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(h, {
    role: 'admin',
    readOnly: false,
    status: 'active',
    channels: 0,
    price: { user: 1500, channel: 4000 },
    planLimits: { max_users: 3, max_channels: 1 },
    asaasCalls: [],
    onAsaas: null,
    asaasFail: false,
    audits: [],
  })
  h.fake = makeFakeDb({
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
      },
    ],
    profiles: [{ user_id: 'u1', account_id: 'acct-1' }, { user_id: 'u2', account_id: 'acct-1' }],
    account_invitations: [],
    audit_log: [],
  })
})

describe('billing extras', () => {
  it('adds an extra user: Asaas gets the new value first (next charges only), then the row is saved and audited', async () => {
    const res = await change({ kind: 'user', delta: 2, account_id: 'acct-other' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ extras: { users: 2, channels: 0 }, valueCents: 5990 + 3000 })
    expect(h.asaasCalls).toEqual([{ id: 'sub_1', value: 89.9 }])
    expect(billing()).toMatchObject({ extra_users: 2, extra_user_price_cents: 1500, extra_channels: 0, extra_channel_price_cents: null, value_cents: 8990 })
    expect(h.audits).toEqual([
      expect.objectContaining({
        accountId: 'acct-1',
        actorUserId: 'user-admin',
        action: 'billing.extras_changed',
        metadata: {
          kind: 'user',
          delta: 2,
          from: { extra_users: 0, extra_channels: 0, value_cents: 5990 },
          to: { extra_users: 2, extra_channels: 0, value_cents: 8990 },
        },
      }),
    ])
  })

  it('annual accounts pay the extra at 10 months', async () => {
    billing().cycle = 'annual'
    billing().value_cents = 59900
    const res = await change({ kind: 'channel', delta: 1 })
    expect(await res.json()).toMatchObject({ valueCents: 59900 + 40000 })
    expect(h.asaasCalls).toEqual([{ id: 'sub_1', value: 999 }])
  })

  it('a locked price survives a new plan price', async () => {
    Object.assign(billing(), { extra_users: 1, extra_user_price_cents: 1000, value_cents: 6990 })
    h.price.user = 2500
    const res = await change({ kind: 'user', delta: 1 })
    expect(await res.json()).toMatchObject({ extras: { users: 2 }, valueCents: 7990 })
    expect(billing().extra_user_price_cents).toBe(1000)
  })

  it('only owner and admin may change extras', async () => {
    h.role = 'agent'
    expect((await change({ kind: 'user', delta: 1 })).status).toBe(403)
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

  it('offers nothing without a price in the plan, and nothing on an unlimited limit', async () => {
    h.price.user = undefined
    expect((await change({ kind: 'user', delta: 1 })).status).toBe(400)
    h.planLimits.max_users = null
    h.price.user = 1500
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

  it('Asaas down: nothing changes, a clear error, and the old value is asked back', async () => {
    h.asaasFail = true
    const res = await change({ kind: 'user', delta: 1 })
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'Could not change it right now, try again.' })
    expect(billing()).toMatchObject({ extra_users: 0, value_cents: 5990, extra_user_price_cents: null })
    expect(h.audits).toEqual([])
    expect(h.asaasCalls.map((c) => c.value)).toEqual([74.9, 59.9])
  })

  it('a change that lost the compare-and-swap reverts Asaas to what the database holds', async () => {
    // Someone else's change lands while ours is in Asaas.
    h.onAsaas = () => {
      Object.assign(billing(), { extra_channels: 1, extra_channel_price_cents: 4000, value_cents: 9990 })
      h.onAsaas = null
    }
    const res = await change({ kind: 'user', delta: 1 })
    expect(res.status).toBe(409)
    expect(billing()).toMatchObject({ extra_users: 0, extra_channels: 1, value_cents: 9990 })
    expect(h.asaasCalls.map((c) => c.value)).toEqual([74.9, 99.9])
    expect(h.audits).toEqual([])
  })

  it('two simultaneous clicks add once, and Asaas ends on the saved value', async () => {
    const [a, b] = await Promise.all([change({ kind: 'user', delta: 1 }), change({ kind: 'user', delta: 1 })])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect(billing()).toMatchObject({ extra_users: 1, value_cents: 7490 })
    expect(h.asaasCalls.at(-1)).toEqual({ id: 'sub_1', value: 74.9 })
    expect(h.audits).toHaveLength(1)
  })

  it('refuses to remove below what is in use, and removes when it fits', async () => {
    Object.assign(billing(), { extra_users: 2, extra_user_price_cents: 1500, value_cents: 8990 })
    h.fake.tables.profiles.push({ user_id: 'u3', account_id: 'acct-1' }, { user_id: 'u4', account_id: 'acct-1' })
    h.fake.tables.account_invitations.push({ id: 'i1', account_id: 'acct-1', accepted_at: null, expires_at: '2999-01-01T00:00:00.000Z' })
    // 5 in use (4 members + 1 pending), plan 3 + 2 extras: removing one leaves 4.
    const refused = await change({ kind: 'user', delta: -1 })
    expect(refused.status).toBe(409)
    expect(asaas.updateSubscriptionValue).not.toHaveBeenCalled()
    expect(billing().extra_users).toBe(2)
    h.fake.tables.account_invitations.length = 0
    const ok = await change({ kind: 'user', delta: -1 })
    expect(ok.status).toBe(200)
    expect(billing()).toMatchObject({ extra_users: 1, value_cents: 7490 })
  })

  it('removing channels counts connected numbers', async () => {
    Object.assign(billing(), { extra_channels: 1, extra_channel_price_cents: 4000, value_cents: 9990 })
    h.channels = 1
    expect((await change({ kind: 'channel', delta: -1 })).status).toBe(200)
    expect(billing()).toMatchObject({ extra_channels: 0, extra_channel_price_cents: null, value_cents: 5990 })
    Object.assign(billing(), { extra_channels: 1, extra_channel_price_cents: 4000, value_cents: 9990 })
    h.channels = 2
    expect((await change({ kind: 'channel', delta: -1 })).status).toBe(409)
  })

  it('caps changes per account per day (429), counting only recent rows of this account', async () => {
    const recent = new Date().toISOString()
    for (let i = 0; i < 10; i++) h.fake.tables.audit_log.push({ id: i, account_id: 'acct-1', action: 'billing.extras_changed', created_at: recent })
    h.fake.tables.audit_log.push({ id: 98, account_id: 'acct-1', action: 'billing.checkout', created_at: recent })
    expect((await change({ kind: 'user', delta: 1 })).status).toBe(429)
    expect(asaas.updateSubscriptionValue).not.toHaveBeenCalled()
    h.fake.tables.audit_log.forEach((r) => (r.created_at = '2020-01-01T00:00:00.000Z'))
    expect((await change({ kind: 'user', delta: 1 })).status).toBe(200)
  })

  it('answers 503 and sends nothing when Asaas is not configured', async () => {
    vi.mocked(asaas.asaasConfigured).mockReturnValueOnce(false)
    expect((await change({ kind: 'user', delta: 1 })).status).toBe(503)
    expect(asaas.updateSubscriptionValue).not.toHaveBeenCalled()
  })
})
