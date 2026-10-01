import { isIP } from 'node:net'

/**
 * Client IP for rate-limit keys.
 *
 * nginx (deploy/contabo, deploy/vps-all-in-one) sets `X-Real-IP` to
 * `$remote_addr` and *appends* `$remote_addr` to whatever
 * `X-Forwarded-For` the client sent. So the only trustworthy values
 * are `x-real-ip` and the RIGHTMOST forwarded-for entry; the leftmost
 * entry is attacker-controlled and rotating it used to reset every
 * per-IP limit.
 *
 * Anything that does not parse as an IP collapses to a constant, so a
 * garbage header can't mint fresh buckets either. With no proxy in
 * front (local dev) every caller shares the "unknown" bucket, which is
 * fine for dev.
 *
 * IPv6 clients are keyed by their /64: one subscriber usually owns a
 * whole /64, so per-address keys would let them rotate addresses
 * freely. IPv4-mapped IPv6 (::ffff:a.b.c.d) collapses to the IPv4.
 */
export const UNKNOWN_IP = 'unknown'

export function getClientIp(request: Request): string {
  const realIp = request.headers.get('x-real-ip')?.trim()
  if (realIp) return rateLimitIpKey(realIp)

  const xff = request.headers.get('x-forwarded-for')
  if (xff) return rateLimitIpKey(xff.split(',').pop()?.trim() ?? '')
  return UNKNOWN_IP
}

/** IPv4 as-is, IPv6 as its /64 prefix, anything else the constant. */
export function rateLimitIpKey(raw: string): string {
  const ip = raw.split('%')[0] // drop an IPv6 zone id
  const kind = isIP(ip)
  if (kind === 4) return ip
  if (kind !== 6) return UNKNOWN_IP
  const lower = ip.toLowerCase()
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
  if (mapped) return mapped[1]
  const [head, tail] = lower.includes('::') ? lower.split('::') : [lower, null]
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  // An embedded dotted IPv4 tail occupies two 16-bit groups.
  const tailGroups = t.reduce((n, g) => n + (g.includes('.') ? 2 : 1), 0)
  const groups = tail === null ? h : [...h, ...Array(8 - h.length - tailGroups).fill('0'), ...t]
  return groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':') + '::/64'
}
