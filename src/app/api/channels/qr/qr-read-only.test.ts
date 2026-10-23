import { beforeEach, describe, expect, it, vi } from 'vitest'

// A read-only account (trial ended / overdue) must still be able to re-scan or
// log out its WhatsApp Web session: a dropped session would lose inbound.

const h = vi.hoisted(() => ({ blocked: false as false | { reason: string } }))

vi.mock('@/lib/plans-server', () => ({
  loadAccountEntitlements: async () => ({
    plan: 'pro',
    status: 'active',
    expiresAt: null,
    modules: { channel_qr: true },
    limits: { max_channels: 3 },
    blocked: h.blocked,
  }),
  countConnectedChannels: async () => 0,
}))
vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>()
  return { ...actual, requireRole: async () => ({ supabase: {}, accountId: 'acct-1', userId: 'u-1', role: 'owner' }) }
})
vi.mock('@/lib/audit-server', () => ({ audit: vi.fn(async () => true) }))
vi.mock('@/lib/whatsapp/qr-gateway', () => ({
  connectSession: vi.fn(async () => ({ status: 'connecting' })),
  getSessionState: vi.fn(async () => ({ status: 'connecting' })),
  logoutSession: vi.fn(async () => ({})),
}))
vi.mock('@/lib/whatsapp/qr-session', () => ({
  readQrSession: vi.fn(async () => null),
  upsertQrSession: vi.fn(async () => ({ account_id: 'acct-1', status: 'connecting' })),
  patchFromGatewayState: () => ({}),
  qrErrorResponse: (e: unknown) => Response.json({ error: String(e) }, { status: 500 }),
}))

import { POST as connect } from './connect/route'
import { POST as logout } from './logout/route'
import * as gateway from '@/lib/whatsapp/qr-gateway'

beforeEach(() => {
  h.blocked = false
  vi.clearAllMocks()
})

describe('QR connect / logout while the account is read-only', () => {
  it.each(['trial_expired', 'past_due'])('still work while %s', async (reason) => {
    h.blocked = { reason }
    expect((await connect()).status).toBe(200)
    expect(gateway.connectSession).toHaveBeenCalledTimes(1)
    expect((await logout()).status).toBe(200)
    expect(gateway.logoutSession).toHaveBeenCalledTimes(1)
  })

  it('stay closed for a suspended account', async () => {
    h.blocked = { reason: 'suspended' }
    expect((await connect()).status).toBe(500)
    expect((await logout()).status).toBe(500)
    expect(gateway.connectSession).not.toHaveBeenCalled()
    expect(gateway.logoutSession).not.toHaveBeenCalled()
  })
})
