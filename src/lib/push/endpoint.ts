/**
 * Web Push endpoints are POSTed to by the server (web-push), so an
 * arbitrary URL would be a blind SSRF. Only the browser vendors' push
 * services are accepted:
 *
 *   Chrome / Edge (Chromium) / Opera / Samsung  fcm.googleapis.com
 *     (very old Chrome subscriptions: android.googleapis.com)
 *   Firefox                                     updates.push.services.mozilla.com
 *   Safari (macOS 13+, iOS 16.4+)               web.push.apple.com, *.push.apple.com
 *   Legacy Edge / Windows (WNS)                 *.notify.windows.com
 *
 * Hostnames only — IP literals, custom ports and credentials never
 * match, which also rules out private / reserved addresses.
 */
const EXACT_HOSTS = new Set([
  'fcm.googleapis.com',
  'android.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
])
const HOST_SUFFIXES = ['.push.apple.com', '.notify.windows.com']

export const PUSH_ENDPOINT_MAX = 2048

export function isAllowedPushEndpoint(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > PUSH_ENDPOINT_MAX) return false
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return false
  const host = url.hostname.toLowerCase()
  return EXACT_HOSTS.has(host) || HOST_SUFFIXES.some((s) => host.endsWith(s))
}
