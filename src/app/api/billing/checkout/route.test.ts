import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeFakeDb } from '@/lib/lgpd/fake-db.test-helper'

// ------------------------------------------------------------
// POST /api/billing/checkout — owner only, account from the session,
// price from the catalog, one pending subscription at a time.
// ------------------------------------------------------------

const h = vi.hoisted(() => ({
  fake: null as unknown as ReturnType<typeof import('@/lib/lgpd/fake-db.test-helper').makeFakeDb>,
  role: 'owner',
  subs: 0,
}))

vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => h.fake.db }))
vi.mock('@/lib/audit-server', () => ({ audit: vi.fn(async () => true) }))
vi.mock('@/lib/plan-catalog-server', () => ({
  loadCurrentPlanCatalog: vi.fn(async () => [
    { id: 'v-basico', plan: 'basico', revision: 1, definition: {}, price_monthly_cents: 5990 },
    { id: 'v-pro', plan: 'pro', revision: 1, definition: {}, price_monthly_cents: 8990 },
    { id: 'v-empresa', plan: 'empresa', revision: 1, definition: {}, price_monthly_cents: null },
  ]),
}))
vi.mock('@/lib/billing/asaas', () => {
  class AsaasError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message)
    }
  }
  return {
    AsaasError,
    asaasConfigured: vi.fn(() => true),
    createCustomer: vi.fn(async () => ({ id: 'cus_1' })),
    createSubscription: vi.fn(async () => ({ id: `sub_${++h.subs}`, status: 'ACTIVE' })),
    deleteSubscription: vi.fn(async () => ({})),
    listSubscriptionPayments: vi.fn(async (sub: string) => [
      { id: `pay_${sub}`, subscription: sub, status: 'PENDING', value: 89.9, dueDate: '2026-10-12', invoiceUrl: `https://asaas/i/${sub}` },
    ]),
  }
})
vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>()
  return {
    ...actual,
    requireRole: vi.fn(async (min: string) => {
      if (min === 'owner' && h.role !== 'owner') throw new actual.ForbiddenError('owner only')
      return { userId: `user-${h.role}`, accountId: 'acct-1', role: h.role }
    }),
  }
})

import * as asaas from '@/lib/billing/asaas'
import { POST } from './route'

function checkout(body: unknown) {
  return POST(new Request('http://localhost/api/billing/checkout', { method: 'POST', body: JSON.stringify(body) }))
}

beforeEach(() => {
  vi.clearAllMocks()
  h.role = 'owner'
  h.subs = 0
  h.fake = makeFakeDb({
    accounts: [
      { id: 'acct-1', name: 'Acme', legal_name: 'Acme Ltda', tax_id: '12.345.678/0001-90', email: 'a@acme.test', phone: '11999990000' },
      { id: 'acct-2', name: 'Other', tax_id: '11144477735' },
    ],
    account_billing: [],
    billing_payments: [],
  })
})

