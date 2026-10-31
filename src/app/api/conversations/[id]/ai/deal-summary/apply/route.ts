// ============================================================
// POST /api/conversations/:id/ai/deal-summary/apply — "Aplicar".
//
// Agent+. Body: { deal_id, stage_id?, value?, expected_close_date?,
// task?: { title, due_date }, note?, expected: { stage_id, value,
// expected_close_date } } — only what the agent left checked, plus what
// the card showed. Everything is re-validated server side and applied
// through the app's own helpers with the caller's RLS client (see
// src/lib/ai/deal-summary-apply.ts). Answers { results } with one
// status per item; a failing item never blocks the others.
//
// A deal that was closed since the summary: 409 `deal_not_open`.
//
// No model call here, so no `ai` module check; a read-only or blocked
// account is refused by requireWritable.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, requireWritable, toErrorResponse } from '@/lib/auth/account';
import { contactAnonymizedResponse, loadAiConversation } from '@/lib/ai/conversation-context';
import { applyDealUpdates, loadDeal, rawUpdatesFromBody } from '@/lib/ai/deal-summary-apply';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const notFound = () => NextResponse.json({ error: 'Not found' }, { status: 404 });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const ctx = await requireRole('agent');
    await requireWritable(ctx);

    const limit = checkRateLimit(`ai:deal-apply:${ctx.userId}`, RATE_LIMITS.aiDealApply);
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    const { dealId, raw, expected } = rawUpdatesFromBody(body);
    if (!dealId) return NextResponse.json({ error: 'deal_id is required' }, { status: 400 });

    const found = await loadAiConversation(ctx, id);
    if (!found) return notFound();
    if (found.contact?.anonymized_at) return contactAnonymizedResponse();

    const deal = await loadDeal(ctx, found.conv.contact_id, dealId);
    if (!deal) return notFound();
    if (deal.status !== 'open') {
      return NextResponse.json({ error: 'This deal is no longer open.', code: 'deal_not_open' }, { status: 409 });
    }

    const results = await applyDealUpdates(ctx, {
      conversationId: id,
      contactId: found.conv.contact_id,
      deal,
      raw,
      expected,
    });
    return NextResponse.json({ results });
  } catch (err) {
    return toErrorResponse(err);
  }
}
