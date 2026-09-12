// ============================================================
// Client for `services/wa-gateway` — the Baileys (WhatsApp Web)
// process that holds one QR session per account.
//
// HTTP contract (spec 2026-09-12-whatsapp-qr-channel-design.md):
//   POST /sessions/:accountId/connect  → { status }
//   GET  /sessions/:accountId          → { status, qr?, phone?, name?, connected_at? }
//   POST /sessions/:accountId/logout   → {}
//   POST /sessions/:accountId/send     → { message_id }
// Every request carries `x-gateway-secret: WA_GATEWAY_SECRET`; the
// gateway calls us back with the same header.
//
// No `next/*` imports — the automation / flow engines import this
// from a bare node context.
// ============================================================

import { timingSafeEqual } from 'crypto'

import type { WaQrSessionStatus } from '@/types'

export const GATEWAY_SECRET_HEADER = 'x-gateway-secret'

export interface GatewayConfig {
  url: string
  secret: string
}

/** `null` when either env var is missing — the QR option is disabled. */
export function getGatewayConfig(): GatewayConfig | null {
  const url = process.env.WA_GATEWAY_URL?.trim().replace(/\/+$/, '')
  const secret = process.env.WA_GATEWAY_SECRET?.trim()
  if (!url || !secret) return null
  return { url, secret }
}

export function isGatewayConfigured(): boolean {
  return getGatewayConfig() !== null
}

/** The gateway env is not set — surfaced as 503 `gateway_unconfigured`. */
export class GatewayNotConfiguredError extends Error {
  readonly code = 'gateway_unconfigured' as const
  constructor() {
    super('Gateway não configurado. Defina WA_GATEWAY_URL e WA_GATEWAY_SECRET no servidor.')
    this.name = 'GatewayNotConfiguredError'
  }
}

/** Network failure / timeout / non-2xx from the gateway — 503 `gateway_unreachable`. */
export class GatewayUnreachableError extends Error {
  readonly code = 'gateway_unreachable' as const
  readonly status: number | null
  constructor(detail?: string, status: number | null = null) {
    super(
      detail
        ? `Não foi possível falar com o gateway do WhatsApp (${detail}).`
        : 'Não foi possível falar com o gateway do WhatsApp. Verifique se o serviço wa-gateway está em execução.',
    )
    this.name = 'GatewayUnreachableError'
    this.status = status
  }
}

/**
 * The gateway answered with a 4xx the user can act on. `code` is the
 * gateway's own error code (`not_connected`, `not_on_whatsapp`,
 * `invalid_request`, …) and `message` is already pt-BR for the ones
 * the inbox shows as a toast.
 */
export class GatewayRequestError extends Error {
  readonly code: string
  readonly status: number
  constructor(message: string, status: number, code = 'gateway_error') {
    super(message)
    this.name = 'GatewayRequestError'
    this.status = status
    this.code = code
  }
}

/** pt-BR copy for the gateway error codes the inbox surfaces as toasts. */
const GATEWAY_ERROR_COPY: Record<string, string> = {
  not_connected: 'WhatsApp desconectado. Reconecte em Configurações.',
  not_on_whatsapp: 'Este número não está no WhatsApp.',
  send_failed: 'O WhatsApp recusou o envio. Tente novamente.',
  invalid_request: 'Pedido inválido para o gateway do WhatsApp.',
}

export interface GatewaySessionState {
  status: WaQrSessionStatus
  /** data: URL of the current QR (only while status === 'qr'). */
  qr?: string | null
  phone?: string | null
  name?: string | null
  connected_at?: string | null
  error?: string | null
}

const DEFAULT_TIMEOUT_MS = 8_000

/**
 * One call to the gateway. Throws the typed errors above so routes can
 * map them to 503 / 4xx without string matching.
 */
