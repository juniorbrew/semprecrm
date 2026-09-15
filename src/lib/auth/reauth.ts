// ============================================================
// Re-authentication probe (browser only).
//
// Supabase has no "check this password" endpoint; the only way to
// confirm the current password is `signInWithPassword`. Doing that on
// the shared browser client is not harmless: a password sign-in yields
// a fresh `aal1` session, so a user who had already completed the TOTP
// challenge (`aal2`) is silently downgraded and bounced back to `/mfa`
// by the middleware on the next navigation (see ./mfa.ts).
//
// So we sign in on a throwaway client with in-memory storage, read the
// error, and revoke that extra session right away. The shared client —
// and its `aal2` session — is never touched.
// ============================================================

import { createClient as createSupabaseJsClient } from '@supabase/supabase-js'

/** Key for the probe's (in-memory) auth storage; must not collide with the shared client. */
export const REAUTH_STORAGE_KEY = 'sb-reauth'

/**
 * Returns `true` when `password` is the current password for `email`.
 * Never mutates the shared session. Network/auth errors read as `false`.
 */
export async function verifyPassword(email: string, password: string): Promise<boolean> {
  const probe = createSupabaseJsClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        storageKey: REAUTH_STORAGE_KEY,
      },
    },
  )
  const { error } = await probe.auth.signInWithPassword({ email, password })
  if (error) return false
  // Drop the throwaway session server-side (scope local = this one only).
  await probe.auth.signOut({ scope: 'local' }).catch(() => undefined)
  return true
}
