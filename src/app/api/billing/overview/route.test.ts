import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeFakeDb } from '@/lib/lgpd/fake-db.test-helper'

const h = vi.hoisted(() => ({
  fake: null as unknown as ReturnType<typeof import('@/lib/lgpd/fake-db.test-helper').makeFakeDb>,
  role: 'owner',
  configured: true,
}))

vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => ({}) }))
vi.mock('@/lib/billing/asaas', () => ({ asaasConfigured: () => h.configured }))
vi.mock('@/lib/plan-catalog-server', () => ({
  loadCurrentPlanCatalog: vi.fn(async () => [
    { id: 'v1', plan: 'trial', price_monthly_cents: null },
    { id: 'v2', plan: 'basico', price_monthly_cents: 5990 },
    { id: 'v3', plan: 'pro', price_monthly_cents: 8990 },
    { id: 'v4', plan: 'empresa', price_monthly_cents: null },
  ]),
}))
vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>()
  return {
    ...actual,
    requireRole: vi.fn(async (min: string) => {
      if (min === 'admin' && !['owner', 'admin'].includes(h.role)) throw new actual.ForbiddenError('admin only')
      return { supabase: h.fake.db, userId: 'u-1', accountId: 'acct-1', role: h.role }
    }),
  }
})

import { GET } from './route'

beforeEach(() => {
  h.role = 'owner'
  h.configured = true
  h.fake = makeFakeDb({
    account_billing: [
      { account_id: 'acct-1', plan: 'pro', cycle: 'annual', value_cents: 89900, status: 'past_due', current_period_end: '2026-10-17T00:00:00Z', asaas_subscription_id: 'sub_1' },
      { account_id: 'acct-2', plan: 'basico', cycle: 'monthly', value_cents: 5990, status: 'active', asaas_subscription_id: 'sub_x' },
    ],
    billing_payments: [
      { asaas_payment_id: 'p1', account_id: 'acct-1', asaas_subscription_id: 'sub_1', status: 'OVERDUE', value_cents: 89900, due_date: '2026-10-12', invoice_url: 'https://asaas.test/i/1' },
      { asaas_payment_id: 'p0', account_id: 'acct-1', asaas_subscription_id: 'sub_1', status: 'RECEIVED', value_cents: 89900, due_date: '2025-10-12', invoice_url: 'https://asaas.test/i/0' },
      { asaas_payment_id: 'px', account_id: 'acct-2', asaas_subscription_id: 'sub_x', status: 'RECEIVED', value_cents: 5990, due_date: '2026-10-01', invoice_url: 'https://asaas.test/i/x' },
    ],
  })
})

describe('GET /api/billing/overview', () => {
  it('shows the session account only: plans, subscription, pending link and history', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.plans.map((p: { plan: string }) => p.plan)).toEqual(['basico', 'pro'])
    expect(body).toMatchObject({ configured: true, canSubscribe: true, pendingInvoiceUrl: 'https://asaas.test/i/1' })
    expect(body.billing).toMatchObject({ plan: 'pro', cycle: 'annual', status: 'past_due' })
    expect(body.payments.map((p: { id: string }) => p.id)).toEqual(['p1', 'p0'])
  })

  it('an admin may look but not subscribe; others get 403', async () => {
    h.role = 'admin'
    expect((await (await GET()).json()).canSubscribe).toBe(false)
    h.role = 'agent'
    expect((await GET()).status).toBe(403)
  })

  it('reports Asaas as not configured instead of failing', async () => {
    h.configured = false
    expect((await (await GET()).json()).configured).toBe(false)
  })
})
