import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeFakeDb } from '@/lib/lgpd/fake-db.test-helper'

// ------------------------------------------------------------
// POST /api/billing/asaas/webhook — token, idempotency, and the rule
// that the account is only activated by what the Asaas API says.
// ------------------------------------------------------------

const h = vi.hoisted(() => ({
  fake: null as unknown as ReturnType<typeof import('@/lib/lgpd/fake-db.test-helper').makeFakeDb>,
  apiPayment: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => h.fake.db }))
vi.mock('@/lib/billing/asaas', () => ({
  AsaasError: class AsaasError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message)
    }
  },
  getPayment: vi.fn(async (id: string) => ({ id, ...h.apiPayment })),
}))

import { AsaasError, getPayment } from '@/lib/billing/asaas'
import { POST } from './route'

const TOKEN = 'whk_test_token_123'

function send(body: unknown, token: string | null = TOKEN) {
  return POST(
    new Request('http://localhost/api/billing/asaas/webhook', {
      method: 'POST',
      headers: token === null ? {} : { 'asaas-access-token': token },
      body: JSON.stringify(body),
    }),
  )
}

const evt = (id: string, event: string, payment = { id: 'pay_1', subscription: 'sub_1' }) => ({ id, event, payment })

beforeEach(() => {
  vi.stubEnv('ASAAS_WEBHOOK_TOKEN', TOKEN)
  vi.mocked(getPayment).mockClear()
  h.apiPayment = { subscription: 'sub_1', status: 'RECEIVED', value: 89.9, dueDate: '2026-10-12', billingType: 'PIX', invoiceUrl: 'https://x/i/1', confirmedDate: '2026-10-12' }
  h.fake = makeFakeDb(
    {
      account_billing: [{ account_id: 'acct-1', asaas_subscription_id: 'sub_1', cycle: 'monthly', status: 'pending' }],
      billing_payments: [],
      billing_webhook_events: [],
    },
    { rpc: () => ({ data: null, error: null }) },
  )
})

