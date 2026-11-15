import { describe, expect, it, vi } from 'vitest'

import type { SupabaseClient } from '@supabase/supabase-js'

import { PLAN_CATALOG } from '../plans'
import { extraOfferFor } from './extra-offer'

vi.mock('@/lib/plans-server', async () => {
  const { resolveEntitlements } = await import('../plans')
  return {
    loadAccountEntitlements: vi.fn(async (db: { ent: Parameters<typeof resolveEntitlements>[0] }) => resolveEntitlements(db.ent)),
  }
})

const V = '11111111-1111-4111-8111-111111111111'

function db(opts: {
  status?: string
  billing?: Record<string, unknown> | null
  prices?: { extra_user_price_cents?: number; extra_channel_price_cents?: number }
  limits?: { max_users: number | null; max_channels: number | null }
}): SupabaseClient {
  const row = opts.billing === undefined
    ? { status: 'active', asaas_subscription_id: 'sub_1', extra_users: 0, extra_channels: 0, extra_user_price_cents: null, extra_channel_price_cents: null }
    : opts.billing
  const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: row, error: null }) }
  return {
    ent: {
      plan: 'pro',
      plan_status: opts.status ?? 'active',
      plan_version_id: V,
      plan_definition: { ...PLAN_CATALOG.pro, limits: opts.limits ?? PLAN_CATALOG.pro.limits },
    },
    from: () => q,
    rpc: async () => ({
      data: [{ id: V, plan: 'pro', revision: 2, definition: { ...PLAN_CATALOG.pro, ...opts.prices }, price_monthly_cents: 8990 }],
      error: null,
    }),
  } as unknown as SupabaseClient
}

describe('extraOfferFor', () => {
  it('offers the plan price when the plan sells the extra', async () => {
    expect(await extraOfferFor(db({ prices: { extra_user_price_cents: 1500 } }), 'a', 'user')).toEqual({ kind: 'user', monthlyCents: 1500 })
    expect(await extraOfferFor(db({ prices: { extra_channel_price_cents: 4000 } }), 'a', 'channel')).toEqual({ kind: 'channel', monthlyCents: 4000 })
  })

  it('offers nothing without a price, for the other kind, or on an unlimited limit', async () => {
    expect(await extraOfferFor(db({}), 'a', 'user')).toBeNull()
    expect(await extraOfferFor(db({ prices: { extra_user_price_cents: 1500 } }), 'a', 'channel')).toBeNull()
    expect(
      await extraOfferFor(db({ prices: { extra_user_price_cents: 1500 }, limits: { max_users: null, max_channels: 2 } }), 'a', 'user'),
    ).toBeNull()
  })

  it('offers nothing in trial, read-only or without an active paid subscription', async () => {
    const prices = { extra_user_price_cents: 1500 }
    expect(await extraOfferFor(db({ prices, status: 'trial' }), 'a', 'user')).toBeNull()
    expect(await extraOfferFor(db({ prices, status: 'past_due' }), 'a', 'user')).toBeNull()
    expect(await extraOfferFor(db({ prices, billing: null }), 'a', 'user')).toBeNull()
    expect(
      await extraOfferFor(db({ prices, billing: { status: 'pending', asaas_subscription_id: 'sub_1', extra_users: 0, extra_channels: 0 } }), 'a', 'user'),
    ).toBeNull()
  })

  it('an account that already has extras is offered its locked price', async () => {
    const billing = { status: 'active', asaas_subscription_id: 'sub_1', extra_users: 1, extra_channels: 0, extra_user_price_cents: 1000, extra_channel_price_cents: null }
    expect(await extraOfferFor(db({ prices: { extra_user_price_cents: 2500 }, billing }), 'a', 'user')).toEqual({ kind: 'user', monthlyCents: 1000 })
  })

  it('never throws: a failing read is no offer', async () => {
    const broken = { from: () => { throw new Error('boom') }, ent: {} } as unknown as SupabaseClient
    expect(await extraOfferFor(broken, 'a', 'user')).toBeNull()
  })
})
