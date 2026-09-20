// ============================================================
// MFA (Supabase Auth TOTP) — pure decision helpers.
//
// Round 2 spec §7. Supabase models MFA as an "authenticator
// assurance level": a password sign-in yields an `aal1` session; a
// user who has a *verified* TOTP factor must complete a challenge to
// reach `aal2`. Nothing here touches the network — the middleware,
// the login page, the `/mfa` page and the dashboard shell all feed
// their own Supabase results through these functions so the rules
// live (and are tested) in one place.
//
// This module is isomorphic: no `next/headers`, no browser globals.
// ============================================================

import type { AccountRole } from './roles'

export type AssuranceLevel = 'aal1' | 'aal2'

/**
 * Shape of `supabase.auth.mfa.getAuthenticatorAssuranceLevel().data`.
 * Typed as `string` on purpose: supabase-js widens the union to
 * `'aal1' | 'aal2' | (string & {})`, so callers can pass its result
 * straight through without casts.
 */
export interface AssuranceLevels {
  currentLevel: AssuranceLevel | string | null
  nextLevel: AssuranceLevel | string | null
}

/** The subset of a Supabase `Factor` these helpers look at. */
export interface FactorLike {
  id: string
  factor_type?: string
  status?: string
  friendly_name?: string | null
}

/** Friendly name we enroll with — shows up in the authenticator app. */
export const MFA_FRIENDLY_NAME = 'SempreCRM'

/** Where an `aal1` session with a verified factor is sent. */
export const MFA_PATH = '/mfa'

/** Where a required-but-unenrolled admin is sent. */
export const MFA_ENROLL_PATH = '/settings?tab=security'

/** TOTP codes are always six digits (RFC 6238 default). */
export const MFA_CODE_LENGTH = 6
const CODE_RE = /^\d{6}$/

export function isValidMfaCode(code: unknown): code is string {
  return typeof code === 'string' && CODE_RE.test(code)
}

/** Keep only the digits and cap at six — for the code inputs. */
export function normalizeMfaCodeInput(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, MFA_CODE_LENGTH)
}

/**
 * True when the session must complete a TOTP challenge before the
 * app is usable: the token is at `aal1` but the user could reach
 * `aal2` (they own a verified factor). Null / unknown input → false,
 * so a Supabase error never locks the user out.
 */
export function needsMfaChallenge(levels: AssuranceLevels | null | undefined): boolean {
  if (!levels) return false
  return levels.currentLevel === 'aal1' && levels.nextLevel === 'aal2'
}

/** Verified TOTP factors only — the ones that can answer a challenge. */
export function verifiedTotpFactors<T extends FactorLike>(factors: readonly T[] | null | undefined): T[] {
  if (!factors) return []
  return factors.filter((f) => f.status === 'verified' && (f.factor_type ?? 'totp') === 'totp')
}

export function hasVerifiedTotp(factors: readonly FactorLike[] | null | undefined): boolean {
  return verifiedTotpFactors(factors).length > 0
}

/**
 * Enrollments the user started but never confirmed. They block a new
 * enroll with the same friendly name, so the settings card unenrolls
 * them before starting over.
 */
export function unverifiedTotpFactors<T extends FactorLike>(factors: readonly T[] | null | undefined): T[] {
  if (!factors) return []
  return factors.filter((f) => f.status !== 'verified' && (f.factor_type ?? 'totp') === 'totp')
}

/**
 * Compute the assurance levels the way supabase-js does, but from a
 * *fresh* user object (`auth.getUser()` returns `user.factors`) so a
 * factor enrolled on another device is honoured as soon as the
 * middleware sees the user, not only after the next token refresh.
 */
export function resolveAssuranceLevels(
  currentLevel: AssuranceLevel | string | null | undefined,
  factors: readonly FactorLike[] | null | undefined,
): AssuranceLevels {
  const current = currentLevel ?? null
  const next = hasVerifiedTotp(factors) ? 'aal2' : current
  return { currentLevel: current, nextLevel: next }
}

/**
 * Paths an `aal1`-but-should-be-`aal2` user may still reach: the
 * challenge page itself, our own auth API (audit of enroll/unenroll,
 * anything under /api/auth) and Next internals. Sign-out goes
 * straight to Supabase from the browser, so it needs no path here.
 */
export function isMfaExemptPath(pathname: string): boolean {
  if (pathname === MFA_PATH || pathname.startsWith(`${MFA_PATH}/`)) return true
  if (pathname.startsWith('/api/auth/') || pathname === '/api/auth') return true
  // E-mail links: the callback must run before any challenge, and a
  // recovery session (password only) must be able to set the new
  // password — the TOTP is asked again on the next sign-in.
  if (pathname === '/auth/callback' || pathname === '/reset-password') return true
  if (pathname.startsWith('/_next/')) return true
  return false
}

/**
 * Roles the owner's "Exigir duas etapas para admins" toggle applies
 * to. Owners are included: they hold the most power in the account.
 */
export function isMfaRequiredRole(role: AccountRole | null | undefined): boolean {
  return role === 'owner' || role === 'admin'
}

export interface MfaRequirementInput {
  role: AccountRole | null | undefined
  requireMfaAdmins: boolean
  hasVerifiedFactor: boolean
}

/**
 * True when the account demands MFA from this user and they have not
 * enrolled yet → the shell sends them to Settings → Login e segurança.
 */
export function mustEnrollMfa({ role, requireMfaAdmins, hasVerifiedFactor }: MfaRequirementInput): boolean {
  if (!requireMfaAdmins) return false
  if (!isMfaRequiredRole(role)) return false
  return !hasVerifiedFactor
}

/**
 * Where the enroll redirect may take the user without bouncing: the
 * whole settings area is allowed (the security tab lives there and the
 * rail must stay navigable), everything else goes to the enroll path.
 */
export function isMfaEnrollAllowedPath(pathname: string): boolean {
  return pathname === '/settings' || pathname.startsWith('/settings/')
}

/**
 * Validate a `?next=` hint for the post-challenge redirect. Only
 * same-origin absolute paths survive; anything else → `/dashboard`.
 */
export function safeNextPath(raw: string | null | undefined, fallback = '/dashboard'): string {
  if (!raw || typeof raw !== 'string') return fallback
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return fallback
  if (raw.startsWith(MFA_PATH)) return fallback
  if (/[\r\n]/.test(raw)) return fallback
  return raw
}