describe('asaas webhook', () => {
  it('refuses a missing or wrong token, and answers 503 when not configured', async () => {
    expect((await send(evt('evt_1', 'PAYMENT_RECEIVED'), null)).status).toBe(401)
    expect((await send(evt('evt_1', 'PAYMENT_RECEIVED'), 'whk_test_token_124')).status).toBe(401)
    expect((await send(evt('evt_1', 'PAYMENT_RECEIVED'), 'short')).status).toBe(401)
    vi.stubEnv('ASAAS_WEBHOOK_TOKEN', '')
    expect((await send(evt('evt_1', 'PAYMENT_RECEIVED'))).status).toBe(503)
    expect(h.fake.rpcCalls).toEqual([])
    expect(h.fake.tables.billing_webhook_events).toEqual([])
  })

  it('a confirmed payment activates the account for the period plus grace', async () => {
    const res = await send(evt('evt_1', 'PAYMENT_RECEIVED'))
    expect(res.status).toBe(200)
    expect(h.fake.rpcCalls).toEqual([
      {
        fn: 'billing_activate',
        args: { p_account_id: 'acct-1', p_subscription_id: 'sub_1', p_period_end: '2026-11-18T02:59:59.000Z' },
      },
    ])
    expect(h.fake.tables.billing_payments).toMatchObject([
      { asaas_payment_id: 'pay_1', account_id: 'acct-1', status: 'RECEIVED', value_cents: 8990, paid_at: '2026-10-12' },
    ])
    expect(h.fake.tables.billing_webhook_events[0]).toMatchObject({ event_id: 'evt_1', error: null })
    expect(h.fake.tables.billing_webhook_events[0].processed_at).toBeTruthy()
  })

  it('does not trust the body: activation needs the API to say paid', async () => {
    h.apiPayment = { ...h.apiPayment, status: 'PENDING' }
    expect((await send(evt('evt_1', 'PAYMENT_CONFIRMED'))).status).toBe(200)
    expect(h.fake.rpcCalls).toEqual([])
    expect(h.fake.tables.billing_payments).toMatchObject([{ status: 'PENDING' }])
  })

  it('refuses a payment of another subscription, stored as an error without blocking the queue', async () => {
    h.apiPayment = { ...h.apiPayment, subscription: 'sub_other' }
    expect((await send(evt('evt_1', 'PAYMENT_RECEIVED'))).status).toBe(200)
    expect(h.fake.rpcCalls).toEqual([])
    expect(h.fake.tables.billing_webhook_events[0].error).toMatch(/does not belong/)
    expect(h.fake.tables.billing_webhook_events[0].processed_at).toBeTruthy()
  })

  it('a transient API failure answers 500 so Asaas retries; a missing payment does not', async () => {
    vi.mocked(getPayment).mockRejectedValueOnce(new AsaasError('Asaas GET /payments failed (503)', 503))
    expect((await send(evt('evt_1', 'PAYMENT_RECEIVED'))).status).toBe(500)
    expect(h.fake.tables.billing_webhook_events[0].processed_at).toBeFalsy()

    vi.mocked(getPayment).mockRejectedValueOnce(new AsaasError('Asaas GET /payments failed (404)', 404))
    expect((await send(evt('evt_2', 'PAYMENT_RECEIVED'))).status).toBe(200)
    expect(h.fake.rpcCalls).toEqual([])
  })

  it('record-only events do not call the API, and stored payloads drop card data', async () => {
    const body = { ...evt('evt_1', 'PAYMENT_CREATED'), payment: { id: 'pay_1', subscription: 'sub_1', creditCard: { creditCardToken: 'tok_secret' } } }
    expect((await send(body)).status).toBe(200)
    expect(getPayment).not.toHaveBeenCalled()
    expect(JSON.stringify(h.fake.tables.billing_webhook_events[0].payload)).not.toMatch(/tok_secret/)
  })

  it('an event already processed does nothing the second time', async () => {
    await send(evt('evt_1', 'PAYMENT_RECEIVED'))
    h.fake.tables.billing_webhook_events[0].processed_at = '2026-10-12T12:00:00Z'
    h.fake = { ...h.fake, db: makeDup(h.fake) }
    const res = await send(evt('evt_1', 'PAYMENT_RECEIVED'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ duplicate: true })
    expect(h.fake.rpcCalls).toHaveLength(1)
    expect(getPayment).toHaveBeenCalledTimes(1)
  })

  it('overdue marks past_due, unless the API says it is paid again', async () => {
    h.apiPayment = { ...h.apiPayment, status: 'OVERDUE' }
    await send(evt('evt_1', 'PAYMENT_OVERDUE'))
    expect(h.fake.rpcCalls).toEqual([{ fn: 'billing_mark_past_due', args: { p_account_id: 'acct-1', p_subscription_id: 'sub_1' } }])

    h.apiPayment = { ...h.apiPayment, status: 'RECEIVED' }
    await send(evt('evt_2', 'PAYMENT_OVERDUE'))
    expect(h.fake.rpcCalls).toHaveLength(1)
  })

  it('ignores charges of unknown subscriptions and one-off payments without calling the API', async () => {
    expect((await send(evt('evt_1', 'PAYMENT_RECEIVED', { id: 'pay_9', subscription: 'sub_unknown' }))).status).toBe(200)
    expect((await send({ id: 'evt_2', event: 'PAYMENT_RECEIVED', payment: { id: 'pay_9' } })).status).toBe(200)
    expect(getPayment).not.toHaveBeenCalled()
    expect(h.fake.rpcCalls).toEqual([])
  })

  it('rejects a body without event id', async () => {
    expect((await send({ event: 'PAYMENT_RECEIVED' })).status).toBe(400)
  })
})

/** The fake DB does not enforce primary keys: make a repeated event insert fail like Postgres. */
function makeDup(fake: typeof h.fake) {
  return {
    ...fake.db,
    from: (table: string) => {
      const b = fake.db.from(table)
      if (table !== 'billing_webhook_events') return b
      return { ...b, insert: () => Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key' } }) }
    },
  }
}
