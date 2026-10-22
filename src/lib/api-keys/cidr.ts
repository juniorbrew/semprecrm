import { BlockList, isIP } from 'node:net'

export const MAX_CIDRS = 10

/** "203.0.113.7", "203.0.113.0/24", "2001:db8::/32" -> normalized entry, or null when invalid. */
export function normalizeCidr(raw: string): string | null {
  const [addr, bits, extra] = raw.trim().split('/')
  if (extra !== undefined) return null
  const family = isIP(addr)
  if (!family) return null
  const max = family === 4 ? 32 : 128
  if (bits === undefined) return `${addr}/${max}`
  if (!/^\d{1,3}$/.test(bits) || Number(bits) > max) return null
  return `${addr}/${Number(bits)}`
}

/** Parses a user-supplied list (array or newline/comma separated text). Null when any entry is invalid or there are too many. */
export function parseCidrList(input: unknown): string[] | null {
  const items = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(/[\n,;\s]+/)
      : input == null
        ? []
        : null
  if (!items) return null
  const out = new Set<string>()
  for (const item of items) {
    if (typeof item !== 'string') return null
    if (item.trim() === '') continue
    const n = normalizeCidr(item)
    if (!n) return null
    out.add(n)
  }
  return out.size > MAX_CIDRS ? null : [...out]
}

/** True when `ip` falls inside any entry. IPv4-mapped IPv6 (::ffff:a.b.c.d) counts as the IPv4. */
export function ipInCidrs(ip: string, cidrs: readonly string[]): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  const addr = mapped ? mapped[1] : ip.split('%')[0]
  const family = isIP(addr)
  if (!family) return false
  const list = new BlockList()
  for (const c of cidrs) {
    const [a, bits] = c.split('/')
    const f = isIP(a)
    if (f) list.addSubnet(a, Number(bits), f === 4 ? 'ipv4' : 'ipv6')
  }
  return list.check(addr, family === 4 ? 'ipv4' : 'ipv6')
}
