// ============================================================
// /api/contacts/:id/ai/memories — "Memória do contato" (migration 064).
// Plan module `ai`.
//
// GET  (viewer+) → proposed + active facts of the contact, newest first
//                  (rejected ones are kept only so the extractor does
//                  not propose them again — never listed).
// POST (agent+)  → { fact } adds a manual fact, active at once.
//
// Caller's RLS client, filtered by the session account: another
// account's contact is a plain 404.
// ============================================================

import { NextResponse } from 'next/server';

import { requireModule, requireRole } from '@/lib/auth/account';
import { contactAnonymizedResponse, loadAiContact } from '@/lib/ai/conversation-context';
import { aiErrorResponse } from '@/lib/ai/http';
import { factKey, MEMORY_COLUMNS, MEMORY_ERRORS, MEMORY_LIMITS, parseManualFact, type ContactMemory } from '@/lib/ai/memory';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };
const notFound = () => NextResponse.json({ error: MEMORY_ERRORS.contactNotFound }, { status: 404 });

export async function GET(_request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const ctx = await requireRole('viewer');
    await requireModule(ctx, 'ai');
    if (!(await loadAiContact(ctx, id))) return notFound();
    const { data, error } = await ctx.supabase
      .from('ai_contact_memories')
      .select(MEMORY_COLUMNS)
      .eq('account_id', ctx.accountId)
      .eq('contact_id', id)
      .in('status', ['proposed', 'active'])
      .order('created_at', { ascending: false });
    if (error) throw new Error(`contact memory read failed: ${error.message}`);
    return NextResponse.json({ memories: (data ?? []) as ContactMemory[] });
  } catch (err) {
    return aiErrorResponse(err);
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const ctx = await requireRole('agent');
    await requireModule(ctx, 'ai');
    const limit = checkRateLimit(`ai:memory:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const contact = await loadAiContact(ctx, id);
    if (!contact) return notFound();
    if (contact.anonymized_at) return contactAnonymizedResponse();

    const body = (await request.json().catch(() => null)) as { fact?: unknown } | null;
    const parsed = parseManualFact(body?.fact);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

    const { data: rows, error: readErr } = await ctx.supabase
      .from('ai_contact_memories')
      .select('id, fact, status')
      .eq('account_id', ctx.accountId)
      .eq('contact_id', id)
      .order('updated_at', { ascending: false })
      // ponytail: dedupe/cap over the 500 most recent facts; a contact with
      // more rejected facts than that could slip an old duplicate through.
      .limit(MEMORY_LIMITS.dedupeReadLimit);
    if (readErr) throw new Error(`contact memory read failed: ${readErr.message}`);
    const current = (rows ?? []) as { id: string; fact: string; status: string }[];
    const live = current.filter((r) => r.status !== 'rejected');
    if (live.some((r) => factKey(r.fact) === factKey(parsed.fact))) {
      return NextResponse.json({ error: MEMORY_ERRORS.duplicate }, { status: 409 });
    }
    if (live.length >= MEMORY_LIMITS.maxPerContact) {
      return NextResponse.json({ error: MEMORY_ERRORS.full }, { status: 409 });
    }

    const { data, error } = await ctx.supabase
      .from('ai_contact_memories')
      .insert({
        account_id: ctx.accountId,
        contact_id: id,
        fact: parsed.fact,
        status: 'active',
        source: 'manual',
        created_by: ctx.userId,
        approved_by: ctx.userId,
      })
      .select(MEMORY_COLUMNS)
      .single();
    if (error) throw new Error(`contact memory insert failed: ${error.message}`);
    return NextResponse.json({ memory: data as ContactMemory }, { status: 201 });
  } catch (err) {
    return aiErrorResponse(err);
  }
}
