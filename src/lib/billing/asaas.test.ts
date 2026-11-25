import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { createPayment, deletePayment, listSubscriptionPayments, updateSubscriptionValue } from './asaas'

// The Asaas client against a stubbed fetch: no network, no real key.

const calls: { url: string; init?: RequestInit }[] = []

function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify(handler(url, init)), { status: 200 })
    }),
  )
}

beforeEach(() => {
  calls.length = 0
  vi.stubEnv('ASAAS_API_KEY', 'test-key')
  vi.stubEnv('ASAAS_API_URL', 'https://asaas.invalid/v3')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('listSubscriptionPayments', () => {
  it('pages through every charge, whatever the order, never stopping at a first page of 10', async () => {
    const all = Array.from({ length: 250 }, (_, i) => ({ id: `pay_${i}`, status: 'RECEIVED', value: 10, dueDate: `2026-01-${String((i % 28) + 1).padStart(2, '0')}` }))
    stubFetch((url) => {
      const offset = Number(new URL(url).searchParams.get('offset'))
      const limit = Number(new URL(url).searchParams.get('limit'))
      return { data: all.slice(offset, offset + limit), hasMore: offset + limit < all.length }
    })
    const got = await listSubscriptionPayments('sub_1')
    expect(got).toHaveLength(250)
    expect(new Set(got.map((p) => p.id)).size).toBe(250)
    expect(calls.map((c) => new URL(c.url).searchParams.get('offset'))).toEqual(['0', '100', '200'])
  })

  it('a short list is one request', async () => {
    stubFetch(() => ({ data: [{ id: 'p', status: 'PENDING', value: 1, dueDate: '2026-12-01' }], hasMore: false }))
    expect(await listSubscriptionPayments('sub_1')).toHaveLength(1)
    expect(calls).toHaveLength(1)
  })

  it('gives up loudly instead of looping forever', async () => {
    stubFetch(() => ({ data: [], hasMore: true }))
    await expect(listSubscriptionPayments('sub_1')).rejects.toThrow(/too many charges/)
  })
})

describe('writes', () => {
  it('updateSubscriptionValue sends the value in reais and the pending flag explicitly', async () => {
    stubFetch(() => ({ id: 'sub_1', status: 'ACTIVE' }))
    await updateSubscriptionValue('sub_1', 89.9, true)
    await updateSubscriptionValue('sub_1', 59.9, false)
    expect(calls.map((c) => [c.init?.method, JSON.parse(String(c.init?.body))])).toEqual([
      ['PUT', { value: 89.9, updatePendingPayments: true }],
      ['PUT', { value: 59.9, updatePendingPayments: false }],
    ])
  })

  it('createPayment makes a one-off charge the customer pays on the Asaas page; deletePayment cancels it', async () => {
    stubFetch(() => ({ id: 'pay_1', status: 'PENDING', invoiceUrl: 'https://asaas.invalid/i/1' }))
    await createPayment({ customer: 'cus_1', value: 120, dueDate: '2026-12-08', description: 'x', externalReference: 'acct-1' })
    await deletePayment('pay_1')
    expect(calls[0].url).toBe('https://asaas.invalid/v3/payments')
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ customer: 'cus_1', value: 120, billingType: 'UNDEFINED' })
    expect([calls[1].init?.method, calls[1].url]).toEqual(['DELETE', 'https://asaas.invalid/v3/payments/pay_1'])
  })
})
