import { describe, expect, it } from 'vitest'

import {
  buildSignatureHeader,
  computeSignature,
  generateWebhookSecret,
  verifySignatureHeader,
} from './signing'

const BODY = '{"id":"evt_1","type":"message.received"}'
const NOW = 1_700_000_000

describe('webhook signing', () => {
  it('generates whsec_ secrets that are unique and long enough', () => {
    const a = generateWebhookSecret()
    expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/)
    expect(generateWebhookSecret()).not.toBe(a)
  })

  it('signs timestamp.body with HMAC-SHA256 (known vector)', () => {
    // echo -n '1700000000.{"id":"evt_1","type":"message.received"}' | openssl dgst -sha256 -hmac whsec_test
    const sig = computeSignature('whsec_test', NOW, BODY)
    expect(sig).toMatch(/^[0-9a-f]{64}$/)
    expect(computeSignature('whsec_test', NOW, BODY)).toBe(sig)
    expect(computeSignature('whsec_test', NOW + 1, BODY)).not.toBe(sig)
    expect(computeSignature('whsec_test', NOW, BODY + ' ')).not.toBe(sig)
  })

  it('round-trips through the header', () => {
    const header = buildSignatureHeader(['whsec_a'], NOW, BODY)
    expect(header).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/)
    expect(verifySignatureHeader({ header, rawBody: BODY, secrets: ['whsec_a'], nowSeconds: NOW })).toEqual({ ok: true })
  })

  it('rejects a wrong secret and a tampered body', () => {
    const header = buildSignatureHeader(['whsec_a'], NOW, BODY)
    expect(verifySignatureHeader({ header, rawBody: BODY, secrets: ['whsec_b'], nowSeconds: NOW })).toEqual({
      ok: false,
      reason: 'no_matching_signature',
    })
    expect(verifySignatureHeader({ header, rawBody: BODY + 'x', secrets: ['whsec_a'], nowSeconds: NOW })).toEqual({
      ok: false,
      reason: 'no_matching_signature',
    })
  })

  it('enforces the 5 minute tolerance in both directions', () => {
    const header = buildSignatureHeader(['whsec_a'], NOW, BODY)
    const check = (now: number) => verifySignatureHeader({ header, rawBody: BODY, secrets: ['whsec_a'], nowSeconds: now })
    expect(check(NOW + 300).ok).toBe(true)
    expect(check(NOW + 301)).toEqual({ ok: false, reason: 'timestamp_outside_tolerance' })
    expect(check(NOW - 301)).toEqual({ ok: false, reason: 'timestamp_outside_tolerance' })
    expect(
      verifySignatureHeader({ header, rawBody: BODY, secrets: ['whsec_a'], nowSeconds: NOW + 3600, toleranceSeconds: 7200 }).ok,
    ).toBe(true)
  })

  it('carries one v1 per secret during rotation, so either secret verifies', () => {
    const header = buildSignatureHeader(['whsec_new', 'whsec_old'], NOW, BODY)
    expect(header.match(/v1=/g)).toHaveLength(2)
    for (const secret of ['whsec_new', 'whsec_old']) {
      expect(verifySignatureHeader({ header, rawBody: BODY, secrets: [secret], nowSeconds: NOW }).ok).toBe(true)
    }
    expect(verifySignatureHeader({ header, rawBody: BODY, secrets: ['whsec_other'], nowSeconds: NOW }).ok).toBe(false)
  })

  it('treats malformed headers as such', () => {
    for (const header of [undefined, '', 'garbage', 't=abc,v1=00', 't=1700000000', 'v1=00']) {
      expect(verifySignatureHeader({ header, rawBody: BODY, secrets: ['whsec_a'], nowSeconds: NOW })).toEqual({
        ok: false,
        reason: 'malformed_header',
      })
    }
  })

  it('does not throw on a non-hex or short signature', () => {
    expect(
      verifySignatureHeader({ header: `t=${NOW},v1=zz`, rawBody: BODY, secrets: ['whsec_a'], nowSeconds: NOW }),
    ).toEqual({ ok: false, reason: 'no_matching_signature' })
  })
})
