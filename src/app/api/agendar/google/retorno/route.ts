// GET /api/agendar/google/retorno — Google's answer to "Continuar com Google" (115).
// State signature + age + nonce cookie (single use: cleared here) → code →
// userinfo (verified e-mail only) → e-mail/Google identity of THIS page's
// account → session cookie on the page's API path → back to the page.

import { NextResponse, type NextRequest } from 'next/server'

import { oauthRedirectBase } from '@/lib/calendar/sync/config'
import { signSession } from '@/lib/booking-page/core'
import { GOOGLE_CALLBACK_PATH, GOOGLE_NONCE_COOKIE, googleUser, verifyGoogleState } from '@/lib/booking-page/google'
import { limited, pageContext, secure, setSessionCookie } from '@/lib/booking-page/route'
import { upsertIdentity } from '@/lib/booking-page/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const base = oauthRedirectBase(request.url)
  const q = request.nextUrl.searchParams
  const slug = verifyGoogleState(q.get('state'), request.cookies.get(GOOGLE_NONCE_COOKIE)?.value)
  const done = (target: string) => {
    const res = NextResponse.redirect(`${base}${target}`, 303)
    res.cookies.set(GOOGLE_NONCE_COOKIE, '', { httpOnly: true, sameSite: 'lax', secure: secure(), path: '/api/agendar/google', maxAge: 0 })
    return res
  }
  if (!slug) return done('/')
  const over = limited(request, slug, 'google', { limit: 20, windowMs: 10 * 60_000 })
  if (over) return over
  const code = q.get('code')
  if (q.get('error') || !code) return done(`/agendar/${slug}?erro=google`)
  try {
    const ctx = await pageContext(slug)
    if (!('page' in ctx)) return done('/')
    if (ctx.state !== 'ok') return done(`/agendar/${slug}?erro=indisponivel`)
    const user = await googleUser({ code, redirectUri: `${base}${GOOGLE_CALLBACK_PATH}` })
    if (!user) return done(`/agendar/${slug}?erro=google`)
    const identityId = await upsertIdentity(ctx.db, {
      accountId: ctx.page.account_id,
      kind: 'google',
      subject: user.sub,
      email: user.email,
      name: user.name,
    })
    const res = done(`/agendar/${slug}?entrou=google`)
    setSessionCookie(res, slug, signSession({ accountId: ctx.page.account_id, pageId: ctx.page.id, identityId }))
    return res
  } catch (err) {
    console.error('[agendar-google] failed:', err instanceof Error ? err.message : 'unknown')
    return done(`/agendar/${slug}?erro=google`)
  }
}
