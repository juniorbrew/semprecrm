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
  const data = text ? (JSON.parse(text) as unknown) : null
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
}

export interface AsaasPayment {
  id: string
  subscription?: string | null
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

export function deleteSubscription(id: string): Promise<unknown> {
  return request(`/subscriptions/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function listSubscriptionPayments(id: string): Promise<AsaasPayment[]> {
  const page = await request<{ data?: AsaasPayment[] }>(`/subscriptions/${encodeURIComponent(id)}/payments?limit=10`)
  return page.data ?? []
}

export function getPayment(id: string): Promise<AsaasPayment> {
  return request<AsaasPayment>(`/payments/${encodeURIComponent(id)}`)
}
