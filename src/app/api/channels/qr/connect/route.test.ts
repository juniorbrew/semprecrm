import { beforeEach, describe, expect, it, vi } from 'vitest'

import { resolveEntitlements } from '@/lib/plans'

// POST /api/channels/qr/connect — a NEW session must fit under the EFFECTIVE
// channel limit (plan + contracted extras, migration 116).

const h = vi.hoisted(() => ({
  extraChannels: 0,
  used: 1,
  offer: null as null | { kind: 'channel'; monthlyCents: number },
  started: 0,
}))

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>()
  return {
    ...actual,
    requireRole: vi.fn(async () => ({ supabase: {}, userId: 'u1', accountId: 'acct-1', role: 'admin' })),
    requireModule: vi.fn(async () =>
      resolveEntitlements({
        plan: 'basico',
        plan_status: 'active',
        plan_version_id: '11111111-1111-4111-8111-111111111111',
        plan_definition: { modules: ['channel_qr'], limits: { max_users: 3, max_channels: 1 } },
        extras: { users: 0, channels: h.extraChannels },
      }),
    ),
  }
})
vi.mock('@/lib/plans-server', () => ({ countConnectedChannels: vi.fn(async () => h.used) }))
vi.mock('@/lib/billing/extra-offer', () => ({ extraOfferFor: vi.fn(async () => h.offer) }))
vi.mock('@/lib/audit-server', () => ({ audit: vi.fn(async () => true) }))
vi.mock('@/lib/whatsapp/qr-gateway', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/qr-gateway')>()),
  connectSession: vi.fn(async () => {
    h.started++
    return { status: 'connecting' }
  }),
  getSessionState: vi.fn(async () => ({ status: 'connecting' })),
}))
vi.mock('@/lib/whatsapp/qr-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp/qr-session')>()
  return {
    ...actual,
    readQrSession: vi.fn(async () => null),
    upsertQrSession: vi.fn(async () => ({ phone_number: null })),
    patchFromGatewayState: vi.fn(() => ({})),
  }
})

import { POST } from './route'

beforeEach(() => {
  h.extraChannels = 0
  h.used = 1
  h.offer = null
  h.started = 0
})

describe('POST /api/channels/qr/connect — effective channel limit', () => {
  it('blocks at the plan limit and carries the extra offer when the plan sells one', async () => {
    h.offer = { kind: 'channel', monthlyCents: 4000 }
    const res = await POST()
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'plan_limit_reached', offer: { kind: 'channel', monthlyCents: 4000 } })
    expect(h.started).toBe(0)
  })

  it('blocks without an offer when the plan sells none', async () => {
    const body = await (await POST()).json()
    expect(body.code).toBe('plan_limit_reached')
    expect(body.offer).toBeUndefined()
  })

  it('a contracted extra number raises the limit at once', async () => {
    h.extraChannels = 1
    expect((await POST()).status).toBe(200)
    expect(h.started).toBe(1)
    h.used = 2
    expect((await POST()).status).toBe(403)
  })
})
