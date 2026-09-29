// ============================================================
// POST /api/ai/knowledge/search — "Testar busca" in Settings. Admin+
// and module `ai`. Returns the snippets "Sugerir resposta" would send
// to the model for this question (same search, same caps). Nothing is
// sent to any AI provider.
// ============================================================

import { NextResponse } from 'next/server';

import { requireModule, requireRole } from '@/lib/auth/account';
import { aiErrorResponse } from '@/lib/ai/http';
import { KB_ERRORS, KB_LIMITS, selectKbHits, sliceChars } from '@/lib/ai/knowledge';
import { searchKnowledge } from '@/lib/ai/store';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    await requireModule(ctx, 'ai');

    const limit = checkRateLimit(`admin:ai-knowledge-search:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as { query?: unknown } | null;
    const query = typeof body?.query === 'string' ? sliceChars(body.query.trim(), 0, KB_LIMITS.searchQueryMaxChars) : '';
    if (!query) return NextResponse.json({ error: KB_ERRORS.query }, { status: 400 });

    const hits = selectKbHits(await searchKnowledge(ctx.supabase, ctx.accountId, query, KB_LIMITS.promptMaxChunks));
    return NextResponse.json({ hits });
  } catch (err) {
    return aiErrorResponse(err);
  }
}
