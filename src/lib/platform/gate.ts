// ============================================================
// Platform gate — server-side glue between the credential table
// (migration 045), the signed cookie and the request.
//
// Server-only: uses next/headers and the service-role client.
// ============================================================

import { createHash } from 'node:crypto'
import { cookies } from 'next/headers'

import { supabaseAdmin } from '@/lib/automations/admin-client'

import { signGateToken, verifyGateToken } from './gate-crypto'

export const GATE_COOKIE = 'sc-platform-gate'
export const GATE_LOGIN_PATH = '/platform/login'
/** How long one gate sign-in lasts before the password is asked again. */
export const GATE_SESSION_SECONDS = 8 * 60 * 60

export interface GateCredentials {
  userId: string
  username: string
  passwordHash: string
  /** epoch seconds of `updated_at` — the token "generation". */
  generation: number
}

/**
 * HMAC key for the cookie. `PLATFORM_GATE_SECRET` when set; otherwise
 * derived from the service-role key so an existing install works
 * without a new variable (the derivation is one-way, the key itself
 * never leaves the process).
 */
export function gateSecret(): string {
  const explicit = process.env.PLATFORM_GATE_SECRET
  if (explicit && explicit.length >= 16) return explicit
  const base = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!base) throw new Error('PLATFORM_GATE_SECRET or SUPABASE_SERVICE_ROLE_KEY must be set')
  return createHash('sha256').update(`platform-gate:${base}`).digest('hex')
}

export async function loadGateCredentials(userId: string): Promise<GateCredentials | null> {
  const { data, error } = await supabaseAdmin()
    .from('platform_gate_credentials')
    .select('user_id, username, password_hash, updated_at')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) {
    console.error('[platform gate] load failed:', error.message)
    return null
  }
  if (!data) return null
  return {
    userId: data.user_id as string,
    username: data.username as string,
    passwordHash: data.password_hash as string,
    generation: Math.floor(new Date(data.updated_at as string).getTime() / 1000),
  }
}

/** True when the request carries a valid gate cookie for this admin. */
export async function hasGateSession(creds: GateCredentials | null): Promise<boolean> {
  if (!creds) return false
  const store = await cookies()
  const token = store.get(GATE_COOKIE)?.value
  return verifyGateToken(gateSecret(), token, creds.userId, creds.generation) !== null
}

/** Cookie value + options for a fresh gate session (Route Handlers only). */
export function issueGateCookie(creds: GateCredentials) {
  const expiresAtSec = Math.floor(Date.now() / 1000) + GATE_SESSION_SECONDS
  return {
    name: GATE_COOKIE,
    value: signGateToken(gateSecret(), creds.userId, creds.generation, expiresAtSec),
    options: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax' as const,
      path: '/',
      maxAge: GATE_SESSION_SECONDS,
    },
  }
}

export function clearGateCookie() {
  return { name: GATE_COOKIE, value: '', options: { path: '/', maxAge: 0 } }
}
