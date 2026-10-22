import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Outbound webhook signatures (same scheme as Stripe):
 *
 *   SempreCRM-Signature: t=1700000000,v1=<hex>,v1=<hex>
 *
 * v1 = HMAC-SHA256(secret, `${t}.${rawBody}`). While a secret is being
 * rotated the header carries one v1 per live secret (current + previous),
 * so the receiver verifies against whichever secret it still has.
 */
export const SIGNATURE_HEADER = 'SempreCRM-Signature'
export const DEFAULT_TOLERANCE_SECONDS = 300

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`
}

export function computeSignature(secret: string, timestamp: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
}

export function buildSignatureHeader(secrets: string[], timestamp: number, rawBody: string): string {
  return [`t=${timestamp}`, ...secrets.map((s) => `v1=${computeSignature(s, timestamp, rawBody)}`)].join(',')
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'malformed_header' | 'timestamp_outside_tolerance' | 'no_matching_signature' }

export function verifySignatureHeader(opts: {
  header: string | null | undefined
  rawBody: string
  /** The endpoint secret(s) the receiver knows (pass old + new while rotating). */
  secrets: string[]
  toleranceSeconds?: number
  nowSeconds?: number
}): VerifyResult {
  const { header, rawBody, secrets } = opts
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000)
  if (!header) return { ok: false, reason: 'malformed_header' }

  let timestamp = NaN
  const candidates: string[] = []
  for (const part of header.split(',')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k === 't') timestamp = Number(v)
    else if (k === 'v1') candidates.push(v)
  }
  if (!Number.isInteger(timestamp) || candidates.length === 0) {
    return { ok: false, reason: 'malformed_header' }
  }
  if (Math.abs(now - timestamp) > tolerance) {
    return { ok: false, reason: 'timestamp_outside_tolerance' }
  }
  for (const secret of secrets) {
    const expected = Buffer.from(computeSignature(secret, timestamp, rawBody), 'hex')
    for (const c of candidates) {
      const got = Buffer.from(c, 'hex')
      if (got.length === expected.length && timingSafeEqual(got, expected)) return { ok: true }
    }
  }
  return { ok: false, reason: 'no_matching_signature' }
}
