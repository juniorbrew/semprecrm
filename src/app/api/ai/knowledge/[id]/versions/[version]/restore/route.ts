// ============================================================
// POST /api/ai/knowledge/:id/versions/:version/restore — put an old
// saved state back (migration 087). Admin+ and module `ai`.
//
// The old version is re-chunked and saved through ai_knowledge_save_item
// like any edit, so the item, its chunks and a NEW version (marked
// restored_from) change in one transaction; history is never rewritten.
// ============================================================

import { NextResponse } from 'next/server';

import { AUDIT_ACTIONS } from '@/lib/audit';
import { audit } from '@/lib/audit-server';
import { requireModule, requireRole } from '@/lib/auth/account';
import { aiErrorResponse } from '@/lib/ai/http';
import { chunksForItem, KB_ERRORS, KB_ITEM_SUMMARY_COLUMNS, type KbItemSummary, type KbKind } from '@/lib/ai/knowledge';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; version: string }> },
) {
  try {
    const { id, version } = await params;
    const ctx = await requireRole('admin');
    await requireModule(ctx, 'ai');
    const limit = checkRateLimit(`admin:ai-knowledge:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const versionNo = Number(version);
    if (!UUID_RE.test(id) || !Number.isInteger(versionNo) || versionNo < 1) {
      return NextResponse.json({ error: KB_ERRORS.versionNotFound }, { status: 404 });
    }

    const { data: row, error: readErr } = await ctx.supabase
      .from('ai_knowledge_item_versions')
      .select('kind, title, question, content, category')
      .eq('item_id', id)
      .eq('account_id', ctx.accountId)
      .eq('version_no', versionNo)
      .maybeSingle();
    if (readErr) throw new Error(`knowledge version read failed: ${readErr.message}`);
    if (!row) return NextResponse.json({ error: KB_ERRORS.versionNotFound }, { status: 404 });
    const v = row as { kind: KbKind; title: string; question: string | null; content: string; category: string | null };

    const { error } = await ctx.supabase.rpc('ai_knowledge_save_item', {
      p_account_id: ctx.accountId,
      p_item_id: id,
      p_kind: v.kind,
      p_title: v.title,
      p_question: v.question,
      p_content: v.content,
      p_source_filename: null,
      p_chunks: chunksForItem(v.kind, v.content, v.question),
      p_category: v.category,
      p_restored_from: versionNo,
    });
    if (error) {
      console.error('[POST /api/ai/knowledge/:id/versions/:version/restore] save failed:', error.message);
      return NextResponse.json({ error: 'Failed to save the knowledge item' }, { status: 500 });
    }

    await audit({
      accountId: ctx.accountId,
      actorUserId: ctx.userId,
      action: AUDIT_ACTIONS.AI_KNOWLEDGE_CHANGED,
      entityType: 'ai_knowledge_item',
      entityId: id,
      metadata: { op: 'restored', kind: v.kind, version: versionNo },
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
