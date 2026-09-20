// ============================================================
// GET /auth/callback — where every Supabase Auth e-mail link lands.
//
// Two link shapes are accepted:
//   ?token_hash=…&type=signup|recovery|invite|email_change|magiclink
//     The shape our mail templates emit (deploy/vps-all-in-one/
//     mail-templates). Verified server-side with verifyOtp, so it
//     works in any browser, not just the one that started the flow.
//   ?code=…
//     PKCE shape produced by GoTrue's default {{ .ConfirmationURL }}
//     redirect; exchanged for a session (needs the code verifier
//     cookie from the same browser).
//
// On success the session cookies are set and the user goes to `next`
// (sanitised — same-origin paths only; recovery always goes to
// /reset-password). On failure: /login?notice=link_invalid.
// ============================================================

import { NextResponse } from 'next/server'

import { loginNoticeUrl, parseOtpType, safeNextPath } from '@/lib/auth/callback'
import { createClient } from '@/lib/supabase/server'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const tokenHash = url.searchParams.get('token_hash')
  const type = parseOtpType(url.searchParams.get('type'))
  const code = url.searchParams.get('code')
  const next = safeNextPath(url.searchParams.get('next'), url.origin, type)

  const supabase = await createClient()

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash })
    if (error) {
      console.error('[auth/callback] verifyOtp failed:', error.message)
      return NextResponse.redirect(loginNoticeUrl(url.origin, 'link_invalid'))
    }
    return NextResponse.redirect(`${url.origin}${next}`)
  }

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (error) {
      console.error('[auth/callback] code exchange failed:', error.message)
      return NextResponse.redirect(loginNoticeUrl(url.origin, 'link_invalid'))
    }
    return NextResponse.redirect(`${url.origin}${next}`)
  }

  return NextResponse.redirect(loginNoticeUrl(url.origin, 'link_invalid'))
}
