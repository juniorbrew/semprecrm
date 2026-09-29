// ============================================================
// /api/ai/knowledge/:id — one knowledge item. Admin+ and module `ai`.
//
// GET    → the full item (for the edit form)
// PATCH  → { enabled } toggles it; { title, question?, content } edits
//          it and re-chunks (kind and source file never change)
// DELETE → removes it (chunks cascade)
//
// Everything through the caller's RLS client, filtered by the session
// account: another account's item is a plain 404.
// ============================================================

import { NextResponse } from 'next/server';

import { AUDIT_ACTIONS } from '@/lib/audit';
import { audit } from '@/lib/audit-server';
import { requireModule, requireRole } from '@/lib/auth/account';
import { aiErrorResponse } from '@/lib/ai/http';
import {
  chunksForItem,
  KB_ERRORS,
  KB_ITEM_SUMMARY_COLUMNS,
  parseKbItemInput,
  type KbItem,
  type KbItemSummary,
} from '@/lib/ai/knowledge';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ITEM_COLUMNS = 'id, kind, title, question, content, source_filename, enabled, created_at, updated_at';
const notFound = () => NextResponse.json({ error: KB_ERRORS.notFound }, { status: 404 });

type Params = { params: Promise<{ id: string }> };

async function context() {
  const ctx = await requireRole('admin');
  await requireModule(ctx, 'ai');
  return ctx;
}

export async function GET(_request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const ctx = await context();
    if (!UUID_RE.test(id)) return notFound();
    const { data, error } = await ctx.supabase
      .from('ai_knowledge_items')
      .select(ITEM_COLUMNS)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (error) throw new Error(`knowledge read failed: ${error.message}`);
    if (!data) return notFound();
    return NextResponse.json({ item: data as KbItem });
  } catch (err) {
    return aiErrorResponse(err);
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const ctx = await context();
    const limit = checkRateLimit(`admin:ai-knowledge:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    if (!UUID_RE.test(id)) return notFound();

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return NextResponse.json({ error: KB_ERRORS.body }, { status: 400 });

    const { data: current, error: readErr } = await ctx.supabase
      .from('ai_knowledge_items')
      .select('id, kind')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (readErr) throw new Error(`knowledge read failed: ${readErr.message}`);
    if (!current) return notFound();

    let op: 'enabled' | 'disabled' | 'edited';
    if (typeof body.enabled === 'boolean' && !('content' in body)) {
      const { error } = await ctx.supabase
        .from('ai_knowledge_items')
        .update({ enabled: body.enabled })
        .eq('id', id)
        .eq('account_id', ctx.accountId);
      if (error) throw new Error(`knowledge toggle failed: ${error.message}`);
      op = body.enabled ? 'enabled' : 'disabled';
    } else {
      const kind = current.kind as KbItem['kind'];
      const parsed = parseKbItemInput(kind, body);
      if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
      const { title, question, content } = parsed.value;
      const { error } = await ctx.supabase.rpc('ai_knowledge_save_item', {
        p_account_id: ctx.accountId,
        p_item_id: id,
        p_kind: kind,
        p_title: title,
        p_question: question,
        p_content: content,
        p_source_filename: null,
        p_chunks: chunksForItem(kind, content, question),
      });
      if (error) {
        console.error('[PATCH /api/ai/knowledge/:id] save failed:', error.message);
        return NextResponse.json({ error: 'Failed to save the knowledge item' }, { status: 500 });
      }
      op = 'edited';
    }

    await audit({
      accountId: ctx.accountId,
      actorUserId: ctx.userId,
      action: AUDIT_ACTIONS.AI_KNOWLEDGE_CHANGED,
      entityType: 'ai_knowledge_item',
      entityId: id,
      metadata: { op, kind: current.kind },
    });

    const { data: item } = await ctx.supabase
      .from('ai_knowledge_items')
      .select(KB_ITEM_SUMMARY_COLUMNS)
      .eq('id', id)
      .maybeSingle();
    return NextResponse.json({ item: item as KbItemSummary | null });
  } catch (err) {
    return aiErrorResponse(err);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const ctx = await context();
    const limit = checkRateLimit(`admin:ai-knowledge:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    if (!UUID_RE.test(id)) return notFound();

    const { data, error } = await ctx.supabase
      .from('ai_knowledge_items')
      .delete()
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select('id, kind');
    if (error) throw new Error(`knowledge delete failed: ${error.message}`);
    const row = (data ?? [])[0] as { id: string; kind: string } | undefined;
    if (!row) return notFound();

    await audit({
      accountId: ctx.accountId,
      actorUserId: ctx.userId,
      action: AUDIT_ACTIONS.AI_KNOWLEDGE_CHANGED,
      entityType: 'ai_knowledge_item',
      entityId: id,
      metadata: { op: 'deleted', kind: row.kind },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return aiErrorResponse(err);
  }
}
