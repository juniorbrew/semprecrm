// ============================================================
// POST /api/ai/agents/:id/test — the agent page's "Teste" tab (064).
// Admin+ and module `ai`. Body `{ message, customer_name? }`: a made-up
// customer message. Returns what this agent would answer:
//   { text, parts (split like an automatic reply would be), model,
//     input_tokens, output_tokens, cost_cents, latency_ms,
//     knowledge: [{ title }] (knowledge-base snippets in the prompt) }
// Nothing is sent over WhatsApp.
// A REAL model call (runModelCall, feature `agent_test`): it counts
// toward the monthly budget. Nothing is stored but the usage row.
// ============================================================

import { NextResponse } from 'next/server';

import { requireModule, requireRole } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { AGENT_COLUMNS, AGENT_ERRORS, AGENT_LIMITS, splitReply, suggestionInstructions, type AiAgent } from '@/lib/ai/agents';
import { loadPromptKnowledge } from '@/lib/ai/conversation-context';
import { AiError } from '@/lib/ai/errors';
import { aiErrorResponse } from '@/lib/ai/http';
import { runModelCall } from '@/lib/ai/run-model-call';
import { buildSuggestReplyPrompt, type SuggestMessage } from '@/lib/ai/suggest-reply';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const ctx = await requireRole('admin');
    await requireModule(ctx, 'ai');
    const limit = checkRateLimit(`ai:suggest:${ctx.userId}`, RATE_LIMITS.aiSuggest);
    if (!limit.success) return rateLimitResponse(limit);
    if (!UUID_RE.test(id)) return NextResponse.json({ error: AGENT_ERRORS.notFound }, { status: 404 });

    const body = (await request.json().catch(() => null)) as { message?: unknown; customer_name?: unknown } | null;
    const text = typeof body?.message === 'string' ? body.message.trim() : '';
    const customerName =
      typeof body?.customer_name === 'string' ? body.customer_name.trim().slice(0, AGENT_LIMITS.testNameMaxChars) || null : null;
    if (!text || text.length > AGENT_LIMITS.testMessageMaxChars) {
      return NextResponse.json({ error: AGENT_ERRORS.message }, { status: 400 });
    }

    const { data, error } = await ctx.supabase
      .from('ai_agents')
      .select(AGENT_COLUMNS)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (error) throw new Error(`ai agent read failed: ${error.message}`);
    if (!data) return NextResponse.json({ error: AGENT_ERRORS.notFound }, { status: 404 });
    const agent = data as AiAgent;
    const { data: settings } = await ctx.supabase
      .from('ai_settings')
      .select('instructions')
      .eq('account_id', ctx.accountId)
      .maybeSingle();

    const messages: SuggestMessage[] = [
      { sender_type: 'customer', content_type: 'text', content_text: text, created_at: new Date().toISOString() },
    ];
    const knowledge = agent.knowledge_enabled ? await loadPromptKnowledge(ctx, messages) : [];

    const { system, prompt } = buildSuggestReplyPrompt({
      accountName: ctx.account.name,
      contactName: customerName,
      instructions: suggestionInstructions((settings as { instructions?: string | null } | null)?.instructions ?? null, agent),
      messages,
      knowledge,
    });
    const started = Date.now();
    const result = await runModelCall({
      db: supabaseAdmin(),
      accountId: ctx.accountId,
      userId: ctx.userId,
      conversationId: null,
      feature: 'agent_test',
      system,
      prompt,
      kbUsed: knowledge.length > 0,
      model: agent.model,
      signal: request.signal,
    });
    return NextResponse.json({
      text: result.text,
      parts: agent.split_messages
        ? splitReply(result.text, agent.max_chars_per_message, agent.max_messages_per_turn)
        : [result.text],
      model: result.model,
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      cost_cents: result.costCents,
      latency_ms: Date.now() - started,
      knowledge: knowledge.map((k) => ({ title: k.title })),
    });
  } catch (err) {
    if (err instanceof AiError && err.code === 'cancelled') return new NextResponse(null, { status: 499 });
    if (!(err instanceof AiError)) console.error('[ai/agents/test] failed:', err instanceof Error ? err.message : err);
    return aiErrorResponse(err);
  }
}
