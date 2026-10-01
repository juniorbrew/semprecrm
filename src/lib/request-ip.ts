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
 */
export const UNKNOWN_IP = 'unknown'

export function getClientIp(request: Request): string {
  const realIp = request.headers.get('x-real-ip')?.trim()
  if (realIp) return isIP(realIp) ? realIp : UNKNOWN_IP

  const xff = request.headers.get('x-forwarded-for')
  if (xff) {
    const last = xff.split(',').pop()?.trim() ?? ''
    return isIP(last) ? last : UNKNOWN_IP
  }
  return UNKNOWN_IP
}
