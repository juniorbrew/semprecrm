// ============================================================
// POST /api/contacts/suppressions/check — agent+ (whoever can send a
// broadcast). Read-only.
//
// Body: `{ phones: string[] }` — digits-only numbers of a broadcast's
// would-be recipients. Response: `{ suppressed: string[] }`, the subset on
// the account's suppression list (migration 077), so the wizard's
// "Alcance estimado" drops the numbers the sender will block. The list is
// service-role only, so the browser cannot read it itself; this answers
// no more than POST /api/contacts/suppressions already does for an agent.
// ============================================================

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { SUPPRESSION_CHECK_MAX } from '@/lib/broadcasts/audience'
import { findSuppressedPhones } from '@/lib/lgpd/suppression'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

const DIGITS_RE = /^\d{1,20}$/

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent')
    const limit = checkRateLimit(`contacts:suppressions:check:${ctx.userId}`, RATE_LIMITS.broadcast)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as { phones?: unknown } | null
    const phones = Array.isArray(body?.phones)
      ? [...new Set(body.phones.filter((p): p is string => typeof p === 'string' && DIGITS_RE.test(p)))]
      : []
    if (phones.length === 0 || phones.length > SUPPRESSION_CHECK_MAX) {
      return NextResponse.json({ error: `'phones' must list 1–${SUPPRESSION_CHECK_MAX} numbers` }, { status: 400 })
    }

    const suppressed = await findSuppressedPhones(supabaseAdmin(), ctx.accountId, phones)
    return NextResponse.json({ suppressed: [...suppressed] })
  } catch (err) {
    if (err instanceof Error && !('status' in err)) {
      console.error('[POST /api/contacts/suppressions/check] failed:', err.message)
      return NextResponse.json({ error: 'Suppression check failed' }, { status: 500 })
    }
    return toErrorResponse(err)
  }
}
