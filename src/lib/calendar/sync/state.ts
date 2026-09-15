// ============================================================
// OAuth `state` — a signed, short-lived token that binds the callback
// to the user who started the flow.
//
//   state = base64url(JSON{u: user_id, p: provider, n: nonce, t: ms})
//           + "." + HMAC-SHA256(payload, ENCRYPTION_KEY) as hex
//
// Verified with a constant-time compare, a max age (10 min) and the
// provider the callback route expects. The key is the same 32-byte
// hex secret the token encryption uses (src/lib/whatsapp/encryption.ts).
// ============================================================

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import type { CalendarProvider } from '@/types'

import { isCalendarProvider } from './config'

export const STATE_MAX_AGE_MS = 10 * 60_000

export interface OAuthState {
  userId: string
  provider: CalendarProvider
  nonce: string
  /** Epoch ms at which the state was issued. */
  issuedAt: number
}

function keyBytes(secret: string | undefined = process.env.ENCRYPTION_KEY): Buffer {
  const hex = (secret ?? '').trim()
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error('ENCRYPTION_KEY must be 64 hex chars to sign the OAuth state')
  }
  return Buffer.from(hex, 'hex')
}

function sign(payload: string, secret?: string): string {
  return createHmac('sha256', keyBytes(secret)).update(payload).digest('hex')
}

export function newNonce(): string {
  return randomBytes(16).toString('hex')
}

/** Build and sign a state for `userId` × `provider`. */
export function signState(
  input: { userId: string; provider: CalendarProvider; nonce?: string; now?: number },
  secret?: string,
): string {
  const body = {
    u: input.userId,
    p: input.provider,
    n: input.nonce ?? newNonce(),
    t: input.now ?? Date.now(),
  }
  const payload = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url')
  return `${payload}.${sign(payload, secret)}`
}

/**
 * Parse and verify a state. Returns null on a bad signature, a
 * malformed payload, an expired token or a provider mismatch.
 */
export function verifyState(
  state: string | null | undefined,
  opts: { provider: CalendarProvider; now?: number; maxAgeMs?: number; secret?: string },
): OAuthState | null {
  if (typeof state !== 'string' || state.length > 2048) return null
  const dot = state.indexOf('.')
  if (dot <= 0) return null
  const payload = state.slice(0, dot)
  const sig = state.slice(dot + 1)
  if (!/^[0-9a-f]{64}$/.test(sig)) return null
  const expected = sign(payload, opts.secret)
  const a = Buffer.from(sig, 'hex')
  const b = Buffer.from(expected, 'hex')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  let body: unknown
  try {
    body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (!body || typeof body !== 'object') return null
  const { u, p, n, t } = body as Record<string, unknown>
  if (typeof u !== 'string' || !u || typeof n !== 'string' || !n || typeof t !== 'number') return null
  if (!isCalendarProvider(p) || p !== opts.provider) return null
  const now = opts.now ?? Date.now()
  const maxAge = opts.maxAgeMs ?? STATE_MAX_AGE_MS
  if (t > now + 60_000 || now - t > maxAge) return null
  return { userId: u, provider: p, nonce: n, issuedAt: t }
}
