// ============================================================
// OAuth `state` for connecting a channel — signed, short-lived and bound to
// account + user + kind:
//
//   state = base64url(JSON{u, a, k, n, t}) + "." + HMAC-SHA256(payload, ENCRYPTION_KEY)
//
// Verified with a constant-time compare, a 10 min max age and the kind the
// callback route expects. Single use: the nonce `n` also travels in an httpOnly
// cookie that the callback checks and clears, so a replayed state (without the
// cookie) is refused, and Meta's authorization code can be redeemed only once.
// ============================================================

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import type { MetaMessagingChannel } from '@/types'

export const STATE_MAX_AGE_MS = 10 * 60_000

export interface ConnectState {
  userId: string
  accountId: string
  kind: MetaMessagingChannel
  nonce: string
  issuedAt: number
}

function key(secret: string | undefined = process.env.ENCRYPTION_KEY): Buffer {
  const hex = (secret ?? '').trim()
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('ENCRYPTION_KEY must be 64 hex chars to sign the OAuth state')
  return Buffer.from(hex, 'hex')
}

const sign = (payload: string, secret?: string) => createHmac('sha256', key(secret)).update(payload).digest('hex')

export function signConnectState(
  input: { userId: string; accountId: string; kind: MetaMessagingChannel; nonce?: string; now?: number },
  secret?: string,
): string {
  const body = {
    u: input.userId,
    a: input.accountId,
    k: input.kind,
    n: input.nonce ?? randomBytes(16).toString('hex'),
    t: input.now ?? Date.now(),
  }
  const payload = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url')
  return `${payload}.${sign(payload, secret)}`
}

/** Null on a bad signature, malformed payload, expired token or a kind mismatch. */
export function verifyConnectState(
  state: string | null | undefined,
  opts: { kind: MetaMessagingChannel; now?: number; maxAgeMs?: number; secret?: string },
): ConnectState | null {
  if (typeof state !== 'string' || state.length > 2048) return null
  const dot = state.indexOf('.')
  if (dot <= 0) return null
  const payload = state.slice(0, dot)
  const sig = state.slice(dot + 1)
  if (!/^[0-9a-f]{64}$/.test(sig)) return null
  const a = Buffer.from(sig, 'hex')
  const b = Buffer.from(sign(payload, opts.secret), 'hex')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  let body: unknown
  try {
    body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (!body || typeof body !== 'object') return null
  const { u, a: acc, k, n, t } = body as Record<string, unknown>
  if (typeof u !== 'string' || !u || typeof acc !== 'string' || !acc) return null
  if (typeof n !== 'string' || !n || typeof t !== 'number') return null
  if ((k !== 'instagram' && k !== 'messenger') || k !== opts.kind) return null
  const now = opts.now ?? Date.now()
  if (t > now + 60_000 || now - t > (opts.maxAgeMs ?? STATE_MAX_AGE_MS)) return null
  return { userId: u, accountId: acc, kind: k, nonce: n, issuedAt: t }
}
