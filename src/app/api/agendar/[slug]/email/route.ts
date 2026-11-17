// POST /api/agendar/[slug]/email {email} — sends a 6-digit code to sign in (115).
// A random secret goes into an HttpOnly cookie: only this device can use the code.
// Limits per IP, per page and per e-mail+IP (each request is an e-mail out).

import type { NextRequest } from 'next/server'

import { EMAIL_COOKIE, hashSecret, newBrowserSecret, normalizeEmail } from '@/lib/booking-page/core'
import { errorResponse, json, limited, pageContext, readJson, requireOk, setCheckCookie } from '@/lib/booking-page/route'
import { loadPublicPage, startEmailCode } from '@/lib/booking-page/server'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { getClientIp, rateLimitIpKey } from '@/lib/request-ip'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const over = limited(request, slug, 'email', { limit: 5, windowMs: 10 * 60_000 }, { limit: 100, windowMs: 10 * 60_000 })
  if (over) return over
  const body = await readJson(request)
  if (body instanceof Response) return body
  const email = normalizeEmail(body.email)
  if (!email) return json({ error: 'Informe um e-mail válido.' }, 400)
  const ip = rateLimitIpKey(getClientIp(request))
  const perEmail = checkRateLimit(`agendar:email:${hashSecret(`${slug}:${email}:${ip}`).slice(0, 32)}`, { limit: 3, windowMs: 60 * 60_000 })
  if (!perEmail.success) return rateLimitResponse(perEmail)
  try {
    const ctx = await pageContext(slug)
    if (!('page' in ctx)) return ctx
    const blocked = requireOk(ctx)
    if (blocked) return blocked
    const pub = await loadPublicPage(ctx.db, ctx.page, ctx.state)
    const secret = newBrowserSecret()
    const res = await startEmailCode(ctx.db, ctx.page, { email, browserSecret: secret, businessName: pub.name })
    if (!res.ok) {
      if (res.reason === 'too_many') return json({ error: 'Muitos códigos pedidos para este e-mail. Aguarde alguns minutos.' }, 429)
      if (res.reason === 'mail_off') return json({ error: 'Entrar com e-mail não está disponível agora.' }, 503)
      return json({ error: 'Não conseguimos enviar o e-mail. Confira o endereço e tente de novo.' }, 502)
    }
    const out = json({ ok: true })
    setCheckCookie(out, slug, secret, EMAIL_COOKIE)
    return out
  } catch (err) {
    return errorResponse(err)
  }
}
