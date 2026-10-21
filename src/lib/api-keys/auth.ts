import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { checkRateLimit, type RateLimitResult } from '@/lib/rate-limit'
import { getClientIp, rateLimitIpKey } from '@/lib/request-ip'

import { hasScope, hashApiKey, keyState, parseBearerKey, type ApiKeyScope } from './keys'

/** Per key (all endpoints). Beyond this callers get 429 + Retry-After. */
export const API_KEY_RATE_LIMIT = { limit: 120, windowMs: 60_000 }
/** Bad keys per client IP: blunts key guessing without locking out real keys. */
export const API_BAD_KEY_RATE_LIMIT = { limit: 30, windowMs: 60_000 }
const LAST_USED_WRITE_EVERY_MS = 60_000

export interface ApiKeyContext {
  keyId: string
  accountId: string
  scopes: string[]
}

export type ApiAuthResult = { ok: true; ctx: ApiKeyContext; rate: RateLimitResult } | { ok: false; response: NextResponse }

export function apiError(status: number, code: string, message: string, headers?: Record<string, string>) {
  return NextResponse.json({ error: { code, message } }, { status, headers })
}

const lastTouched = new Map<string, number>()

export interface AuthDeps {
  db?: SupabaseClient
  now?: () => Date
}

/**
 * Authenticates `Authorization: Bearer <key>` for the /api/v1 routes:
 * well-formed -> hash lookup -> not revoked / expired -> scope -> per-key
 * rate limit -> last_used_at (written at most once a minute per key).
 */
export async function authenticateApiKey(
  request: Request,
  scope: ApiKeyScope | null,
  deps: AuthDeps = {},
): Promise<ApiAuthResult> {
  const now = (deps.now ?? (() => new Date()))()
  const ip = rateLimitIpKey(getClientIp(request))

  const deny = (status: number, code: string, message: string) => {
    const bad = checkRateLimit(`apiv1-bad:${ip}`, API_BAD_KEY_RATE_LIMIT)
    if (!bad.success) {
      return { ok: false as const, response: apiError(429, 'rate_limited', 'Too many invalid requests', { 'Retry-After': '60' }) }
    }
    return { ok: false as const, response: apiError(status, code, message, status === 401 ? { 'WWW-Authenticate': 'Bearer' } : undefined) }
  }

  const key = parseBearerKey(request.headers.get('authorization'))
  if (!key) return deny(401, 'missing_api_key', 'Send your key as "Authorization: Bearer <key>".')

  const db = deps.db ?? supabaseAdmin()
  const { data, error } = await db
    .from('api_keys')
    .select('id, account_id, scopes, revoked_at, expires_at, last_used_at')
    .eq('key_hash', hashApiKey(key))
    .maybeSingle()
  if (error) {
    console.error('[api-v1] key lookup failed:', error.message)
    return { ok: false, response: apiError(500, 'internal_error', 'Could not validate the API key.') }
  }
  if (!data) return deny(401, 'invalid_api_key', 'This API key is not valid.')

  const state = keyState(data, now)
  if (state !== 'active') {
    return deny(401, state === 'revoked' ? 'api_key_revoked' : 'api_key_expired', `This API key was ${state}.`)
  }
  if (scope && !hasScope(data.scopes, scope)) {
    return {
      ok: false,
      response: apiError(403, 'insufficient_scope', `This API key does not have the "${scope}" permission.`),
    }
  }

  const rate = checkRateLimit(`apiv1:${data.id}`, API_KEY_RATE_LIMIT)
  if (!rate.success) {
    const retry = Math.max(1, Math.ceil((rate.reset - Date.now()) / 1000))
    return {
      ok: false,
      response: apiError(429, 'rate_limited', 'Rate limit exceeded for this API key.', {
        'Retry-After': String(retry),
        'X-RateLimit-Limit': String(rate.limit),
        'X-RateLimit-Remaining': '0',
      }),
    }
  }

  const lastWrite = lastTouched.get(data.id) ?? 0
  if (now.getTime() - lastWrite >= LAST_USED_WRITE_EVERY_MS) {
    lastTouched.set(data.id, now.getTime())
    void db
      .from('api_keys')
      .update({ last_used_at: now.toISOString() })
      .eq('id', data.id)
      .then(({ error: e }: { error: { message: string } | null }) => {
        if (e) console.error('[api-v1] last_used_at update failed:', e.message)
      })
  }

  return { ok: true, ctx: { keyId: data.id, accountId: data.account_id, scopes: data.scopes }, rate }
}

export function __resetLastTouchedForTests() {
  lastTouched.clear()
}
