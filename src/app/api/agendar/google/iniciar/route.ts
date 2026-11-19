// GET /api/agendar/google/iniciar?pagina=<slug> — "Continuar com Google" (114).
// Signed state (slug + nonce + time) and the nonce in an HttpOnly cookie, then
// Google's consent screen. Back on /api/agendar/google/retorno.

import { NextResponse, type NextRequest } from 'next/server'

import { oauthRedirectBase, providerCredentials } from '@/lib/calendar/sync/config'
import { isValidSlug } from '@/lib/booking-page/core'
import { GOOGLE_CALLBACK_PATH, GOOGLE_NONCE_COOKIE, googleAuthUrl, newNonce, signGoogleState } from '@/lib/booking-page/google'
import { limited, pageContext, secure } from '@/lib/booking-page/route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const slug = request.nextUrl.searchParams.get('pagina') ?? ''
  if (!isValidSlug(slug)) return new NextResponse('Not found', { status: 404 })
  const over = limited(request, slug, 'google', { limit: 20, windowMs: 10 * 60_000 })
  if (over) return over
  const base = oauthRedirectBase(request.url)
  const back = (q: string) => NextResponse.redirect(`${base}/agendar/${slug}?${q}`, 303)
  const creds = providerCredentials('google')
  if (!creds) return back('erro=google')
  const ctx = await pageContext(slug)
  if (!('page' in ctx)) return ctx
  if (ctx.state !== 'ok') return back('erro=indisponivel')
  const nonce = newNonce()
  const res = NextResponse.redirect(
    googleAuthUrl({ clientId: creds.clientId, redirectUri: `${base}${GOOGLE_CALLBACK_PATH}`, state: signGoogleState({ slug, nonce }) }),
    303,
  )
  res.cookies.set(GOOGLE_NONCE_COOKIE, nonce, { httpOnly: true, sameSite: 'lax', secure: secure(), path: '/api/agendar/google', maxAge: 10 * 60 })
  return res
}
