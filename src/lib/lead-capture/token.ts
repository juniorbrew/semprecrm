// Server-only: the source token is the caller's only credential, so it
// is minted here (32 random bytes, hex) and never by the browser.
import { randomBytes } from 'node:crypto'

export const LEAD_TOKEN_BYTES = 32
export const LEAD_TOKEN_RE = /^[0-9a-f]{64}$/

export function generateLeadSourceToken(): string {
  return randomBytes(LEAD_TOKEN_BYTES).toString('hex')
}

export function isLeadSourceToken(value: unknown): value is string {
  return typeof value === 'string' && LEAD_TOKEN_RE.test(value)
}
