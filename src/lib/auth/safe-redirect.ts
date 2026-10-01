/**
 * Reduce an untrusted redirect target to a same-origin path, or null.
 *
 * Browsers and `new URL` silently drop tab / CR / LF and treat `\` as
 * `/`, so `/\t/evil.com` or `/\evil.com` pass a naive "starts with a
 * single slash" check and still resolve to `//evil.com`. We therefore
 * reject any whitespace, control character or backslash outright, and
 * then require the resolved URL to keep the base origin. The returned
 * value is the *normalized* path (dot segments resolved), i.e. exactly
 * what the browser will navigate to.
 */
const BASE = 'http://same-origin.invalid'

// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\s\u0000-\u001f\u007f-\u009f\\]/

export function sameOriginPath(raw: unknown, origin: string = BASE): string | null {
  if (typeof raw !== 'string' || !raw) return null
  if (FORBIDDEN.test(raw)) return null
  if (!raw.startsWith('/') || raw.startsWith('//')) return null
  let url: URL
  try {
    url = new URL(raw, origin)
  } catch {
    return null
  }
  if (url.origin !== new URL(origin).origin) return null
  return url.pathname + url.search + url.hash
}
