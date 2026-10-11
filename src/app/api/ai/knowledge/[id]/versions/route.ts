// ============================================================
// GET /api/ai/knowledge/:id/versions — the item's saved states
// (migration 087), newest first. Admin+ and module `ai`, through the
// caller's RLS client filtered by the session account: another
// account's item is a plain 404.
// ============================================================

import { NextResponse } from 'next/server';

import { requireModule, requireRole } from '@/lib/auth/account';
import { aiErrorResponse } from '@/lib/ai/http';
import { KB_ERRORS, KB_VERSION_COLUMNS, type KbVersion } from '@/lib/ai/knowledge';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Plenty for a hand-edited item; older ones stay in the table. */
const MAX_VERSIONS = 50;

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const ctx = await requireRole('admin');
    await requireModule(ctx, 'ai');
    if (!UUID_RE.test(id)) return NextResponse.json({ error: KB_ERRORS.notFound }, { status: 404 });

    const { data, error } = await ctx.supabase
      .from('ai_knowledge_item_versions')
      .select(KB_VERSION_COLUMNS)
      .eq('item_id', id)
      .eq('account_id', ctx.accountId)
      .order('version_no', { ascending: false })
      .limit(MAX_VERSIONS);
    if (error) throw new Error(`knowledge versions read failed: ${error.message}`);
    if (!data || data.length === 0) return NextResponse.json({ error: KB_ERRORS.notFound }, { status: 404 });
    return NextResponse.json({ versions: data as KbVersion[] });
  } catch (err) {
    return aiErrorResponse(err);
  }
}
