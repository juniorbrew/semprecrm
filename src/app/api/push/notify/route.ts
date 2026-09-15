// ============================================================
// POST /api/push/notify — client-originated push triggers.
//
// The tasks module and the inbox write straight to Supabase from the
// browser, so there is no server hook for "task assigned" /
// "conversation assigned". After such a mutation the client posts here
// with only the event kind and the row id; the recipient, the row's
// current assignee and their preferences are all resolved server-side
// (src/lib/push/notify.ts) so a caller cannot push arbitrary text to
// arbitrary users.
//
// Body: { kind: 'task_assigned', task_id } |
//       { kind: 'conversation_assigned', conversation_id }
// Agent+ (the roles that can perform those mutations). Never fails the
// caller's flow: push errors are logged and reported as counts.
// ============================================================

import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { notifyConversationAssigned, notifyTaskAssigned } from '@/lib/push/notify'
import { isPushConfigured } from '@/lib/push/send'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Only the kinds the client may raise. `inbound_message` and `task_due`
 *  come from the webhook / cron and are rejected here. */
const CLIENT_PUSH_KINDS = ['task_assigned', 'conversation_assigned'] as const
type ClientKind = (typeof CLIENT_PUSH_KINDS)[number]

function isClientKind(v: unknown): v is ClientKind {
  return typeof v === 'string' && (CLIENT_PUSH_KINDS as readonly string[]).includes(v)
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent')
    const limit = checkRateLimit(`push:notify:${ctx.userId}`, RATE_LIMITS.react)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || !isClientKind(body.kind)) {
      return NextResponse.json(
        { error: `'kind' must be one of ${CLIENT_PUSH_KINDS.join(', ')}` },
        { status: 400 },
      )
    }
    if (!isPushConfigured()) {
      return NextResponse.json({ ok: true, skipped: 'not_configured' })
    }

    const admin = supabaseAdmin()
    if (body.kind === 'task_assigned') {
      if (typeof body.task_id !== 'string' || !UUID_RE.test(body.task_id)) {
        return NextResponse.json({ error: "'task_id' must be a uuid" }, { status: 400 })
      }
      const result = await notifyTaskAssigned(admin, {
        accountId: ctx.accountId,
        taskId: body.task_id,
        actorUserId: ctx.userId,
      })
      return NextResponse.json({ ok: true, result })
    }

    if (typeof body.conversation_id !== 'string' || !UUID_RE.test(body.conversation_id)) {
      return NextResponse.json({ error: "'conversation_id' must be a uuid" }, { status: 400 })
    }
    const result = await notifyConversationAssigned(admin, {
      accountId: ctx.accountId,
      conversationId: body.conversation_id,
      actorUserId: ctx.userId,
    })
    return NextResponse.json({ ok: true, result })
  } catch (err) {
    return toErrorResponse(err)
  }
}
