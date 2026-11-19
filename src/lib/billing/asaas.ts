// ============================================================
// Asaas API client (server only) — subscriptions billing
// (docs/superpowers/specs/2026-10-12-billing-asaas-design.md).
//
// Configured by env: ASAAS_API_KEY and ASAAS_API_URL (e.g.
// https://api-sandbox.asaas.com/v3 for tests). Without both the billing
// routes answer "not configured" — nothing is sent anywhere.
// The key goes in the `access_token` header and never into logs or errors.
// ============================================================

import 'server-only'

export class AsaasError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'AsaasError'
  }
}

export function asaasConfigured(): boolean {
  return !!process.env.ASAAS_API_KEY && !!process.env.ASAAS_API_URL
}

const TIMEOUT_MS = 15_000

async function request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const key = process.env.ASAAS_API_KEY
  const base = process.env.ASAAS_API_URL
  if (!key || !base) throw new AsaasError('Asaas is not configured', 503)

  const res = await fetch(`${base.replace(/\/+$/, '')}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      access_token: key,
      'content-type': 'application/json',
      'user-agent': 'SempreCRM',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: 'no-store',
  })
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    // An HTML error page from a proxy: keep the status, drop the body.
    if (res.ok) throw new AsaasError(`Asaas ${init.method ?? 'GET'} ${path.split('?')[0]} returned non-JSON`, 502)
  }
  if (!res.ok) {
    // Asaas answers { errors: [{ code, description }] }; keep the
    // descriptions (no secrets in them), never the request.
    const errors = (data as { errors?: { description?: string }[] } | null)?.errors ?? []
    const detail = errors.map((e) => e.description).filter(Boolean).join('; ')
    throw new AsaasError(`Asaas ${init.method ?? 'GET'} ${path.split('?')[0]} failed (${res.status})${detail ? `: ${detail}` : ''}`, res.status)
  }
  return data as T
}

export interface AsaasCustomer {
  id: string
}

export interface AsaasSubscription {
  id: string
  status: string
  /** Value of each charge, in reais. */
  value?: number
}

export interface AsaasPayment {
  id: string
  subscription?: string | null
  customer?: string | null
  /** Asaas flags a removed charge instead of (or besides) answering 404. */
  deleted?: boolean
  status: string
  value: number
  dueDate: string
  billingType?: string | null
  invoiceUrl?: string | null
  paymentDate?: string | null
  confirmedDate?: string | null
}

export function createCustomer(input: {
  name: string
  cpfCnpj: string
  email?: string | null
  mobilePhone?: string | null
  externalReference: string
}): Promise<AsaasCustomer> {
  return request<AsaasCustomer>('/customers', {
    method: 'POST',
    body: {
      name: input.name,
      cpfCnpj: input.cpfCnpj,
      ...(input.email ? { email: input.email } : {}),
      ...(input.mobilePhone ? { mobilePhone: input.mobilePhone } : {}),
      externalReference: input.externalReference,
      notificationDisabled: false,
    },
  })
}

export function createSubscription(input: {
  customer: string
  value: number
  nextDueDate: string
  cycle: 'MONTHLY' | 'YEARLY'
  description: string
  externalReference: string
}): Promise<AsaasSubscription> {
  // UNDEFINED: the customer picks Pix, boleto or card on the Asaas page.
  return request<AsaasSubscription>('/subscriptions', {
    method: 'POST',
    body: { ...input, billingType: 'UNDEFINED' },
  })
}

/**
 * Changes the value of the subscription (extras, migration 114). `value` is in reais, like
 * createSubscription. `updatePendingPayments` decides about the charges Asaas already
 * generated and not yet paid: true = they follow the new value (use it when the account
 * adds extras, or lowers them for a charge that must no longer include them); false = they
 * stay as generated and only the charges generated later change. No proration either way.
 */
export function updateSubscriptionValue(id: string, value: number, updatePendingPayments: boolean): Promise<AsaasSubscription> {
  return request<AsaasSubscription>(`/subscriptions/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: { value, updatePendingPayments },
  })
}

export function getSubscription(id: string): Promise<AsaasSubscription> {
  return request<AsaasSubscription>(`/subscriptions/${encodeURIComponent(id)}`)
}

export function deleteSubscription(id: string): Promise<unknown> {
  return request(`/subscriptions/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

const PAGE = 100
const MAX_PAGES = 20

/**
 * Every charge of a subscription, in any order: pages through the whole list (Asaas
 * answers { data, hasMore }) instead of trusting the order or a small first page.
 * Callers sort what they need.
 */
export async function listSubscriptionPayments(id: string): Promise<AsaasPayment[]> {
  const all: AsaasPayment[] = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await request<{ data?: AsaasPayment[]; hasMore?: boolean }>(
      `/subscriptions/${encodeURIComponent(id)}/payments?limit=${PAGE}&offset=${page * PAGE}`,
    )
    all.push(...(res.data ?? []))
    if (!res.hasMore) return all
  }
  throw new AsaasError('Asaas subscription has too many charges to list', 502)
}

/** A one-off charge for the customer (annual extras, difference owed): Pix, boleto or card on the Asaas page. */
export function createPayment(input: {
  customer: string
  value: number
  dueDate: string
  description: string
  externalReference: string
}): Promise<AsaasPayment> {
  return request<AsaasPayment>('/payments', { method: 'POST', body: { ...input, billingType: 'UNDEFINED' } })
}

export function deletePayment(id: string): Promise<unknown> {
  return request(`/payments/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function getPayment(id: string): Promise<AsaasPayment> {
  return request<AsaasPayment>(`/payments/${encodeURIComponent(id)}`)
}
