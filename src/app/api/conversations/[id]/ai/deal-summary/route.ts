// ============================================================
// POST /api/conversations/:id/ai/deal-summary — "Resumir com IA".
//
// Agent+ and plan module `ai`. Summarises the last N messages of this
// one conversation and, when the contact has an OPEN deal, PROPOSES
// updates for it. Nothing is changed or stored here: the card shows
// the proposals and the agent applies the checked ones through
// .../deal-summary/apply (which re-validates everything).
//
// The deal: the contact's open deal linked to this conversation, else
// the most recently updated open one. No open deal = summary only.
//
// Isolation: account from the session; conversation, messages, deals
// and stages are read through the caller's RLS client and filtered by
// that account, so another account's conversation is a plain 404.
// Anonymised contacts (LGPD) are refused before anything is read.
// ============================================================

import { NextResponse } from 'next/server';

import { requireModule, requireRole } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { contactAnonymizedResponse, loadAiConversation, loadPromptMessages } from '@/lib/ai/conversation-context';
import { buildDealSummaryPrompt, parseDealSummary, summaryText, todayInSaoPaulo, type SummaryDeal } from '@/lib/ai/deal-summary';
import { loadPipelineStages } from '@/lib/ai/deal-summary-apply';
import { AiError } from '@/lib/ai/errors';
import { aiErrorResponse } from '@/lib/ai/http';
import { runModelCall } from '@/lib/ai/run-model-call';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const notFound = () => NextResponse.json({ error: 'Not found' }, { status: 404 });

interface OpenDealRow {
  id: string;
  title: string;
  value: number;
  currency: string | null;
  expected_close_date: string | null;
  stage_id: string;
  pipeline_id: string;
  conversation_id: string | null;
  stage: { name: string } | { name: string }[] | null;
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const ctx = await requireRole('agent');
    const ent = await requireModule(ctx, 'ai');
    // Without Pipelines the deal (and its stages) never reach the provider; without Tasks no task is offered.
    const pipelinesOn = ent.modules.pipelines === true;
    const tasksOn = ent.modules.tasks === true;

    const limit = checkRateLimit(`ai:deal-summary:${ctx.userId}`, RATE_LIMITS.aiDealSummary);
    if (!limit.success) return rateLimitResponse(limit);

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

    const { data: dealRows, error: dealErr } = pipelinesOn
      ? await ctx.supabase
          .from('deals')
          .select('id, title, value, currency, expected_close_date, stage_id, pipeline_id, conversation_id, stage:pipeline_stages(name)')
          .eq('account_id', ctx.accountId)
          .eq('contact_id', conv.contact_id)
          .eq('status', 'open')
          .order('updated_at', { ascending: false })
          .limit(20)
      : { data: [], error: null };
    if (dealErr) throw new Error(`deals read failed: ${dealErr.message}`);
    // Newest-updated first: the one linked to this conversation wins, else the first.
    const openDeals = (dealRows ?? []) as unknown as OpenDealRow[];
    const row = openDeals.find((d) => d.conversation_id === id) ?? openDeals[0] ?? null;

    const stages = row ? await loadPipelineStages(ctx, row.pipeline_id) : [];
    const stageEmbed = row ? (Array.isArray(row.stage) ? row.stage[0] : row.stage) : null;
    const deal: SummaryDeal | null = row
      ? {
          id: row.id,
          title: row.title,
          value: Number(row.value),
          expected_close_date: row.expected_close_date?.slice(0, 10) ?? null,
          stage_id: row.stage_id,
          stage_name: stageEmbed?.name ?? null,
        }
      : null;

    const today = todayInSaoPaulo(new Date());
    const { system, prompt } = buildDealSummaryPrompt({
      accountName: ctx.account.name,
      contactName: contact?.name ?? null,
      instructions,
      messages,
      deal,
      stages: stages.map((s) => ({ id: s.id, name: s.name })),
      today,
      tasks: tasksOn,
    });

    const result = await runModelCall({
      db: supabaseAdmin(),
      accountId: ctx.accountId,
      userId: ctx.userId,
      conversationId: id,
      feature: 'deal_summary',
      system,
      prompt,
      signal: request.signal,
    });

    const parsed = parseDealSummary(result.text, { today, stageIds: stages.map((s) => s.id), deal, tasks: tasksOn });
    if (!parsed) throw new AiError('empty_response');

    return NextResponse.json({
      summary: { wants: parsed.wants, status: parsed.status, next_step: parsed.nextStep },
      deal: deal && row ? { ...deal, currency: row.currency } : null,
      stages: stages.map((s) => ({ id: s.id, name: s.name })),
      // Only proposals that passed validation; the note is always offered with a deal.
      updates: deal
        ? {
            stage_id: parsed.updates.stageId ?? null,
            value: parsed.updates.value ?? null,
            expected_close_date: parsed.updates.closeDate ?? null,
            // Who said it (the card shows it; unknown counts as the customer).
            origin: {
              stage_id: parsed.updates.stageId ? parsed.origins.stageId : null,
              value: parsed.updates.value !== undefined ? parsed.origins.value : null,
              expected_close_date: parsed.updates.closeDate ? parsed.origins.closeDate : null,
            },
            task: parsed.updates.task
              ? { title: parsed.updates.task.title, due_date: parsed.updates.task.dueDate }
              : null,
            note: summaryText(parsed),
          }
        : null,
    });
  } catch (err) {
    if (err instanceof AiError && err.code === 'cancelled') {
      return new NextResponse(null, { status: 499 });
    }
    if (!(err instanceof AiError)) console.error('[ai/deal-summary] failed:', err instanceof Error ? err.message : err);
    return aiErrorResponse(err);
  }
}
