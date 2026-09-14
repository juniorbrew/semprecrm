/**
 * Supabase URL as seen from the BROWSER.
 *
 * `NEXT_PUBLIC_SUPABASE_URL` is normally absolute
 * (`http://192.168.1.10:56021`, `https://xyz.supabase.co`). When the app
 * sits behind a reverse proxy that forwards `/supabase/*` to Supabase
 * (WebSocket included), the variable may instead be a PATH such as
 * `/supabase`; the browser then reaches Supabase through the app's own
 * origin, so the same build works from localhost, a LAN IP or a VPN
 * address without exposing a separate Supabase port.
 *
 * This module is client-safe (no server-only imports). Server code must
 * use `supabaseServerUrl()` from `./url` instead.
 */

/** `true` when the configured value is a same-origin path (`/supabase`). */
export function isRelativeSupabaseUrl(raw: string | undefined): raw is string {
  return typeof raw === 'string' && raw.startsWith('/')
}

/**
 * Resolve the URL the browser Supabase client should talk to.
 *
 * - `/supabase`  → `${window.location.origin}/supabase` (trailing slashes trimmed)
 * - anything else → returned unchanged
 *
 * Outside the browser (SSR / static prerender of client components that
 * instantiate the browser client during render) there is no origin to
 * prepend, so a placeholder absolute URL is returned: those renders never
 * issue requests, and the real browser re-creates the client with the
 * page's origin. Server code must use `supabaseServerUrl()` instead.
 */
export function resolveSupabasePublicUrl(
  raw: string | undefined = process.env.NEXT_PUBLIC_SUPABASE_URL,
): string {
  if (!isRelativeSupabaseUrl(raw)) return raw!
  const path = raw.replace(/\/+$/, '')
  if (typeof window === 'undefined' || !window.location?.origin) {
    return `http://ssr-placeholder.invalid${path}`
  }
  return `${window.location.origin}${path}`
}

/**
 * Name of the auth cookie shared by the browser client, the server client
 * and the middleware. @supabase/ssr derives its default from the Supabase
 * URL's hostname, which differs between the browser (`localhost`, a LAN IP,
 * a same-origin proxy path) and the server (`host.docker.internal`, Kong…)
 * — a mismatch means the server never sees the session. Pinning the name
 * makes the three agree regardless of how each side reaches Supabase.
 */
export const SUPABASE_AUTH_COOKIE_NAME = 'sb-semprecrm-auth-token'
