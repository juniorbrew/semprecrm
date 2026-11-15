// POST /api/agendar/[slug]/meus/[id] {acao:'cancelar'} | {acao:'remarcar', inicio}
// Only the session's own appointment, only while the page's change window is
// open. A reschedule keeps the service and the professional.

import type { NextRequest } from 'next/server'

import { cancelForClient, rescheduleForClient } from '@/lib/booking-page/server'
import { errorResponse, json, limited, pageContext, readJson, requireOk, sessionOf, signedOut, UUID_RE } from '@/lib/booking-page/route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params
  const over = limited(request, slug, 'change', { limit: 20, windowMs: 10 * 60_000 })
  if (over) return over
  if (!UUID_RE.test(id)) return json({ error: 'Agendamento não encontrado.' }, 404)
  const body = await readJson(request)
  if (body instanceof Response) return body
  try {
    const ctx = await pageContext(slug)
    if (!('page' in ctx)) return ctx
    const blocked = requireOk(ctx)
    if (blocked) return blocked
    const session = sessionOf(request, ctx.page)
    if (!session) return signedOut()
    if (body.acao === 'cancelar') {
      await cancelForClient(ctx.db, ctx.page, session, id)
      return json({ ok: true })
    }
    if (body.acao === 'remarcar') {
      const startsAt = typeof body.inicio === 'string' ? body.inicio : ''
      if (!Number.isFinite(Date.parse(startsAt))) return json({ error: 'Pedido inválido.' }, 400)
      const res = await rescheduleForClient(ctx.db, ctx.page, session, { eventId: id, startsAt })
      if (!res.ok) return json({ error: res.message, reason: res.reason, alternatives: res.alternatives }, 409)
      return json({ ok: true, starts_at: res.appointment.starts_at })
    }
    return json({ error: 'Pedido inválido.' }, 400)
  } catch (err) {
    return errorResponse(err)
  }
}
