// POST /api/agendar/[slug]/agendar {servico, profissional|null, inicio, chave}
// Books for the signed-in customer (session cookie). The agenda re-checks
// everything and the database lock decides races; when the slot is gone the
// answer carries the next free slots.

import type { NextRequest } from 'next/server'

import { cleanName, isAcceptablePhone } from '@/lib/booking-page/core'
import { bookForClient } from '@/lib/booking-page/server'
import { normalizeTypedPhone } from '@/lib/whatsapp/phone-utils'
import { errorResponse, json, limited, pageContext, readJson, requireOk, sessionOf, signedOut, UUID_RE } from '@/lib/booking-page/route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const over = limited(request, slug, 'book', { limit: 20, windowMs: 10 * 60_000 })
  if (over) return over
  const body = await readJson(request)
  if (body instanceof Response) return body
  const serviceId = typeof body.servico === 'string' ? body.servico : ''
  const resourceId = typeof body.profissional === 'string' && body.profissional ? body.profissional : null
  const startsAt = typeof body.inicio === 'string' ? body.inicio : ''
  const key = typeof body.chave === 'string' ? body.chave : ''
  // E-mail / Google customers give name + phone on their first booking (not confirmed).
  let details: { name: string; phone: string } | null = null
  if (body.celular !== undefined) {
    const name = cleanName(body.nome)
    const phone = normalizeTypedPhone(typeof body.celular === 'string' ? body.celular.slice(0, 30) : '')
    if (name.length < 2) return json({ error: 'Informe seu nome.' }, 400)
    if (!isAcceptablePhone(phone)) return json({ error: 'Informe um celular válido com DDD.' }, 400)
    if (body.aceite !== true) return json({ error: 'É preciso aceitar o aviso de privacidade.' }, 400)
    details = { name, phone }
  }
  if (!UUID_RE.test(serviceId) || (resourceId && !UUID_RE.test(resourceId)) || !Number.isFinite(Date.parse(startsAt)) || !UUID_RE.test(key)) {
    return json({ error: 'Pedido inválido.' }, 400)
  }
  try {
    const ctx = await pageContext(slug)
    if (!('page' in ctx)) return ctx
    const blocked = requireOk(ctx)
    if (blocked) return blocked
    const session = sessionOf(request, ctx.page)
    if (!session) return signedOut()
    const res = await bookForClient(ctx.db, ctx.page, session, { serviceId, resourceId, startsAt, idempotencyKey: key, details })
    if (!res.ok) return json({ error: res.message, reason: res.reason, alternatives: res.alternatives }, 409)
    return json({ ok: true, id: res.appointment.id, starts_at: res.appointment.starts_at })
  } catch (err) {
    return errorResponse(err)
  }
}
