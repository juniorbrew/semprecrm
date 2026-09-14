import { createBrowserClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SUPABASE_AUTH_COOKIE_NAME, resolveSupabasePublicUrl } from './public-url'

// Singleton instance — one client shared across the whole browser session.
// Creating multiple clients causes auth-lock contention ("Lock was released
// because another request stole it") and intermittent fetch failures.
let browserClient: SupabaseClient | undefined

export function createClient() {
  if (browserClient) return browserClient

  // `NEXT_PUBLIC_SUPABASE_URL` may be a same-origin path (`/supabase`)
  // behind the reverse proxy — resolve it against the page origin.
  browserClient = createBrowserClient(
    resolveSupabasePublicUrl(),
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    // Same cookie name as the server client / middleware (see public-url.ts).
    { cookieOptions: { name: SUPABASE_AUTH_COOKIE_NAME } }
  )

  return browserClient
}
