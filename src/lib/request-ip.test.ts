import { describe, expect, it } from 'vitest'

import { getClientIp, UNKNOWN_IP } from './request-ip'

function req(headers: Record<string, string>) {
  return new Request('https://example.test/', { headers })
}

describe('getClientIp', () => {
  it('prefers x-real-ip (set by nginx to $remote_addr)', () => {
    expect(
      getClientIp(req({ 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '1.1.1.1, 203.0.113.9' })),
    ).toBe('203.0.113.9')
  })

  it('uses the RIGHTMOST x-forwarded-for entry, ignoring client-supplied ones', () => {
    expect(getClientIp(req({ 'x-forwarded-for': '6.6.6.6, 7.7.7.7, 198.51.100.4' }))).toBe(
      '198.51.100.4',
    )
  })

  it('rotating the client-supplied prefix does not change the key', () => {
    const a = getClientIp(req({ 'x-forwarded-for': '1.2.3.4, 198.51.100.4' }))
    const b = getClientIp(req({ 'x-forwarded-for': '5.6.7.8, 198.51.100.4' }))
    expect(a).toBe(b)
  })

  it('keys IPv6 by its /64 so a client cannot rotate within its prefix', () => {
    expect(getClientIp(req({ 'x-real-ip': '2001:db8::1' }))).toBe('2001:db8:0:0::/64')
    expect(getClientIp(req({ 'x-real-ip': '2001:db8:0:0:ffff:1:2:3' }))).toBe('2001:db8:0:0::/64')
    expect(getClientIp(req({ 'x-real-ip': '2001:DB8:AB:CD:1::' }))).toBe('2001:db8:ab:cd::/64')
    expect(getClientIp(req({ 'x-forwarded-for': '1.1.1.1, fe80::1%eth0' }))).toBe('fe80:0:0:0::/64')
    expect(getClientIp(req({ 'x-real-ip': '::1' }))).toBe('0:0:0:0::/64')
  })

  it('collapses IPv4-mapped IPv6 to the IPv4', () => {
    expect(getClientIp(req({ 'x-real-ip': '::ffff:203.0.113.9' }))).toBe('203.0.113.9')
  })

  it('collapses non-IP values to a constant', () => {
    expect(getClientIp(req({ 'x-real-ip': 'evil' }))).toBe(UNKNOWN_IP)
    expect(getClientIp(req({ 'x-forwarded-for': '1.1.1.1, ' + 'a'.repeat(500) }))).toBe(UNKNOWN_IP)
  })

  it('falls back to a constant with no headers', () => {
    expect(getClientIp(req({}))).toBe(UNKNOWN_IP)
  })
})
