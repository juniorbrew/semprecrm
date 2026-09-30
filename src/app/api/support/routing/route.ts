// ============================================================
// POST /api/support/routing — team routing for one conversation.
//
// Agent+. The inbox writes categories straight to Supabase from the
// browser, so it calls here afterwards:
//   { conversationId }           apply the routing rule of the category
//   { conversationId, teamId }   "Transferir para equipe" (a person's choice)
// The account comes from the session and the conversation is read through
// the caller's RLS client first, so another account's conversation is a
// plain 404. Returns the resulting team / assignee for the UI to patch.
// ============================================================

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { applyRouting, transferToTeam } from '@/lib/support/routing'

export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent')
    const limit = checkRateLimit(`support:routing:${ctx.userId}`, RATE_LIMITS.react)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as { conversationId?: unknown; teamId?: unknown } | null
    const conversationId = body?.conversationId
    if (typeof conversationId !== 'string' || !UUID_RE.test(conversationId)) {
      return NextResponse.json({ error: "'conversationId' must be a uuid" }, { status: 400 })
    }
    const teamId = body?.teamId
    if (teamId !== undefined && (typeof teamId !== 'string' || !UUID_RE.test(teamId))) {
      return NextResponse.json({ error: "'teamId' must be a uuid" }, { status: 400 })
    }

    const { data: visible } = await ctx.supabase
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (!visible) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const admin = supabaseAdmin()
    if (typeof teamId === 'string') {
      const out = await transferToTeam(admin, { accountId: ctx.accountId, conversationId, teamId, actorUserId: ctx.userId })
      if (out.status === 'failed') {
        const status = out.reason === 'write_failed' ? 500 : out.reason === 'closed' || out.reason === 'changed_meanwhile' ? 409 : 404
        return NextResponse.json({ error: out.reason }, { status })
      }
      return NextResponse.json({ routed: true, team_id: out.teamId, assigned_agent_id: out.assigneeId })
    }

    const out = await applyRouting(admin, conversationId, { accountId: ctx.accountId })
    if (out.status === 'skipped') return NextResponse.json({ routed: false, reason: out.reason })
    return NextResponse.json({ routed: true, team_id: out.teamId, assigned_agent_id: out.assigneeId })
  } catch (err) {
    return toErrorResponse(err)
  }
}
