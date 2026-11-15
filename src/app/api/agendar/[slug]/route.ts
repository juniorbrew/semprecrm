// GET /api/agendar/[slug] — the booking page's public data (migration 114):
// name, logo, services offered (price only when the business shows it),
// professionals offered, rules, whether this device is signed in.
// Never: account id, WhatsApp number, other customers, internal notes.

import type { NextRequest } from 'next/server'

import { loadPublicPage } from '@/lib/booking-page/server'
import { errorResponse, json, limited, pageContext, sessionOf } from '@/lib/booking-page/route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const over = limited(request, slug, 'page', { limit: 60, windowMs: 60_000 })
  if (over) return over
  try {
    const ctx = await pageContext(slug)
    if (!('page' in ctx)) return ctx
    const page = await loadPublicPage(ctx.db, ctx.page, ctx.state)
    return json({ page, signed_in: !!sessionOf(request, ctx.page) })
  } catch (err) {
    return errorResponse(err)
  }
}
