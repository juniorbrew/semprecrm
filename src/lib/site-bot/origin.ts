// ============================================================
// Which websites may run a bot. Pure.
//
// A bot lists hostnames (`minhaloja.com.br`). A request is allowed when
// its Origin is https and its host is that hostname or its `www.`
// variant. `http` is only accepted for a bot that lists `localhost`
// explicitly (local development), any port. Everything else, including
// a missing or `null` Origin, is refused.
// ============================================================

export function originAllowed(origin: string | null | undefined, domains: readonly string[]): boolean {
  if (!origin || domains.length === 0) return false
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  // An Origin is scheme + host (+ port) only.
  if (url.origin !== origin.toLowerCase()) return false
  const host = url.hostname.toLowerCase()
  if (url.protocol === 'http:') return host === 'localhost' && domains.includes('localhost')
  if (url.protocol !== 'https:') return false
  return domains.some((d) => host === d || host === `www.${d}`)
}

/** CORS headers for an allowed origin (echoed, never `*`). */
export function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  }
}
