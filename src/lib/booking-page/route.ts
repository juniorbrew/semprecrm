// ============================================================
// Página de agendamento — shared bits of the public /api/agendar/[slug]/*
// routes: page lookup + state, session cookie, errors, rate limits.
//
// No user session anywhere: the service-role client reads only what the page
// row (slug) and the signed session (contact) scope. Cookies are HttpOnly,
// SameSite=Lax (a cross-site POST carries none) and live on the page's own
// API path, so two businesses never share one.
// ============================================================

import { NextResponse, type NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

import { isAgendaError } from '@/lib/agenda/errors'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, type RateLimitOptions } from '@/lib/rate-limit'
import { getClientIp, rateLimitIpKey } from '@/lib/request-ip'

import { CHECK_COOKIE, isValidSlug, SESSION_COOKIE, SESSION_MAX_AGE_S, verifySession, type BookingSession } from './core'
import { loadPageBySlug, pageState, type BookingPageRow, type PageState } from './server'

export interface PageContext {
  db: SupabaseClient
  page: BookingPageRow
  state: PageState
}

const NO_STORE = { 'Cache-Control': 'no-store' }

export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE })
}

export function notFound(): NextResponse {
  return json({ error: 'Página não encontrada.' }, 404)
}

/** The page by slug, or a 404 response when it does not exist / is off. */
export async function pageContext(slug: string): Promise<PageContext | NextResponse> {
  if (!isValidSlug(slug)) return notFound()
  const db = supabaseAdmin()
  const page = await loadPageBySlug(db, slug)
  const state = await pageState(db, page)
  if (!page || state === 'off') return notFound()
  return { db, page, state }
}

/** For actions that book or confirm: the page must be fully usable. */
export function requireOk(ctx: PageContext): NextResponse | null {
  if (ctx.state === 'ok') return null
  return json({ error: 'O agendamento online está indisponível no momento. Fale com a empresa.' }, 503)
}

export function cookiePath(slug: string): string {
  return `/api/agendar/${slug}`
}

const secure = () => (process.env.NEXT_PUBLIC_SITE_URL ?? '').startsWith('https://')

export function setSessionCookie(res: NextResponse, slug: string, token: string): void {
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: secure(),
    path: cookiePath(slug),
    maxAge: SESSION_MAX_AGE_S,
  })
}

export function clearCookie(res: NextResponse, slug: string, name: string): void {
  res.cookies.set(name, '', { httpOnly: true, sameSite: 'lax', secure: secure(), path: cookiePath(slug), maxAge: 0 })
}

export function setCheckCookie(res: NextResponse, slug: string, secret: string): void {
  res.cookies.set(CHECK_COOKIE, secret, {
    httpOnly: true,
    sameSite: 'lax',
    secure: secure(),
    path: cookiePath(slug),
    maxAge: 15 * 60,
  })
}

/** Signature only (no DB): the routes that act on data re-check the contact with usableContact. */
export function sessionOf(request: NextRequest, page: BookingPageRow): BookingSession | null {
  return verifySession(request.cookies.get(SESSION_COOKIE)?.value, { pageId: page.id, accountId: page.account_id })
}

export function signedOut(): NextResponse {
  return json({ error: 'Confirme seu celular para continuar.', signed_out: true }, 401)
}

/** Per IP and per page; returns the 429 response when over. */
export function limited(request: NextRequest, slug: string, name: string, perIp: RateLimitOptions, perPage?: RateLimitOptions): NextResponse | null {
  const ip = rateLimitIpKey(getClientIp(request))
  // Across every page: rotating slugs does not reset an IP's budget.
  const all = checkRateLimit(`agendar:any:ip:${ip}`, { limit: 600, windowMs: 10 * 60_000 })
  if (!all.success) return rateLimitResponse(all)
  const a = checkRateLimit(`agendar:${name}:ip:${ip}:${slug}`, perIp)
  if (!a.success) return rateLimitResponse(a)
  if (perPage) {
    const b = checkRateLimit(`agendar:${name}:page:${slug}`, perPage)
    if (!b.success) return rateLimitResponse(b)
  }
  return null
}

/** Only same-origin JSON writes (a form post from another site is refused). */
export async function readJson(request: NextRequest): Promise<Record<string, unknown> | NextResponse> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return json({ error: 'Formato inválido.' }, 415)
  }
  const origin = request.headers.get('origin')
  if (origin && origin !== request.nextUrl.origin && origin !== (process.env.NEXT_PUBLIC_SITE_URL ?? '').replace(/\/$/, '')) {
    return json({ error: 'Origem não permitida.' }, 403)
  }
  const raw = await request.text()
  if (raw.length > 4096) return json({ error: 'Pedido grande demais.' }, 413)
  try {
    const body = JSON.parse(raw)
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : json({ error: 'Formato inválido.' }, 400)
  } catch {
    return json({ error: 'Formato inválido.' }, 400)
  }
}

export function errorResponse(err: unknown): NextResponse {
  if (isAgendaError(err)) {
    const status = err.code === 'internal' ? 500 : err.status
    return json({ error: err.message, code: err.code }, status)
  }
  console.error('[agendar] failed:', err instanceof Error ? err.message : 'unknown')
  return json({ error: 'Não foi possível concluir. Tente novamente.' }, 500)
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
