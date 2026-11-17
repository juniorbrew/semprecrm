// POST /api/agendar/[slug]/email/verificar {codigo} — the code from the e-mail,
// typed on the device that asked for it (its cookie). 5 tries; single use. On
// success the session belongs to the e-mail identity (115), not to a contact.

import type { NextRequest } from 'next/server'

import { EMAIL_COOKIE, isBrowserSecret, signSession } from '@/lib/booking-page/core'
import { clearCookie, errorResponse, json, limited, pageContext, readJson, requireOk, setSessionCookie } from '@/lib/booking-page/route'
import { sessionInfo, verifyEmailCode } from '@/lib/booking-page/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const over = limited(request, slug, 'email-verify', { limit: 20, windowMs: 10 * 60_000 })
  if (over) return over
  const body = await readJson(request)
  if (body instanceof Response) return body
  const code = typeof body.codigo === 'string' ? body.codigo.replace(/\D/g, '') : ''
  const secret = request.cookies.get(EMAIL_COOKIE)?.value
  if (!isBrowserSecret(secret)) return json({ error: 'O código venceu. Peça um novo.', reason: 'expired' }, 410)
  try {
    const ctx = await pageContext(slug)
    if (!('page' in ctx)) return ctx
    const blocked = requireOk(ctx)
    if (blocked) return blocked
    const res = await verifyEmailCode(ctx.db, ctx.page, { browserSecret: secret, code })
    if (!res.ok) {
      if (res.reason === 'wrong') return json({ error: 'Código incorreto. Confira o e-mail e tente de novo.', reason: 'wrong' }, 400)
      const out = json({ error: 'O código venceu. Peça um novo.', reason: 'expired' }, 410)
      clearCookie(out, slug, EMAIL_COOKIE)
      return out
    }
    const session = { accountId: ctx.page.account_id, pageId: ctx.page.id, identityId: res.identityId }
    const info = await sessionInfo(ctx.db, { ...session, contactId: null, issuedAt: Date.now() + 1 })
    const out = json({ ok: true, session: info })
    clearCookie(out, slug, EMAIL_COOKIE)
    setSessionCookie(out, slug, signSession(session))
    return out
  } catch (err) {
    return errorResponse(err)
  }
}
