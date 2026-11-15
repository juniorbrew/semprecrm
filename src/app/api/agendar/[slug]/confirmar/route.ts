// read-only: allowed (POST refuses read-only accounts via requireOk/pageState; the GET poll only consumes its own phone check)
// /api/agendar/[slug]/confirmar — the phone check (migration 113).
//
//   POST {nome, celular, aceite:true}  -> a 6-digit code + the wa.me link that
//        sends "Código de agendamento: 123456" to the business. A random
//        secret goes into an HttpOnly cookie: only this device can turn the
//        confirmation into a session.
//   GET  -> pending | expired | confirmed. On confirmed the check is consumed
//        and the session cookie (30 days) is set.
//
// Limits: per IP, per page, per typed phone (the phone key is hashed: no
// phone in memory keys or logs).

import type { NextRequest } from 'next/server'

import { CHECK_COOKIE, cleanName, hashSecret, isAcceptablePhone, isBrowserSecret, isValidSlug, newBrowserSecret, signSession } from '@/lib/booking-page/core'
import { loadPageBySlug, readPhoneCheck, startPhoneCheck } from '@/lib/booking-page/server'
import {
  clearCookie,
  errorResponse,
  json,
  limited,
  notFound,
  pageContext,
  readJson,
  requireOk,
  setCheckCookie,
  setSessionCookie,
} from '@/lib/booking-page/route'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { getClientIp, rateLimitIpKey } from '@/lib/request-ip'
import { normalizeTypedPhone } from '@/lib/whatsapp/phone-utils'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ slug: string }> }

export async function POST(request: NextRequest, { params }: Ctx) {
  const { slug } = await params
  const over = limited(request, slug, 'check', { limit: 5, windowMs: 10 * 60_000 }, { limit: 120, windowMs: 10 * 60_000 })
  if (over) return over
  const body = await readJson(request)
  if (body instanceof Response) return body
  const name = cleanName(body.nome)
  const phone = normalizeTypedPhone(typeof body.celular === 'string' ? body.celular.slice(0, 30) : '')
  if (name.length < 2) return json({ error: 'Informe seu nome.' }, 400)
  if (!isAcceptablePhone(phone)) return json({ error: 'Informe um celular válido com DDD.' }, 400)
  if (body.aceite !== true) return json({ error: 'É preciso aceitar o aviso de privacidade.' }, 400)
  // Phone + IP: a stranger typing someone's number cannot lock that person out.
  const ip = rateLimitIpKey(getClientIp(request))
  const perPhone = checkRateLimit(`agendar:check:phone:${hashSecret(`${slug}:${phone}:${ip}`).slice(0, 32)}`, {
    limit: 5,
    windowMs: 60 * 60_000,
  })
  if (!perPhone.success) return rateLimitResponse(perPhone)
  try {
    const ctx = await pageContext(slug)
    if (!('page' in ctx)) return ctx
    const blocked = requireOk(ctx)
    if (blocked) return blocked
    const secret = newBrowserSecret()
    const res = await startPhoneCheck(ctx.db, ctx.page, { name, phone, browserSecret: secret })
    if (!res.ok) {
      return res.reason === 'too_many'
        ? json({ error: 'Muitos pedidos para este celular. Aguarde alguns minutos.' }, 429)
        : json({ error: 'O agendamento online está indisponível no momento. Fale com a empresa.' }, 503)
    }
    const out = json({ whatsapp_url: res.whatsappUrl, code: res.code, expires_at: res.expiresAt })
    setCheckCookie(out, slug, secret)
    return out
  } catch (err) {
    return errorResponse(err)
  }
}

export async function GET(request: NextRequest, { params }: Ctx) {
  const { slug } = await params
  // The page polls every 3-5 s for up to 11 min; several phones behind one carrier IP.
  const over = limited(request, slug, 'check-status', { limit: 600, windowMs: 10 * 60_000 })
  if (over) return over
  const secret = request.cookies.get(CHECK_COOKIE)?.value
  if (!isBrowserSecret(secret)) return json({ status: 'expired' })
  try {
    // Light on purpose (polled): the page row only; the check itself proves the rest.
    if (!isValidSlug(slug)) return notFound()
    const db = supabaseAdmin()
    const page = await loadPageBySlug(db, slug)
    if (!page || !page.enabled) return notFound()
    const ctx = { db, page }
    const status = await readPhoneCheck(ctx.db, ctx.page, secret)
    if (status.status === 'pending') return json({ status: 'pending' })
    const out = json({ status: status.status })
    clearCookie(out, slug, CHECK_COOKIE)
    if (status.status === 'confirmed') {
      setSessionCookie(out, slug, signSession({ accountId: ctx.page.account_id, pageId: ctx.page.id, contactId: status.contactId }))
    }
    return out
  } catch (err) {
    return errorResponse(err)
  }
}
