// ============================================================
// POST /api/conversations/:id/ai/memory — "Extrair fatos" (064).
//
// Agent+ and plan module `ai`. ONE model call (runModelCall, feature
// `memory_extract`: consent, key and monthly budget apply) reads the
// recent messages of this conversation plus the contact's known facts
// and returns up to 5 NEW durable facts as strict JSON. They are
// validated, filtered for sensitive data, de-duplicated against every
// fact the contact has (rejected ones included) and stored as
// `proposed`: nothing reaches a suggestion until an agent approves it.
// Returns `{ created: ContactMemory[] }`.
// ============================================================

import { NextResponse } from 'next/server';

import { requireModule, requireRole } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { contactAnonymizedResponse, loadAiConversation, loadPromptMessages } from '@/lib/ai/conversation-context';
import { AiError } from '@/lib/ai/errors';
import { aiErrorResponse } from '@/lib/ai/http';
import {
  buildMemoryExtractPrompt,
  MEMORY_COLUMNS,
  MEMORY_ERRORS,
  MEMORY_LIMITS,
  parseExtractedFacts,
  selectNewFacts,
  type ContactMemory,
} from '@/lib/ai/memory';
import { runModelCall } from '@/lib/ai/run-model-call';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const ctx = await requireRole('agent');
    await requireModule(ctx, 'ai');

    // Shares the suggestion bucket: both are paid model calls.
    const limit = checkRateLimit(`ai:suggest:${ctx.userId}`, RATE_LIMITS.aiSuggest);
    if (!limit.success) return rateLimitResponse(limit);

    const found = await loadAiConversation(ctx, id);
    if (!found) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const { conv, contact } = found;
    if (contact?.anonymized_at) return contactAnonymizedResponse();

    const { messages } = await loadPromptMessages(ctx, id);
    if (messages.length === 0) {
      return NextResponse.json(
        { error: 'There are no messages in this conversation to reply to yet.', code: 'no_messages' },
        { status: 422 },
      );
    }

    const { data: rows, error: readErr } = await ctx.supabase
      .from('ai_contact_memories')
      .select('fact, status')
      .eq('account_id', ctx.accountId)
      .eq('contact_id', conv.contact_id)
      .order('updated_at', { ascending: false })
      .limit(MEMORY_LIMITS.dedupeReadLimit);
    if (readErr) throw new Error(`contact memory read failed: ${readErr.message}`);
    const existing = (rows ?? []) as { fact: string; status: string }[];
    const live = existing.filter((r) => r.status !== 'rejected');
    if (live.length >= MEMORY_LIMITS.maxPerContact) {
      return NextResponse.json({ error: MEMORY_ERRORS.full }, { status: 409 });
    }

    const { system, prompt } = buildMemoryExtractPrompt({
      contactName: contact?.name ?? null,
      messages,
      knownFacts: live.map((r) => r.fact),
    });
    const result = await runModelCall({
      db: supabaseAdmin(),
      accountId: ctx.accountId,
      userId: ctx.userId,
      conversationId: id,
      feature: 'memory_extract',
      system,
      prompt,
      signal: request.signal,
    });

    const candidates = parseExtractedFacts(result.text);
    if (!candidates) {
      return NextResponse.json({ error: MEMORY_ERRORS.invalidResponse, code: 'invalid_response' }, { status: 502 });
    }
    const facts = selectNewFacts(candidates, existing.map((r) => r.fact)).slice(
      0,
      MEMORY_LIMITS.maxPerContact - live.length,
    );
    if (facts.length === 0) return NextResponse.json({ created: [] });

    const { data, error } = await ctx.supabase
      .from('ai_contact_memories')
      .insert(
        facts.map((fact) => ({
          account_id: ctx.accountId,
          contact_id: conv.contact_id,
          conversation_id: id,
          fact,
          status: 'proposed',
          source: 'ai',
          created_by: ctx.userId,
        })),
      )
      .select(MEMORY_COLUMNS);
    if (error) throw new Error(`contact memory insert failed: ${error.message}`);
    return NextResponse.json({ created: (data ?? []) as ContactMemory[] });
  } catch (err) {
    if (err instanceof AiError && err.code === 'cancelled') return new NextResponse(null, { status: 499 });
    if (!(err instanceof AiError)) console.error('[ai/memory] failed:', err instanceof Error ? err.message : err);
    return aiErrorResponse(err);
  }
}
