// ============================================================
// POST /api/conversations/:id/ai/deal-summary/apply — "Aplicar".
//
// Agent+. Body: { deal_id, stage_id?, value?, expected_close_date?,
// task?: { title, due_date }, note? } — only what the agent left
// checked. Everything is re-validated server side and applied through
// the app's own helpers with the caller's RLS client (see
// src/lib/ai/deal-summary-apply.ts). Answers { results } with one
// status per item; a failing item never blocks the others.
//
// No model call here, so no `ai` module check; a read-only or blocked
// account is refused by requireWritable.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, requireWritable, toErrorResponse } from '@/lib/auth/account';
import { contactAnonymizedResponse, loadAiConversation } from '@/lib/ai/conversation-context';
import { applyDealUpdates, loadOpenDeal, rawUpdatesFromBody } from '@/lib/ai/deal-summary-apply';

export const dynamic = 'force-dynamic';

const notFound = () => NextResponse.json({ error: 'Not found' }, { status: 404 });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const ctx = await requireRole('agent');
    await requireWritable(ctx);

    const body = await request.json().catch(() => null);
    const { dealId, raw } = rawUpdatesFromBody(body);
    if (!dealId) return NextResponse.json({ error: 'deal_id is required' }, { status: 400 });

    const found = await loadAiConversation(ctx, id);
    if (!found) return notFound();
    if (found.contact?.anonymized_at) return contactAnonymizedResponse();

    const deal = await loadOpenDeal(ctx, found.conv.contact_id, dealId);
    if (!deal) return notFound();

    const results = await applyDealUpdates(ctx, {
      conversationId: id,
      contactId: found.conv.contact_id,
      deal,
      raw,
    });
    return NextResponse.json({ results });
  } catch (err) {
    return toErrorResponse(err);
  }
}
