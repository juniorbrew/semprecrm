// ============================================================
// POST /api/conversations/:id/ai/triage — "Classificar" (migration 071).
//
// Agent+ and plan module `ai`. Runs the AI triage for this one
// conversation and applies it under the same rules as the automatic
// runs (confidence >= 0.6, never over a manual choice) unless the body says
// { force: true } ("Reclassificar com IA": replaces the manual classification). Returns
// { applied, reason? } — a skip is not an error. The account comes from
// the session; the conversation is read through the caller's RLS client,
// so another account's conversation is a plain 404. Anonymised contacts
// (LGPD) are refused before anything is read.
// ============================================================

import { NextResponse } from 'next/server'

import { requireModule, requireRole } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { contactAnonymizedResponse, loadAiConversation } from '@/lib/ai/conversation-context'
import { AiError } from '@/lib/ai/errors'
import { aiErrorResponse } from '@/lib/ai/http'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { runTriage } from '@/lib/support/ai-triage'

export const dynamic = 'force-dynamic'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const ctx = await requireRole('agent')
    await requireModule(ctx, 'ai')

    const limit = checkRateLimit(`ai:triage:${ctx.userId}`, RATE_LIMITS.aiTriage)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as { force?: unknown } | null
    const found = await loadAiConversation(ctx, id)
    if (!found) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (found.contact?.anonymized_at) return contactAnonymizedResponse()

    const outcome = await runTriage(supabaseAdmin(), {
      accountId: ctx.accountId,
      conversationId: id,
      userId: ctx.userId,
      signal: request.signal,
      force: body?.force === true,
    })
    if (outcome.status === 'skipped' && (outcome.reason === 'triage_disabled' || outcome.reason === 'ai_disabled')) {
      return NextResponse.json({ error: 'Triage is not enabled for this account.', code: outcome.reason }, { status: 409 })
    }
    return NextResponse.json(
      outcome.status === 'applied' ? { applied: true } : { applied: false, reason: outcome.reason },
    )
  } catch (err) {
    if (err instanceof AiError && err.code === 'cancelled') return new NextResponse(null, { status: 499 })
    if (!(err instanceof AiError)) console.error('[ai/triage] failed:', err instanceof Error ? err.message : err)
    return aiErrorResponse(err)
  }
}
