// ============================================================
// POST /api/ai/agents/:id/test — "Testar" box in Settings (064).
// Admin+ and module `ai`. Body `{ message }`: a made-up customer
// message; returns the suggestion this agent would give `{ text }`.
// A REAL model call (runModelCall, feature `agent_test`): it counts
// toward the monthly budget. Nothing is stored but the usage row.
// ============================================================

import { NextResponse } from 'next/server';

import { requireModule, requireRole } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { AGENT_COLUMNS, AGENT_ERRORS, AGENT_LIMITS, suggestionInstructions, type AiAgent } from '@/lib/ai/agents';
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

    const body = (await request.json().catch(() => null)) as { message?: unknown } | null;
    const text = typeof body?.message === 'string' ? body.message.trim() : '';
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
      contactName: null,
      instructions: suggestionInstructions((settings as { instructions?: string | null } | null)?.instructions ?? null, agent),
      messages,
      knowledge,
    });
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
    return NextResponse.json({ text: result.text });
  } catch (err) {
    if (err instanceof AiError && err.code === 'cancelled') return new NextResponse(null, { status: 499 });
    if (!(err instanceof AiError)) console.error('[ai/agents/test] failed:', err instanceof Error ? err.message : err);
    return aiErrorResponse(err);
  }
}
