import { describe, expect, it } from 'vitest'

import { ipInCidrs, normalizeCidr, parseCidrList } from './cidr'

describe('cidr', () => {
  it('normalizes single addresses and ranges, rejects junk', () => {
    expect(normalizeCidr('203.0.113.7')).toBe('203.0.113.7/32')
    expect(normalizeCidr('203.0.113.0/24')).toBe('203.0.113.0/24')
    expect(normalizeCidr('2001:db8::/32')).toBe('2001:db8::/32')
    expect(normalizeCidr('2001:db8::1')).toBe('2001:db8::1/128')
    for (const bad of ['', 'abc', '1.2.3.4/33', '1.2.3.4/', '1.2.3/24', '1.2.3.4/24/1', '::1/129', '999.1.1.1']) {
      expect(normalizeCidr(bad)).toBeNull()
    }
  })

  it('parses lists from arrays and text, dedupes, caps at 10', () => {
    expect(parseCidrList('203.0.113.7, 198.51.100.0/24\n203.0.113.7')).toEqual(['203.0.113.7/32', '198.51.100.0/24'])
    expect(parseCidrList('')).toEqual([])
    expect(parseCidrList(undefined)).toEqual([])
    expect(parseCidrList(['1.1.1.1', 5])).toBeNull()
    expect(parseCidrList('1.1.1.1, nope')).toBeNull()
    expect(parseCidrList(Array.from({ length: 11 }, (_, i) => `10.0.0.${i + 1}`))).toBeNull()
    expect(parseCidrList(12)).toBeNull()
  })

  it('matches addresses against ranges, IPv4-mapped IPv6 included', () => {
    const list = ['203.0.113.0/24', '2001:db8::/32']
    expect(ipInCidrs('203.0.113.99', list)).toBe(true)
    expect(ipInCidrs('203.0.114.1', list)).toBe(false)
    expect(ipInCidrs('::ffff:203.0.113.5', list)).toBe(true)
    expect(ipInCidrs('2001:db8:abcd::1', list)).toBe(true)
    expect(ipInCidrs('2001:db9::1', list)).toBe(false)
    expect(ipInCidrs('not an ip', list)).toBe(false)
    expect(ipInCidrs('203.0.113.5', [])).toBe(false)
  })
})
