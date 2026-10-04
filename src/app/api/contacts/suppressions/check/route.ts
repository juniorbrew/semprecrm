// ============================================================
// POST /api/contacts/suppressions/check — agent+ (whoever can send a
// broadcast). Side-effect free MEMBERSHIP ORACLE for the account's
// suppression list (migration 077): it tells the caller which of the
// numbers it names are on the list. Nothing is written.
//
// Body: `{ phones: string[] }` — 1–500 digits-only numbers (a broadcast's
// would-be recipients); any malformed entry rejects the whole call (400).
// Response: `{ suppressed: string[] }`, the subset on the list, so the
// wizard's "Alcance estimado" drops the numbers the sender will block.
//
// Being an oracle, it is bounded like an admin action (30/min per user).
// It reveals no more than an agent already learns from POST
// /api/contacts/suppressions after importing a number. The list itself
// is service-role only, so the browser cannot read it directly.
// ============================================================

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { SUPPRESSION_CHECK_MAX } from '@/lib/broadcasts/audience'
import { findSuppressedPhones } from '@/lib/lgpd/suppression'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

const DIGITS_RE = /^\d{1,20}$/
/** 500 numbers × ≤23 bytes ("…",) plus the wrapper — checked before parsing. */
const MAX_BODY_BYTES = 16_384

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent')
    const limit = checkRateLimit(`contacts:suppressions:check:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const raw = await request.text()
    if (raw.length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: 'Body too large' }, { status: 413 })
    }
    let body: { phones?: unknown } | null = null
    try {
      body = JSON.parse(raw) as { phones?: unknown } | null
    } catch {
      body = null
    }
    const list: unknown[] = Array.isArray(body?.phones) ? body.phones : []
    const sized = list.length > 0 && list.length <= SUPPRESSION_CHECK_MAX
    if (!sized || !list.every((p) => typeof p === 'string' && DIGITS_RE.test(p))) {
      return NextResponse.json(
        { error: `'phones' must list 1–${SUPPRESSION_CHECK_MAX} digits-only numbers` },
        { status: 400 },
      )
    }

    const phones = [...new Set(list as string[])]
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
