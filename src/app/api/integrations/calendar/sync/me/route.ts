// ============================================================
// POST /api/integrations/calendar/sync/me — "Sincronizar agora" for
// the session user: every non-revoked connection they own.
//
// `?ifStale=1` only syncs connections not refreshed in the last
// 2 minutes — what /agenda calls on open so the page stays cheap.
// ============================================================

import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { getCurrentAccount, requireModule, toErrorResponse } from '@/lib/auth/account'
import { syncUserConnections } from '@/lib/calendar/sync/engine'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

/** /agenda re-syncs on open only past this age. */
const STALE_AFTER_MS = 2 * 60_000

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    await requireModule(ctx, 'calendar')
    const ifStale = new URL(request.url).searchParams.get('ifStale') === '1'
    if (!ifStale) {
      const limit = checkRateLimit(`calendar:sync:${ctx.userId}`, RATE_LIMITS.adminAction)
      if (!limit.success) return rateLimitResponse(limit)
    }
    const result = await syncUserConnections({
      admin: supabaseAdmin(),
      userId: ctx.userId,
      staleAfterMs: ifStale ? STALE_AFTER_MS : undefined,
    })
    return NextResponse.json(result)
  } catch (err) {
    return toErrorResponse(err)
  }
}
