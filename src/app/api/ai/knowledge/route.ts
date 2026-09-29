// ============================================================
// /api/ai/knowledge — Settings → Inteligência Artificial → Base de
// conhecimento. Admin+ and plan module `ai` (migration 063).
//
// GET  → items of the account (no full text; `content_chars` for size)
// POST → create. JSON { kind: 'faq' | 'text', title, question?, content }
//        or multipart/form-data with a `file` (.txt/.md/.csv/.pdf, 5 MB):
//        the text is extracted server-side and only the text is stored.
//
// Writes go through the caller's RLS client and the
// `ai_knowledge_save_item` RPC (item + chunks in one transaction).
// ============================================================

import { NextResponse } from 'next/server';

import { AUDIT_ACTIONS } from '@/lib/audit';
import { audit } from '@/lib/audit-server';
import { requireModule, requireRole, type AccountContext } from '@/lib/auth/account';
import { aiErrorResponse } from '@/lib/ai/http';
import {
  chunksForItem,
  cleanText,
  KB_ERRORS,
  KB_ITEM_SUMMARY_COLUMNS,
  KB_LIMITS,
  parseKbItemInput,
  sliceChars,
  type KbItemSummary,
  type KbKind,
} from '@/lib/ai/knowledge';
import { extractFileText, KbExtractError, KB_EXTRACT_ERRORS } from '@/lib/ai/knowledge-extract';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/** Multipart framing (boundaries, headers, the title field) on top of the file. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    await requireModule(ctx, 'ai');
    const { data, error } = await ctx.supabase
      .from('ai_knowledge_items')
      .select(KB_ITEM_SUMMARY_COLUMNS)
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false });
    if (error) throw new Error(`knowledge list failed: ${error.message}`);
    return NextResponse.json({ items: (data ?? []) as KbItemSummary[] });
  } catch (err) {
    return aiErrorResponse(err);
  }
}

async function countItems(ctx: AccountContext): Promise<number> {
  const { count, error } = await ctx.supabase
    .from('ai_knowledge_items')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', ctx.accountId);
  if (error) throw new Error(`knowledge count failed: ${error.message}`);
  return count ?? 0;
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    await requireModule(ctx, 'ai');

    const limit = checkRateLimit(`admin:ai-knowledge:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    let kind: KbKind;
    let body: unknown;
    let sourceFilename: string | null = null;

    if ((request.headers.get('content-type') ?? '').includes('multipart/form-data')) {
      // Refuse oversized uploads before buffering the body.
      const declared = Number(request.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > KB_LIMITS.fileMaxBytes + MULTIPART_OVERHEAD_BYTES) {
        return NextResponse.json({ error: KB_EXTRACT_ERRORS.size }, { status: 413 });
      }
      const form = await request.formData().catch(() => null);
      const file = form?.get('file');
      if (!(file instanceof File)) return NextResponse.json({ error: KB_ERRORS.body }, { status: 400 });
      if (file.size > KB_LIMITS.fileMaxBytes) {
        return NextResponse.json({ error: KB_EXTRACT_ERRORS.size }, { status: 413 });
      }
      let content: string;
      try {
        content = await extractFileText(file.name, new Uint8Array(await file.arrayBuffer()));
      } catch (err) {
        if (err instanceof KbExtractError) return NextResponse.json({ error: err.message }, { status: 422 });
        throw err;
      }
      kind = 'file';
      const name = cleanText(file.name).replace(/\s+/g, ' ');
      sourceFilename = sliceChars(name, 0, 255) || null;
      const typed = form?.get('title');
      const title =
        (typeof typed === 'string' ? typed.replace(/\s+/g, ' ').trim() : '') ||
        name.replace(/\.[^.]*$/, '').trim() ||
        'Arquivo';
      body = { title: sliceChars(title, 0, KB_LIMITS.titleMaxChars), content };
    } else {
      body = (await request.json().catch(() => null)) as unknown;
      const k = (body as { kind?: unknown } | null)?.kind;
      if (k !== 'faq' && k !== 'text') return NextResponse.json({ error: KB_ERRORS.kind }, { status: 400 });
      kind = k;
    }

    const parsed = parseKbItemInput(kind, body);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

    if ((await countItems(ctx)) >= KB_LIMITS.maxItemsPerAccount) {
      return NextResponse.json({ error: KB_ERRORS.tooMany }, { status: 409 });
    }

    const { title, question, content } = parsed.value;
    const { data: id, error } = await ctx.supabase.rpc('ai_knowledge_save_item', {
      p_account_id: ctx.accountId,
      p_item_id: null,
      p_kind: kind,
      p_title: title,
      p_question: question,
      p_content: content,
      p_source_filename: sourceFilename,
      p_chunks: chunksForItem(kind, content, question),
    });
    if (error || !id) {
      console.error('[POST /api/ai/knowledge] save failed:', error?.message);
      return NextResponse.json({ error: 'Failed to save the knowledge item' }, { status: 500 });
    }

    await audit({
      accountId: ctx.accountId,
      actorUserId: ctx.userId,
      action: AUDIT_ACTIONS.AI_KNOWLEDGE_CHANGED,
      entityType: 'ai_knowledge_item',
      entityId: id as string,
      metadata: { op: 'created', kind, chars: content.length },
    });

    const { data: item } = await ctx.supabase
      .from('ai_knowledge_items')
      .select(KB_ITEM_SUMMARY_COLUMNS)
      .eq('id', id as string)
      .maybeSingle();
    return NextResponse.json({ item: item as KbItemSummary | null }, { status: 201 });
  } catch (err) {
    return aiErrorResponse(err);
  }
}
