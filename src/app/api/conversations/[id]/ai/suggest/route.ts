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
//
// Phase 3 (064): the resolved AI agent (tag → number → default, see
// src/lib/ai/agents.ts) supplies instructions, tone, model override and
// knowledge on/off; body `{ agent_id }` picks another enabled agent for
// this one suggestion. Up to 10 ACTIVE contact-memory facts go in as a
// data block. GET returns the agent list + the resolved agent so the
// composer can label (and switch) it before asking.
// ============================================================

import { NextResponse } from 'next/server';

import { requireModule, requireRole, type AccountContext } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { AGENT_COLUMNS, AGENT_ERRORS, agentInstructions, resolveAgent, type AiAgent } from '@/lib/ai/agents';
import {
  contactAnonymizedResponse,
  loadAiConversation,
  loadPromptKnowledge,
  loadPromptMessages,
  type AiConversation,
} from '@/lib/ai/conversation-context';
import { AiError } from '@/lib/ai/errors';
import { aiErrorResponse } from '@/lib/ai/http';
import { runModelCall } from '@/lib/ai/run-model-call';
import { buildSuggestReplyPrompt, MEMORY_PROMPT_MAX_FACTS } from '@/lib/ai/suggest-reply';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const notFound = () => NextResponse.json({ error: 'Not found' }, { status: 404 });

/** Enabled agents (oldest first) + the one the rules pick for this conversation. */
async function loadAgents(ctx: AccountContext, conv: AiConversation) {
  const [agentsRes, tagsRes] = await Promise.all([
    ctx.supabase
      .from('ai_agents')
      .select(AGENT_COLUMNS)
      .eq('account_id', ctx.accountId)
      .eq('enabled', true)
      .order('created_at', { ascending: true }),
    ctx.supabase.from('contact_tags').select('tag_id').eq('contact_id', conv.contact_id),
  ]);
  if (agentsRes.error) throw new Error(`ai agents read failed: ${agentsRes.error.message}`);
  if (tagsRes.error) throw new Error(`contact tags read failed: ${tagsRes.error.message}`);
  const agents = (agentsRes.data ?? []) as AiAgent[];
  const tagIds = ((tagsRes.data ?? []) as { tag_id: string }[]).map((r) => r.tag_id);
  const resolved = resolveAgent(agents, { channel: conv.channel ?? 'official', tagIds });
  return { agents, resolved: resolved?.agent ?? null };
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const ctx = await requireRole('agent');
    await requireModule(ctx, 'ai');
    const found = await loadAiConversation(ctx, id);
    if (!found) return notFound();
    const { agents, resolved } = await loadAgents(ctx, found.conv);
    return NextResponse.json({
      agents: agents.map((a) => ({ id: a.id, name: a.name })),
      resolved: resolved?.id ?? null,
    });
  } catch (err) {
    return aiErrorResponse(err);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const ctx = await requireRole('agent');
    await requireModule(ctx, 'ai');

    const limit = checkRateLimit(`ai:suggest:${ctx.userId}`, RATE_LIMITS.aiSuggest);
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as { agent_id?: unknown } | null;
    const pickedAgentId = typeof body?.agent_id === 'string' && body.agent_id ? body.agent_id : null;

    const found = await loadAiConversation(ctx, id);
    if (!found) return notFound();
    const { conv, contact } = found;
    if (contact?.anonymized_at) return contactAnonymizedResponse();

    const { instructions, messages } = await loadPromptMessages(ctx, id);
    if (messages.length === 0) {
      return NextResponse.json(
        { error: 'There are no messages in this conversation to reply to yet.', code: 'no_messages' },
        { status: 422 },
      );
    }

    const { agents, resolved } = await loadAgents(ctx, conv);
    const agent = pickedAgentId ? agents.find((a) => a.id === pickedAgentId) ?? null : resolved;
    if (pickedAgentId && !agent) {
      return NextResponse.json({ error: AGENT_ERRORS.notFound }, { status: 404 });
    }

    const { data: memRows, error: memErr } = await ctx.supabase
      .from('ai_contact_memories')
      .select('fact')
      .eq('account_id', ctx.accountId)
      .eq('contact_id', conv.contact_id)
      .eq('status', 'active')
      .order('updated_at', { ascending: false })
      .limit(MEMORY_PROMPT_MAX_FACTS);
    if (memErr) throw new Error(`contact memory read failed: ${memErr.message}`);
    const memory = ((memRows ?? []) as { fact: string }[]).map((r) => r.fact);

    const knowledge = !agent || agent.knowledge_enabled ? await loadPromptKnowledge(ctx, messages) : [];

    const { system, prompt } = buildSuggestReplyPrompt({
      accountName: ctx.account.name,
      contactName: contact?.name ?? null,
      instructions: agent ? agentInstructions(agent) : instructions,
      messages,
      knowledge,
      memory,
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
      model: agent?.model ?? null,
      signal: request.signal,
    });

    return NextResponse.json({ text: result.text, agent: agent ? { id: agent.id, name: agent.name } : null });
  } catch (err) {
    if (err instanceof AiError && err.code === 'cancelled') {
      return new NextResponse(null, { status: 499 });
    }
    if (!(err instanceof AiError)) console.error('[ai/suggest] failed:', err instanceof Error ? err.message : err);
    return aiErrorResponse(err);
  }
}
