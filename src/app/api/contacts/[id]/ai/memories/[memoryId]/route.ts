// ============================================================
// /api/contacts/:id/ai/memories/:memoryId — one contact fact (064).
// Agent+ and plan module `ai`.
//
// PATCH  → { status: 'active' } approves a proposed fact (stamps
//          approved_by), { status: 'rejected' } rejects it; { fact }
//          edits the text (an edited AI fact is approved by editing).
// DELETE → removes the fact.
//
// Caller's RLS client, filtered by the session account and the contact
// in the URL: anything else is a plain 404.
// ============================================================

import { NextResponse } from 'next/server';

import { requireModule, requireRole } from '@/lib/auth/account';
import { contactAnonymizedResponse, loadAiContact } from '@/lib/ai/conversation-context';
import { aiErrorResponse } from '@/lib/ai/http';
import { factKey, MEMORY_COLUMNS, MEMORY_ERRORS, MEMORY_LIMITS, parseManualFact, type ContactMemory } from '@/lib/ai/memory';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string; memoryId: string }> };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => NextResponse.json({ error: MEMORY_ERRORS.notFound }, { status: 404 });

async function context(params: Params['params']) {
  const { id, memoryId } = await params;
  const ctx = await requireRole('agent');
  await requireModule(ctx, 'ai');
  return { ctx, id, memoryId };
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const { ctx, id, memoryId } = await context(params);
    const limit = checkRateLimit(`ai:memory:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    if (!UUID_RE.test(id) || !UUID_RE.test(memoryId)) return notFound();

    const contact = await loadAiContact(ctx, id);
    if (!contact) return notFound();
    if (contact.anonymized_at) return contactAnonymizedResponse();

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return NextResponse.json({ error: MEMORY_ERRORS.body }, { status: 400 });

    const patch: Record<string, unknown> = {};
    if ('fact' in body) {
      const parsed = parseManualFact(body.fact);
      if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
      patch.fact = parsed.fact;
      const { data: others, error: othersErr } = await ctx.supabase
        .from('ai_contact_memories')
        .select('id, fact')
        .eq('account_id', ctx.accountId)
        .eq('contact_id', id)
        .in('status', ['proposed', 'active'])
        .neq('id', memoryId)
        .order('updated_at', { ascending: false })
        .limit(MEMORY_LIMITS.dedupeReadLimit);
      if (othersErr) throw new Error(`contact memory read failed: ${othersErr.message}`);
      if (((others ?? []) as { fact: string }[]).some((o) => factKey(o.fact) === factKey(parsed.fact))) {
        return NextResponse.json({ error: MEMORY_ERRORS.duplicate }, { status: 409 });
      }
      // Editing is reviewing: an edited proposed fact becomes active.
      patch.status = 'active';
    }
    if ('status' in body) {
      if (body.status !== 'active' && body.status !== 'rejected') {
        return NextResponse.json({ error: MEMORY_ERRORS.status }, { status: 400 });
      }
      patch.status = body.status;
    }
    if (!('status' in patch)) return NextResponse.json({ error: MEMORY_ERRORS.body }, { status: 400 });
    patch.approved_by = patch.status === 'active' ? ctx.userId : null;

    const { data, error } = await ctx.supabase
      .from('ai_contact_memories')
      .update(patch)
      .eq('id', memoryId)
      .eq('account_id', ctx.accountId)
      .eq('contact_id', id)
      .select(MEMORY_COLUMNS)
      .maybeSingle();
    if (error) throw new Error(`contact memory update failed: ${error.message}`);
    if (!data) return notFound();
    return NextResponse.json({ memory: data as ContactMemory });
  } catch (err) {
    return aiErrorResponse(err);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { ctx, id, memoryId } = await context(params);
    const limit = checkRateLimit(`ai:memory:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    if (!UUID_RE.test(id) || !UUID_RE.test(memoryId)) return notFound();

    const { data, error } = await ctx.supabase
      .from('ai_contact_memories')
      .delete()
      .eq('id', memoryId)
      .eq('account_id', ctx.accountId)
      .eq('contact_id', id)
      .select('id');
    if (error) throw new Error(`contact memory delete failed: ${error.message}`);
    if (!data?.length) return notFound();
    return NextResponse.json({ ok: true });
  } catch (err) {
    return aiErrorResponse(err);
  }
}
