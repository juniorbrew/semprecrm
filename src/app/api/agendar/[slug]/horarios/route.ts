// GET /api/agendar/[slug]/horarios?servico=&profissional=&de=YYYY-MM-DD
// Free slots for 7 days (agenda rules + the page's own). A slot says only
// when and which offered professionals are free — never who holds the rest.

import type { NextRequest } from 'next/server'

import { pageSlots } from '@/lib/booking-page/server'
import { DATE_RE, errorResponse, json, limited, pageContext, requireOk, UUID_RE } from '@/lib/booking-page/route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const over = limited(request, slug, 'slots', { limit: 60, windowMs: 60_000 }, { limit: 1200, windowMs: 60_000 })
  if (over) return over
  const q = request.nextUrl.searchParams
  const serviceId = q.get('servico') ?? ''
  const resourceId = q.get('profissional') || null
  const from = q.get('de') ?? ''
  if (!UUID_RE.test(serviceId) || (resourceId && !UUID_RE.test(resourceId)) || !DATE_RE.test(from)) {
    return json({ error: 'Pedido inválido.' }, 400)
  }
  try {
    const ctx = await pageContext(slug)
    if (!('page' in ctx)) return ctx
    const blocked = requireOk(ctx)
    if (blocked) return blocked
    const { timezone, slots } = await pageSlots(ctx.db, ctx.page, { serviceId, resourceId, from })
    return json({ timezone, slots })
  } catch (err) {
    return errorResponse(err)
  }
}
