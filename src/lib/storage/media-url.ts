/**
 * Media URL helpers for the same-origin Supabase setup.
 *
 * When `NEXT_PUBLIC_SUPABASE_URL` is a path (`/supabase`, proxied by nginx
 * in front of the app) the browser's `getPublicUrl()` yields
 * `http://<whatever origin the user opened>/supabase/storage/v1/object/public/...`.
 * Persisting that would pin the row to one hostname (localhost vs LAN IP vs
 * VPN), so we store the ORIGIN-RELATIVE path instead and re-absolutise it
 * only where an absolute URL is unavoidable:
 *
 *   - `toStoredMediaUrl`   browser, right after `getPublicUrl()` → what goes in the DB
 *   - `mediaUrlForServer`  server code that must FETCH the bytes (or hand the
 *                          URL to the WhatsApp gateway, which fetches them)
 *   - `mediaUrlForPublic`  links handed to third parties (Meta Cloud API
 *                          `link` fields, web-push icons)
 *
 * `<img src>`, `<audio src>` and `<a href>` resolve relative paths natively,
 * so renderers need no help. All three helpers are no-ops for absolute URLs
 * (Meta CDN links, pre-existing rows, external logos).
 *
 * Client-safe: only `NEXT_PUBLIC_*` variables are read in the browser;
 * `SUPABASE_INTERNAL_URL` is only meaningful on the server.
 */

import { isRelativeSupabaseUrl } from '@/lib/supabase/public-url'

export interface MediaUrlEnv {
  NEXT_PUBLIC_SUPABASE_URL?: string
  SUPABASE_INTERNAL_URL?: string
  NEXT_PUBLIC_SITE_URL?: string
}

/**
 * `process.env` is typed as `ProcessEnv` (an index signature) which TS
 * refuses to assign to a bag of optional named keys. In the browser Next
 * inlines each `process.env.NEXT_PUBLIC_*` access individually, so the
 * keys are read one by one rather than spreading the object.
 */
function defaultEnv(): MediaUrlEnv {
  return {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_INTERNAL_URL: process.env.SUPABASE_INTERNAL_URL,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
  }
}

function trimSlashes(value: string): string {
  return value.replace(/\/+$/, '')
}

/** A single leading slash — not `//host` (protocol-relative) and not a scheme. */
export function isRelativeMediaUrl(url: string | null | undefined): url is string {
  return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//')
}

/**
 * Normalise a URL produced by the browser Supabase client for storage in
 * the database. When the URL points at the page's own origin (the
 * same-origin proxy case) only the path is kept:
 *
 *   http://192.168.1.10:3101/supabase/storage/v1/object/public/chat-media/x.png
 *   → /supabase/storage/v1/object/public/chat-media/x.png
 *
 * Anything else (absolute Supabase host, foreign URL) is returned as is.
 * Safe to call on the server: without a `window` it is a no-op.
 */
export function toStoredMediaUrl(url: string, origin?: string): string {
  const base =
    origin ?? (typeof window !== 'undefined' ? window.location?.origin : undefined)
  if (!base || !url) return url
  const o = trimSlashes(base)
  if (url === o) return '/'
  if (url.startsWith(o + '/')) return url.slice(o.length)
  return url
}

/**
 * Absolute URL server code can FETCH for a stored media URL.
 *
 *   /supabase/storage/...   → SUPABASE_INTERNAL_URL + /storage/...   (same-origin proxy prefix)
 *   /other/relative/path    → NEXT_PUBLIC_SITE_URL + /other/relative/path
 *   https://anything        → unchanged
 *
 * The first branch skips nginx entirely: the server talks to Supabase
 * directly through the internal route. Falls back to `NEXT_PUBLIC_SITE_URL`
 * (the proxy) when `SUPABASE_INTERNAL_URL` is unset, and throws when
 * neither is configured — a relative URL is useless to `fetch()`.
 */
export function mediaUrlForServer(url: string, env: MediaUrlEnv = defaultEnv()): string {
  if (!isRelativeMediaUrl(url)) return url

  const publicPrefix = isRelativeSupabaseUrl(env.NEXT_PUBLIC_SUPABASE_URL)
    ? trimSlashes(env.NEXT_PUBLIC_SUPABASE_URL)
    : null
  const internal = env.SUPABASE_INTERNAL_URL?.trim()
  if (publicPrefix && internal && (url === publicPrefix || url.startsWith(publicPrefix + '/'))) {
    return trimSlashes(internal) + url.slice(publicPrefix.length)
  }

  const site = env.NEXT_PUBLIC_SITE_URL?.trim()
  if (site) return trimSlashes(site) + url

  throw new Error(
    `Cannot resolve relative media URL "${url}" on the server: set SUPABASE_INTERNAL_URL (for ${publicPrefix ?? '/supabase'}/* paths) or NEXT_PUBLIC_SITE_URL.`,
  )
}

/**
 * Absolute URL for links handed to third parties that fetch them from the
 * outside (Meta Cloud API `link`, push-notification icons):
 *
 *   /supabase/storage/...  → NEXT_PUBLIC_SITE_URL + /supabase/storage/...
 *   https://anything       → unchanged
 *
 * In the browser (template preview, etc.) `window.location.origin` stands
 * in when `NEXT_PUBLIC_SITE_URL` is unset. On the server with no site URL
 * the path is returned unchanged rather than throwing — Meta will reject
 * it with a clear "link" error and, more importantly, an unrelated caller
 * (a text-only send) is never blocked by media config.
 */
export function mediaUrlForPublic(url: string, env: MediaUrlEnv = defaultEnv()): string {
  if (!isRelativeMediaUrl(url)) return url
  const site =
    env.NEXT_PUBLIC_SITE_URL?.trim() ||
    (typeof window !== 'undefined' ? window.location?.origin : undefined)
  if (!site) return url
  return trimSlashes(site) + url
}
