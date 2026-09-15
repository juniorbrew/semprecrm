// ============================================================
// POST /api/push/seen — "I am looking at this conversation".
//
// Body: { conversation_id: string | null }. Records the focus for the
// session user (60 s TTL, in-memory — see src/lib/push/focus.ts) so
// the inbound-message push skips them. `null` clears it. Cheap and
// frequent (on focus + every 30 s), so no rate limit beyond auth.
// ============================================================

import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { setConversationFocus } from '@/lib/push/focus'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const body = (await request.json().catch(() => null)) as
      | { conversation_id?: unknown }
      | null
    const raw = body?.conversation_id
    if (raw !== null && raw !== undefined && (typeof raw !== 'string' || !UUID_RE.test(raw))) {
      return NextResponse.json(
        { error: "'conversation_id' must be a uuid or null" },
        { status: 400 },
      )
    }
    setConversationFocus(ctx.userId, typeof raw === 'string' ? raw : null)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
