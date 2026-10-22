import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { loadAccountEntitlements } from '@/lib/plans-server'
import { checkRateLimit, type RateLimitResult } from '@/lib/rate-limit'
import { getClientIp } from '@/lib/request-ip'

import { ipInCidrs } from './cidr'
import { hasScope, hashApiKey, keyState, parseBearerKey, type ApiKeyScope } from './keys'

/** Per key (all endpoints). Beyond this callers get 429 + Retry-After. */
export const API_KEY_RATE_LIMIT = { limit: 120, windowMs: 60_000 }
/** Per account, across all its keys: rotating or minting keys does not multiply the budget. */
export const API_ACCOUNT_RATE_LIMIT = { limit: 300, windowMs: 60_000 }
/** Bad keys per client IP: blunts key guessing without locking out real keys. */
export const API_BAD_KEY_RATE_LIMIT = { limit: 30, windowMs: 60_000 }
const LAST_USED_WRITE_EVERY_MS = 60_000
const ENTITLEMENT_TTL_MS = 30_000

// ponytail: the rate limiters and these two caches are per Node process (the VPS runs
// one). With several instances each would allow its own budget; move to a shared store
// (Redis / a DB counter) before scaling out. last_used_at itself is throttled in the
// database (see touchKey), so it stays correct across processes.

export interface ApiKeyContext {
  keyId: string
  accountId: string
  scopes: string[]
  /** Caller address as seen by the reverse proxy (raw, not the rate-limit bucket). */
  ip: string | null
}

export type ApiAuthResult = { ok: true; ctx: ApiKeyContext; rate: RateLimitResult } | { ok: false; response: NextResponse }

export function apiError(status: number, code: string, message: string, headers?: Record<string, string>) {
  return NextResponse.json({ error: { code, message } }, { status, headers })
}

/** The client address for the allowlist / log (nginx sets X-Real-IP; see request-ip.ts). */
export function rawClientIp(request: Request): string | null {
  const real = request.headers.get('x-real-ip')?.trim()
  if (real) return real
  const xff = request.headers.get('x-forwarded-for')
  return xff ? xff.split(',').pop()?.trim() || null : null
}

const lastTouched = new Map<string, number>()
const blockedCache = new Map<string, { blocked: boolean; at: number }>()

export interface AuthDeps {
  db?: SupabaseClient
  now?: () => Date
  /** Plan check; defaults to the account's entitlements (cached 30 s). */
  accountBlocked?: (accountId: string) => Promise<boolean>
}

async function defaultAccountBlocked(db: SupabaseClient, accountId: string, nowMs: number): Promise<boolean> {
  const hit = blockedCache.get(accountId)
  if (hit && nowMs - hit.at < ENTITLEMENT_TTL_MS) return hit.blocked
  const ent = await loadAccountEntitlements(db, accountId)
  // Unreadable plan: fail closed.
  const blocked = !ent || !!ent.blocked
  blockedCache.set(accountId, { blocked, at: nowMs })
  return blocked
}

/**
 * Authenticates `Authorization: Bearer <key>` for the /api/v1 routes:
 * well-formed -> hash lookup -> not revoked / expired -> account not blocked
 * -> IP allowlist -> scope -> per-key and per-account rate limits ->
 * last_used_at / last_used_ip (written at most once a minute per key).
 */
export async function authenticateApiKey(
  request: Request,
  scope: ApiKeyScope | null,
  deps: AuthDeps = {},
): Promise<ApiAuthResult> {
  const now = (deps.now ?? (() => new Date()))()
  const ipBucket = getClientIp(request)
  const ip = rawClientIp(request)

  const deny = (status: number, code: string, message: string) => {
    const bad = checkRateLimit(`apiv1-bad:${ipBucket}`, API_BAD_KEY_RATE_LIMIT)
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
    .select('id, account_id, scopes, revoked_at, expires_at, last_used_at, allowed_cidrs')
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

  // Paywall / kill switch: a blocked or suspended account has no API either.
  const blocked = deps.accountBlocked
    ? await deps.accountBlocked(data.account_id)
    : await defaultAccountBlocked(db, data.account_id, now.getTime())
  if (blocked) {
    return { ok: false, response: apiError(403, 'account_blocked', 'This account is suspended or its plan is not active.') }
  }

  const cidrs = (data.allowed_cidrs ?? []) as string[]
  if (cidrs.length > 0 && !(ip && ipInCidrs(ip, cidrs))) {
    return { ok: false, response: apiError(403, 'ip_not_allowed', 'This API key cannot be used from this IP address.') }
  }

  if (scope && !hasScope(data.scopes, scope)) {
    return {
      ok: false,
      response: apiError(403, 'insufficient_scope', `This API key does not have the "${scope}" permission.`),
    }
  }

  const rate = checkRateLimit(`apiv1:${data.id}`, API_KEY_RATE_LIMIT)
  const acct = rate.success ? checkRateLimit(`apiv1-acct:${data.account_id}`, API_ACCOUNT_RATE_LIMIT) : rate
  if (!rate.success || !acct.success) {
    const hit = !rate.success ? rate : acct
    const retry = Math.max(1, Math.ceil((hit.reset - Date.now()) / 1000))
    return {
      ok: false,
      response: apiError(429, 'rate_limited', 'Rate limit exceeded for this API key.', {
        'Retry-After': String(retry),
        'X-RateLimit-Limit': String(hit.limit),
        'X-RateLimit-Remaining': '0',
      }),
    }
  }

  touchKey(db, data.id, ip, now)

  return { ok: true, ctx: { keyId: data.id, accountId: data.account_id, scopes: data.scopes, ip }, rate }
}

/**
 * last_used_at / last_used_ip. The per-process Map spares most queries; the
 * UPDATE itself is conditional in the database (null or older than a minute), so
 * several processes still write at most once a minute per key.
 */
function touchKey(db: SupabaseClient, keyId: string, ip: string | null, now: Date) {
  const lastWrite = lastTouched.get(keyId) ?? 0
  if (now.getTime() - lastWrite < LAST_USED_WRITE_EVERY_MS) return
  lastTouched.set(keyId, now.getTime())
  const stale = new Date(now.getTime() - LAST_USED_WRITE_EVERY_MS).toISOString()
  void db
    .from('api_keys')
    .update({ last_used_at: now.toISOString(), last_used_ip: ip })
    .eq('id', keyId)
    .or(`last_used_at.is.null,last_used_at.lt.${stale}`)
    .then(({ error }: { error: { message: string } | null }) => {
      if (error) console.error('[api-v1] last_used_at update failed:', error.message)
    })
}

/**
 * Records one authenticated request (time, route, status, IP) for the per-key log
 * in the settings UI. Bounded by api_purge(): 7 days and 200 rows per key. Never
 * blocks or fails the response.
 */
export function respondLogged(
  ctx: ApiKeyContext,
  request: Request,
  response: NextResponse,
  deps: { db?: SupabaseClient } = {},
): NextResponse {
  try {
    const db = deps.db ?? supabaseAdmin()
    void db
      .from('api_request_log')
      .insert({
        account_id: ctx.accountId,
        key_id: ctx.keyId,
        method: request.method,
        route: new URL(request.url).pathname,
        status: response.status,
        ip: ctx.ip,
      })
      .then(({ error }: { error: { message: string } | null }) => {
        if (error) console.error('[api-v1] request log failed:', error.message)
      })
  } catch (err) {
    console.error('[api-v1] request log failed:', err instanceof Error ? err.message : err)
  }
  return response
}

export function __resetLastTouchedForTests() {
  lastTouched.clear()
  blockedCache.clear()
}
