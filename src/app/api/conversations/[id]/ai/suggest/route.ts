// ============================================================
// POST /api/conversations/:id/ai/suggest — "Sugerir resposta".
//
// Agent+ and plan module `ai`. Builds a reply SUGGESTION from the last
// N messages of this one conversation and returns `{ text }`. It never
// sends anything and stores no text: the agent edits the suggestion in
// the composer and sends it the normal way.
//
// Isolation: the account comes from the session; the conversation and
// its messages are read through the caller's RLS client and filtered
// by that account, so another account's conversation is a plain 404.
// Anonymised contacts (LGPD) are refused before anything is read.
//
// Knowledge base (063): the last 1–3 customer messages are searched in
// the account's knowledge base (through the caller's RLS client) and up
// to 5 snippets go into the prompt as reference data. A failed search
// never blocks the suggestion — it just goes out without snippets.
// ============================================================

import { NextResponse } from 'next/server';

import { requireModule, requireRole } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { AiError } from '@/lib/ai/errors';
import { aiErrorResponse } from '@/lib/ai/http';
import { kbQueryFromMessages, KB_LIMITS, selectKbHits } from '@/lib/ai/knowledge';
import { AI_LIMITS } from '@/lib/ai/providers';
import { runModelCall } from '@/lib/ai/run-model-call';
import { searchKnowledge } from '@/lib/ai/store';
import { buildSuggestReplyPrompt, isPromptableMessage, type SuggestMessage } from '@/lib/ai/suggest-reply';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const ctx = await requireRole('agent');
    await requireModule(ctx, 'ai');

    const limit = checkRateLimit(`ai:suggest:${ctx.userId}`, RATE_LIMITS.aiSuggest);
    if (!limit.success) return rateLimitResponse(limit);

    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const { data: conv, error: convErr } = await ctx.supabase
      .from('conversations')
      .select('id, contact:contacts(name, anonymized_at)')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (convErr) throw new Error(`conversation read failed: ${convErr.message}`);
    if (!conv) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const contact = (Array.isArray(conv.contact) ? conv.contact[0] : conv.contact) as
      | { name?: string | null; anonymized_at?: string | null }
      | null;
    if (contact?.anonymized_at) {
      return NextResponse.json(
        { error: 'This contact was anonymized (LGPD) — AI suggestions are not available.', code: 'contact_anonymized' },
        { status: 403 },
      );
    }

    const { data: settings, error: setErr } = await ctx.supabase
      .from('ai_settings')
      .select('enabled, instructions, suggest_history_messages')
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (setErr) throw new Error(`ai settings read failed: ${setErr.message}`);
    if (!settings?.enabled) throw new AiError('not_enabled');

    const historyLimit = Math.min(
      AI_LIMITS.historyMax,
      Math.max(AI_LIMITS.historyMin, Number(settings.suggest_history_messages) || AI_LIMITS.historyDefault),
    );
    const { data: rows, error: msgErr } = await ctx.supabase
      .from('messages')
      .select('sender_type, content_type, content_text, template_name, status, created_at')
      .eq('conversation_id', id)
      .order('created_at', { ascending: false })
      // Over-fetch a little so failed sends (dropped below) don't eat the window.
      .limit(historyLimit + 20);
    if (msgErr) throw new Error(`messages read failed: ${msgErr.message}`);
    // Newest N that reached the customer (failed sends never did), oldest first.
    const messages = ((rows ?? []) as SuggestMessage[])
      .filter(isPromptableMessage)
      .slice(0, historyLimit)
      .reverse();
    if (messages.length === 0) {
      return NextResponse.json(
        { error: 'There are no messages in this conversation to reply to yet.', code: 'no_messages' },
        { status: 422 },
      );
    }

    let knowledge: { title: string; content: string }[] = [];
    const kbQuery = kbQueryFromMessages(messages);
    if (kbQuery) {
      try {
        const hits = await searchKnowledge(ctx.supabase, ctx.accountId, kbQuery, KB_LIMITS.promptMaxChunks);
        knowledge = selectKbHits(hits).map((h) => ({ title: h.title, content: h.content }));
      } catch (err) {
        console.error('[ai/suggest] knowledge search failed:', err instanceof Error ? err.message : err);
      }
    }

    const { system, prompt } = buildSuggestReplyPrompt({
      accountName: ctx.account.name,
      contactName: contact?.name ?? null,
      instructions: (settings.instructions as string | null) ?? null,
      messages,
      knowledge,
    });

    const result = await runModelCall({
      db: supabaseAdmin(),
      accountId: ctx.accountId,
      userId: ctx.userId,
      conversationId: id,
      feature: 'suggest_reply',
      system,
      prompt,
      kbUsed: knowledge.length > 0,
      signal: request.signal,
    });

    return NextResponse.json({ text: result.text });
  } catch (err) {
    if (err instanceof AiError && err.code === 'cancelled') {
      return new NextResponse(null, { status: 499 });
    }
    if (!(err instanceof AiError)) console.error('[ai/suggest] failed:', err instanceof Error ? err.message : err);
    return aiErrorResponse(err);
  }
}