export async function gatewayFetch<T>(
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const cfg = getGatewayConfig()
  if (!cfg) throw new GatewayNotConfiguredError()

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  let res: Response
  try {
    res = await fetch(`${cfg.url}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        [GATEWAY_SECRET_HEADER]: cfg.secret,
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
      cache: 'no-store',
    })
  } catch (err) {
    const detail =
      err instanceof Error && err.name === 'AbortError'
        ? 'tempo esgotado'
        : err instanceof Error
          ? err.message
          : String(err)
    throw new GatewayUnreachableError(detail)
  } finally {
    clearTimeout(timer)
  }

  let payload: unknown = null
  const text = await res.text()
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }

  if (!res.ok) {
    // Gateway error body: `{ error: <code>, message: <human text> }`.
    const obj = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
    const code = typeof obj.error === 'string' ? obj.error : null
    const detail = typeof obj.message === 'string' ? obj.message : code
    if (res.status === 401 || res.status === 403 || (res.status >= 500 && res.status !== 502)) {
      // A gateway that rejects our secret is as good as unreachable
      // from the customer's point of view — misconfiguration, not
      // something they can fix from the panel.
      throw new GatewayUnreachableError(detail ?? `HTTP ${res.status}`, res.status)
    }
    const copy = (code && GATEWAY_ERROR_COPY[code]) || detail || `Gateway respondeu HTTP ${res.status}`
    throw new GatewayRequestError(copy, res.status, code ?? 'gateway_error')
  }

  return (payload ?? {}) as T
}

export const VALID_SESSION_STATUSES: readonly WaQrSessionStatus[] = [
  'disconnected',
  'qr',
  'connecting',
  'connected',
]

export function isSessionStatus(value: unknown): value is WaQrSessionStatus {
  return typeof value === 'string' && (VALID_SESSION_STATUSES as readonly string[]).includes(value)
}

// ------------------------------------------------------------
// Session operations
// ------------------------------------------------------------

export function connectSession(accountId: string): Promise<{ status: WaQrSessionStatus }> {
  return gatewayFetch(`/sessions/${encodeURIComponent(accountId)}/connect`, { method: 'POST' })
}

export function getSessionState(accountId: string): Promise<GatewaySessionState> {
  return gatewayFetch(`/sessions/${encodeURIComponent(accountId)}`)
}

export function logoutSession(accountId: string): Promise<{ status?: WaQrSessionStatus }> {
  return gatewayFetch(`/sessions/${encodeURIComponent(accountId)}/logout`, { method: 'POST' })
}

export interface GatewayMedia {
  url: string
  mimetype: string
  filename?: string
  caption?: string
  /** Voice note (push-to-talk) instead of an audio file. */
  ptt?: boolean
}

export interface GatewaySendInput {
  accountId: string
  /** Digits only, e.g. "5511999999999". */
  to: string
  text?: string
  media?: GatewayMedia
}

export async function sendViaGateway(input: GatewaySendInput): Promise<{ message_id: string }> {
  const res = await gatewayFetch<{ message_id?: string }>(
    `/sessions/${encodeURIComponent(input.accountId)}/send`,
    {
      method: 'POST',
      body: {
        to: input.to,
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.media ? { media: input.media } : {}),
      },
      // Media uploads can take a while on the gateway side.
      timeoutMs: 30_000,
    },
  )
  if (!res.message_id) {
    throw new GatewayUnreachableError('resposta sem message_id')
  }
  return { message_id: res.message_id }
}

// ------------------------------------------------------------
// Inbound auth — the gateway → app direction
// ------------------------------------------------------------

/**
 * Constant-time check of the `x-gateway-secret` header against
 * `WA_GATEWAY_SECRET`. False when the env is unset (fail closed).
 */
export function verifyGatewaySecret(headerValue: string | null | undefined): boolean {
  const cfg = getGatewayConfig()
  if (!cfg || !headerValue) return false
  const a = Buffer.from(headerValue, 'utf8')
  const b = Buffer.from(cfg.secret, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Convenience for route handlers. */
export function isGatewayRequest(request: Request): boolean {
  return verifyGatewaySecret(request.headers.get(GATEWAY_SECRET_HEADER))
}
