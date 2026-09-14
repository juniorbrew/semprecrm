// ============================================================
// POST /api/push/seen — "I am looking at this conversation".
//
// Body: { conversation_id?: string | null, chat_thread_id?: string | null }.
// Records the focus for the session user (60 s TTL, in-memory — see
// src/lib/push/focus.ts) so the inbound-message push (conversation) and
// the internal-chat push (thread) skip them. `null` clears; a key that
// is absent leaves that focus untouched. Cheap and frequent (on focus +
// every 30 s), so no rate limit beyond auth.
// ============================================================

import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { setChatThreadFocus, setConversationFocus } from '@/lib/push/focus'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const body = (await request.json().catch(() => null)) as
      | { conversation_id?: unknown; chat_thread_id?: unknown }
      | null
    const raw = body?.conversation_id
    if (raw !== null && raw !== undefined && (typeof raw !== 'string' || !UUID_RE.test(raw))) {
      return NextResponse.json(
        { error: "'conversation_id' must be a uuid or null" },
        { status: 400 },
      )
    }
    const rawThread = body?.chat_thread_id
    if (
      rawThread !== null &&
      rawThread !== undefined &&
      (typeof rawThread !== 'string' || !UUID_RE.test(rawThread))
    ) {
      return NextResponse.json(
        { error: "'chat_thread_id' must be a uuid or null" },
        { status: 400 },
      )
    }
    if (raw !== undefined) setConversationFocus(ctx.userId, typeof raw === 'string' ? raw : null)
    if (rawThread !== undefined) {
      setChatThreadFocus(ctx.userId, typeof rawThread === 'string' ? rawThread : null)
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
