// ============================================================
// Calendar sync — the HTTP layer the provider adapters share.
//
//   `fetch` and `sleep` are injected (`HttpDeps`) so the adapters and
//   the engine are tested against mocked responses, never the network.
//
//   Errors:
//     ProviderAuthError  401 from the API, or `invalid_grant` from the
//                        token endpoint → the engine marks the
//                        connection `revoked`.
//     ProviderHttpError  any other non-2xx (status + parsed body).
//
//   429 → one retry after `Retry-After` (capped) — the only backoff
//   the spec asks for; a second 429 surfaces as an error and the
//   connection is retried on the next tick anyway.
// ============================================================

import type { CalendarProvider } from '@/types'

export interface HttpDeps {
  fetch: typeof fetch
  sleep: (ms: number) => Promise<void>
  /** Clock for token expiry stamps (default: `new Date()`). */
  now?: () => Date
}

export const defaultHttpDeps = (): HttpDeps => ({
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
})

export function httpNow(deps: HttpDeps): Date {
  return deps.now ? deps.now() : new Date()
}

export class ProviderHttpError extends Error {
  readonly status: number
  readonly body: unknown
  readonly provider: CalendarProvider
  constructor(provider: CalendarProvider, status: number, body: unknown, message?: string) {
    super(message ?? `${provider}: HTTP ${status}${describe(body)}`)
    this.name = 'ProviderHttpError'
    this.provider = provider
    this.status = status
    this.body = body
  }
}

/** The provider no longer accepts our credentials (401 / invalid_grant). */
export class ProviderAuthError extends ProviderHttpError {
  constructor(provider: CalendarProvider, status: number, body: unknown, message?: string) {
    super(provider, status, body, message ?? `${provider}: access revoked${describe(body)}`)
    this.name = 'ProviderAuthError'
  }
}

function describe(body: unknown): string {
  if (!body || typeof body !== 'object') return ''
  const b = body as Record<string, unknown>
  const err = b.error
  if (typeof err === 'string') {
    const desc = typeof b.error_description === 'string' ? ` — ${b.error_description}` : ''
    return ` (${err}${desc})`
  }
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>
    const code = typeof e.code === 'string' || typeof e.code === 'number' ? String(e.code) : ''
    const msg = typeof e.message === 'string' ? e.message : ''
    if (code || msg) return ` (${[code, msg].filter(Boolean).join(': ')})`
  }
  return ''
}

/** Max wait honoured for `Retry-After` on a 429 (ms). */
export const MAX_RETRY_AFTER_MS = 5_000

export interface JsonResponse<T = unknown> {
  status: number
  body: T | null
  headers: Headers
}

/**
 * fetch → parsed JSON (or null on an empty / non-JSON body). Retries
 * once on 429. Throws `ProviderAuthError` on 401 and
 * `ProviderHttpError` on any other non-2xx unless `okStatuses` says
 * that status is fine (e.g. 404 on a delete).
 */
export async function requestJson<T = unknown>(
  deps: HttpDeps,
  provider: CalendarProvider,
  url: string,
  init: RequestInit & { okStatuses?: number[] } = {},
): Promise<JsonResponse<T>> {
  const { okStatuses = [], ...rest } = init
  let res = await deps.fetch(url, rest)
  if (res.status === 429) {
    await deps.sleep(retryAfterMs(res.headers.get('retry-after')))
    res = await deps.fetch(url, rest)
  }
  const body = await parseBody<T>(res)
  if (res.ok || okStatuses.includes(res.status)) {
    return { status: res.status, body, headers: res.headers }
  }
  if (res.status === 401) throw new ProviderAuthError(provider, res.status, body)
  throw new ProviderHttpError(provider, res.status, body)
}

export function retryAfterMs(header: string | null): number {
  if (!header) return 1_000
  const secs = Number(header)
  if (Number.isFinite(secs) && secs >= 0) return Math.min(MAX_RETRY_AFTER_MS, Math.round(secs * 1000))
  const at = Date.parse(header)
  if (Number.isFinite(at)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, at - Date.now()))
  return 1_000
}

async function parseBody<T>(res: Response): Promise<T | null> {
  if (res.status === 204) return null
  const text = await res.text().catch(() => '')
  if (!text) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

/** Form-encoded POST (token endpoints). `invalid_grant` → auth error. */
export async function postForm<T = Record<string, unknown>>(
  deps: HttpDeps,
  provider: CalendarProvider,
  url: string,
  form: Record<string, string>,
): Promise<T> {
  const res = await deps.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
  })
  const body = await parseBody<Record<string, unknown>>(res)
  if (res.ok && body) return body as T
  const code = body && typeof body.error === 'string' ? body.error : ''
  if (res.status === 401 || code === 'invalid_grant' || code === 'invalid_token') {
    throw new ProviderAuthError(provider, res.status, body)
  }
  throw new ProviderHttpError(provider, res.status, body)
}

export function bearer(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, accept: 'application/json', ...extra }
}