describe('billing checkout', () => {
  it('owner subscribes: customer + subscription at the catalog price, frozen in account_billing', async () => {
    const res = await checkout({ plan: 'pro', cycle: 'annual', account_id: 'acct-2' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ url: 'https://asaas/i/sub_1' })
    expect(asaas.createCustomer).toHaveBeenCalledWith(expect.objectContaining({ cpfCnpj: '12345678000190', externalReference: 'acct-1' }))
    expect(asaas.createSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_1', value: 899, cycle: 'YEARLY', externalReference: 'acct-1' }),
    )
    expect(h.fake.tables.account_billing).toEqual([
      expect.objectContaining({ account_id: 'acct-1', plan: 'pro', plan_version_id: 'v-pro', cycle: 'annual', value_cents: 89900, status: 'pending' }),
    ])
    expect(h.fake.tables.billing_payments).toMatchObject([{ asaas_payment_id: 'pay_sub_1', account_id: 'acct-1', value_cents: 8990 }])
  })

  it('only the owner can subscribe', async () => {
    h.role = 'admin'
    expect((await checkout({ plan: 'pro', cycle: 'monthly' })).status).toBe(403)
    expect(asaas.createSubscription).not.toHaveBeenCalled()
  })

  it('rejects bad input, plans not sold online, and a missing CPF/CNPJ', async () => {
    expect((await checkout({ plan: 'trial', cycle: 'monthly' })).status).toBe(400)
    expect((await checkout({ plan: 'pro', cycle: 'weekly' })).status).toBe(400)
    expect((await checkout({ plan: 'empresa', cycle: 'monthly' })).status).toBe(400)
    h.fake.tables.accounts[0].tax_id = null
    expect((await checkout({ plan: 'pro', cycle: 'monthly' })).status).toBe(400)
    expect(asaas.createSubscription).not.toHaveBeenCalled()
  })

  it('answers 503 and sends nothing when Asaas is not configured', async () => {
    vi.mocked(asaas.asaasConfigured).mockReturnValueOnce(false)
    expect((await checkout({ plan: 'pro', cycle: 'monthly' })).status).toBe(503)
    expect(asaas.createCustomer).not.toHaveBeenCalled()
  })

  it('same choice again returns the same charge; a different one replaces the subscription', async () => {
    await checkout({ plan: 'pro', cycle: 'monthly' })
    expect(await (await checkout({ plan: 'pro', cycle: 'monthly' })).json()).toEqual({ url: 'https://asaas/i/sub_1' })
    expect(asaas.createSubscription).toHaveBeenCalledTimes(1)

    expect(await (await checkout({ plan: 'basico', cycle: 'monthly' })).json()).toEqual({ url: 'https://asaas/i/sub_2' })
    expect(asaas.deleteSubscription).toHaveBeenCalledWith('sub_1')
    expect(asaas.createCustomer).toHaveBeenCalledTimes(1) // customer reused
    expect(h.fake.tables.account_billing).toEqual([expect.objectContaining({ asaas_subscription_id: 'sub_2', plan: 'basico', value_cents: 5990 })])
  })

  it('never replaces a pending subscription whose charge was already paid', async () => {
    await checkout({ plan: 'pro', cycle: 'monthly' })
    vi.mocked(asaas.listSubscriptionPayments).mockResolvedValueOnce([
      { id: 'pay_sub_1', subscription: 'sub_1', status: 'RECEIVED', value: 89.9, dueDate: '2026-10-12' },
    ])
    expect((await checkout({ plan: 'basico', cycle: 'annual' })).status).toBe(409)
    expect(asaas.deleteSubscription).not.toHaveBeenCalled()
    expect(h.fake.tables.billing_payments).toMatchObject([{ status: 'RECEIVED' }])
  })

  it('a suspended account cannot subscribe its way out', async () => {
    h.fake.tables.accounts[0].plan_status = 'suspended'
    expect((await checkout({ plan: 'pro', cycle: 'monthly' })).status).toBe(403)
    expect(asaas.createSubscription).not.toHaveBeenCalled()
  })

  it('a concurrent checkout that already swapped the row wins; the loser cancels its own subscription', async () => {
    await checkout({ plan: 'pro', cycle: 'monthly' })
    // Another request replaces sub_1 between our read and our write.
    vi.mocked(asaas.createSubscription).mockImplementationOnce(async () => {
      h.fake.tables.account_billing[0].asaas_subscription_id = 'sub_other'
      return { id: 'sub_mine', status: 'ACTIVE' }
    })
    expect((await checkout({ plan: 'basico', cycle: 'monthly' })).status).toBe(409)
    expect(asaas.deleteSubscription).toHaveBeenCalledWith('sub_mine')
    expect(asaas.deleteSubscription).not.toHaveBeenCalledWith('sub_other')
    expect(h.fake.tables.account_billing[0].asaas_subscription_id).toBe('sub_other')
  })

  it('if saving fails after Asaas created the subscription, it is cancelled', async () => {
    h.fake = makeFakeDb(h.fake.tables, { fail: (t, op) => (t === 'account_billing' && op === 'insert' ? { message: 'db down' } : null) })
    expect((await checkout({ plan: 'pro', cycle: 'monthly' })).status).toBe(500)
    expect(asaas.deleteSubscription).toHaveBeenCalledWith('sub_1')
  })

  it('an active subscription cannot be started again', async () => {
    h.fake.tables.account_billing.push({ account_id: 'acct-1', asaas_subscription_id: 'sub_0', plan: 'pro', cycle: 'monthly', status: 'active' })
    expect((await checkout({ plan: 'pro', cycle: 'annual' })).status).toBe(409)
    expect(asaas.createSubscription).not.toHaveBeenCalled()
  })

  it('a provider failure is a 502 without details', async () => {
    vi.mocked(asaas.createCustomer).mockRejectedValueOnce(new asaas.AsaasError('Asaas POST /customers failed (400): CPF inválido', 400))
    const res = await checkout({ plan: 'pro', cycle: 'monthly' })
    expect(res.status).toBe(502)
    expect(JSON.stringify(await res.json())).not.toMatch(/CPF inválido/)
  })
})
