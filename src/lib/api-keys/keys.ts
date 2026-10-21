import { createHash, randomBytes } from 'node:crypto'

import { API_KEY_SCOPES, type ApiKeyScope } from './scopes'

export * from './scopes'

/**
 * Public API keys. Format `scrm_live_<32 url-safe chars>` (192 bits of
 * entropy). Only the SHA-256 is stored: with that much entropy a fast hash
 * is enough, and it lets the lookup be a single indexed equality.
 */
export const API_KEY_PREFIX = 'scrm_live_'

export interface GeneratedKey {
  key: string
  prefix: string
  last4: string
  hash: string
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

export function generateApiKey(): GeneratedKey {
  const key = `${API_KEY_PREFIX}${randomBytes(24).toString('base64url')}`
  return { key, prefix: key.slice(0, API_KEY_PREFIX.length + 4), last4: key.slice(-4), hash: hashApiKey(key) }
}

const BEARER = new RegExp(`^Bearer\\s+(${API_KEY_PREFIX}[A-Za-z0-9_-]{32})$`, 'i')

/** The key from an `Authorization: Bearer ...` header, or null when absent / malformed. */
export function parseBearerKey(header: string | null | undefined): string | null {
  const m = header ? BEARER.exec(header.trim()) : null
  return m ? m[1] : null
}

export function normalizeScopes(input: unknown): ApiKeyScope[] | null {
  if (!Array.isArray(input) || input.length === 0) return null
  const out = new Set<ApiKeyScope>()
  for (const s of input) {
    if (!(API_KEY_SCOPES as readonly unknown[]).includes(s)) return null
    out.add(s as ApiKeyScope)
  }
  return [...out]
}

export function hasScope(scopes: readonly string[], required: ApiKeyScope): boolean {
  return scopes.includes(required)
}

export type KeyState = 'active' | 'revoked' | 'expired'

export function keyState(row: { revoked_at: string | null; expires_at: string | null }, now: Date): KeyState {
  if (row.revoked_at) return 'revoked'
  if (row.expires_at && new Date(row.expires_at).getTime() <= now.getTime()) return 'expired'
  return 'active'
}
