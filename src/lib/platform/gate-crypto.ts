// ============================================================
// Pure crypto for the platform gate (/platform/login): password
// hashing and the signed session token carried in the cookie.
//
// Node built-ins only (scrypt + HMAC) so there is no native
// dependency to build on the VPS. Everything here is deterministic
// given its inputs, which keeps it unit-testable without Next.
// ============================================================

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

// scrypt parameters: N=2^15 is ~50 ms on the VPS — slow enough to
// blunt offline guessing, fast enough for one login per session.
const SCRYPT_N = 32768
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LEN = 32
// scrypt needs 128*N*r bytes; Node caps at 32 MiB by default, which is
// exactly this configuration's footprint; give it head-room.
const SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_R * 2

export const GATE_USERNAME_MIN = 3
export const GATE_USERNAME_MAX = 40
export const GATE_PASSWORD_MIN = 8
export const GATE_PASSWORD_MAX = 128

/** `scrypt$N$r$p$<salt b64url>$<hash b64url>` */
export function hashGatePassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM })
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, b64url(salt), b64url(hash)].join('$')
}

export function verifyGatePassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return false
  // Refuse absurd parameters from a tampered row instead of eating RAM.
  if (N > SCRYPT_N || r > SCRYPT_R || p > 4) return false
  const salt = fromB64url(parts[4])
  const expected = fromB64url(parts[5])
  let actual: Buffer
  try {
    actual = scryptSync(password, salt, expected.length, { N, r, p, maxmem: SCRYPT_MAXMEM })
  } catch {
    return false
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

// ------------------------------------------------------------
// Session token: `v1.<userId>.<expiresAtSec>.<hmac>` — stateless,
// so verifying a request costs no DB round trip. The `generation`
// (credentials' updated_at, epoch seconds) is mixed into the MAC so a
// password change invalidates every cookie issued before it.
// ------------------------------------------------------------
const TOKEN_VERSION = 'v1'

export function signGateToken(
  secret: string,
  userId: string,
  generation: number,
  expiresAtSec: number,
): string {
  const payload = `${TOKEN_VERSION}.${userId}.${expiresAtSec}`
  return `${payload}.${mac(secret, payload, generation)}`
}

export interface GateTokenClaims {
  userId: string
  expiresAtSec: number
}

/**
 * Returns the claims when the token is well-formed, signed with
 * `secret` for this `generation`, belongs to `userId` and has not
 * expired at `nowSec`; otherwise null.
 */
export function verifyGateToken(
  secret: string,
  token: string | undefined,
  userId: string,
  generation: number,
  nowSec = Math.floor(Date.now() / 1000),
): GateTokenClaims | null {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 4 || parts[0] !== TOKEN_VERSION) return null
  const [, tokenUser, expStr, sig] = parts
  const expiresAtSec = Number(expStr)
  if (!Number.isInteger(expiresAtSec) || expiresAtSec <= nowSec) return null
  if (tokenUser !== userId) return null
  const expected = mac(secret, `${TOKEN_VERSION}.${tokenUser}.${expStr}`, generation)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  return { userId: tokenUser, expiresAtSec }
}

function mac(secret: string, payload: string, generation: number): string {
  return b64url(createHmac('sha256', secret).update(`${payload}.${generation}`).digest())
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url')
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s, 'base64url')
}

/** Normalised username: trimmed, lower-case, or null when out of bounds. */
export function normalizeGateUsername(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const u = raw.trim().toLowerCase()
  if (u.length < GATE_USERNAME_MIN || u.length > GATE_USERNAME_MAX) return null
  if (!/^[a-z0-9][a-z0-9._@-]*$/.test(u)) return null
  return u
}

export function isAcceptableGatePassword(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.length >= GATE_PASSWORD_MIN && raw.length <= GATE_PASSWORD_MAX
}
