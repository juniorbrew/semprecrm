// GET    /api/agendar/[slug]/meus — the signed-in customer's upcoming appointments.
// DELETE /api/agendar/[slug]/meus — sign out on EVERY device of this customer
//        (a copied or relayed session stops working too).

import type { NextRequest } from 'next/server'

import { SESSION_COOKIE } from '@/lib/booking-page/core'
import { listMine, revokeSessions } from '@/lib/booking-page/server'
import { clearCookie, errorResponse, json, limited, pageContext, sessionOf, signedOut } from '@/lib/booking-page/route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ slug: string }> }

export async function GET(request: NextRequest, { params }: Ctx) {
  const { slug } = await params
  const over = limited(request, slug, 'mine', { limit: 60, windowMs: 60_000 })
  if (over) return over
  try {
    const ctx = await pageContext(slug)
    if (!('page' in ctx)) return ctx
    const session = sessionOf(request, ctx.page)
    if (!session) return signedOut()
    return json({ appointments: await listMine(ctx.db, ctx.page, session) })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function DELETE(request: NextRequest, { params }: Ctx) {
  const { slug } = await params
  const over = limited(request, slug, 'signout', { limit: 20, windowMs: 10 * 60_000 })
  if (over) return over
  try {
    const ctx = await pageContext(slug)
    if (!('page' in ctx)) return ctx
    const session = sessionOf(request, ctx.page)
    if (session) await revokeSessions(ctx.db, session)
    const out = json({ ok: true })
    clearCookie(out, slug, SESSION_COOKIE)
    return out
  } catch (err) {
    return errorResponse(err)
  }
}
