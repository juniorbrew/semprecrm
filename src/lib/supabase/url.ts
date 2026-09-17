import { isRelativeSupabaseUrl } from './public-url'

/**
 * Supabase URL as seen from the SERVER (route handlers, middleware, admin
 * clients). Browsers always use `NEXT_PUBLIC_SUPABASE_URL` (resolved by
 * `resolveSupabasePublicUrl()` — it may be a same-origin path such as
 * `/supabase` when a reverse proxy fronts Supabase); when the app runs in
 * a container the same address may not be routable from inside (e.g. the
 * host's LAN IP on Docker Desktop), so `SUPABASE_INTERNAL_URL` lets the
 * server reach Supabase through another route
 * (`http://host.docker.internal:56021`, or Kong's service name on a VPS).
 *
 * Server code never builds public storage URLs from this client, so the
 * internal host never leaks into stored data.
 */
export interface SupabaseServerUrlEnv {
  SUPABASE_INTERNAL_URL?: string
  NEXT_PUBLIC_SUPABASE_URL?: string
}

export function supabaseServerUrl(
  env: SupabaseServerUrlEnv = {
    SUPABASE_INTERNAL_URL: process.env.SUPABASE_INTERNAL_URL,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  },
): string {
  const internal = env.SUPABASE_INTERNAL_URL?.trim().replace(/\/+$/, '')
  if (internal) return internal
  const pub = env.NEXT_PUBLIC_SUPABASE_URL
  if (isRelativeSupabaseUrl(pub)) {
    throw new Error(
      `NEXT_PUBLIC_SUPABASE_URL is a relative path ("${pub}") that only the browser can resolve. ` +
        'Set SUPABASE_INTERNAL_URL to the absolute Supabase URL the server can reach (e.g. http://host.docker.internal:56021).',
    )
  }
  return pub!
}

export { SUPABASE_AUTH_COOKIE_NAME } from './public-url'
