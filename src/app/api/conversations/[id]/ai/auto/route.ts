// ============================================================
// /api/conversations/:id/ai/auto — automatic reply, per conversation
// (AI phase 4, migration 066).
//
// GET (any member): { applies, agent, paused, paused_until, handling,
//   handoff } — `applies` = an enabled agent in automatic mode answers
//   this conversation (tag → number → default); `handoff` = the latest
//   hand-over while the AI is still stopped by it (the thread card).
//   Accounts without the `ai` module just get applies:false.
// POST { action: 'pause' | 'resume' } (agent+, module `ai`):
//   pause  → ai_paused_until = 'infinity' + "IA pausada" pill
//   resume → ai_paused_until = NULL + pill, and a job is queued again
//            when the customer has unanswered messages.
// The conversation is read through the caller's RLS client filtered by
// the session account: another account's conversation is a 404.
// ============================================================

import { NextResponse, after } from 'next/server';

import { ModuleNotIncludedError, requireModule, requireRole, type AccountContext } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { isPausedUntil, unansweredCustomerMessages } from '@/lib/ai/auto-reply';
import { enqueueAutoReplyIfEligible, kickAutoReplies, resolveConversationAgent } from '@/lib/ai/auto-reply-runtime';
import { aiErrorResponse } from '@/lib/ai/http';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => NextResponse.json({ error: 'Not found' }, { status: 404 });

const AUTO_ERRORS = {
  action: "'action' must be 'pause' or 'resume'",
} as const;

async function loadConversation(ctx: AccountContext, id: string) {
  if (!UUID_RE.test(id)) return null;
  const { data, error } = await ctx.supabase
    .from('conversations')
    .select('id, account_id, user_id, contact_id, status, archived_at, channel, ai_paused_until, last_customer_message_at')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (error) throw new Error(`conversation read failed: ${error.message}`);
  return data as Record<string, string | null> | null;
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const ctx = await requireRole('viewer');
    const conv = await loadConversation(ctx, id);
    if (!conv) return notFound();
    try {
      await requireModule(ctx, 'ai');
    } catch (err) {
      if (err instanceof ModuleNotIncludedError) {
        return NextResponse.json({ applies: false, agent: null, paused: false, paused_until: null, handling: false, handoff: null });
      }
      throw err;
    }
    const agent = await resolveConversationAgent(supabaseAdmin(), ctx.accountId, conv.contact_id as string, conv.channel);
    const applies = !!agent && agent.mode === 'auto';
    const paused = isPausedUntil(conv.ai_paused_until, new Date());
    let handoff = null;
    if (conv.ai_paused_until === 'infinity') {
      const { data } = await ctx.supabase
        .from('ai_handoffs')
        .select('id, reason, customer_wants, last_customer_words, notified, created_at')
        .eq('conversation_id', id)
        .eq('account_id', ctx.accountId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      handoff = data ?? null;
    }
    return NextResponse.json({
      applies,
      agent: applies && agent ? { id: agent.id, name: agent.name, paused: !!agent.paused_at } : null,
      paused,
      paused_until: conv.ai_paused_until ?? null,
      handling: applies && !agent?.paused_at && !paused && conv.status !== 'closed',
      handoff,
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
    const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
    const action = body?.action;
    if (action !== 'pause' && action !== 'resume') return NextResponse.json({ error: AUTO_ERRORS.action }, { status: 400 });

    const conv = await loadConversation(ctx, id);
    if (!conv) return notFound();

    const pausedUntil = action === 'pause' ? 'infinity' : null;
    const { error } = await ctx.supabase
      .from('conversations')
      .update({ ai_paused_until: pausedUntil })
      .eq('id', id)
      .eq('account_id', ctx.accountId);
    if (error) throw new Error(`conversation update failed: ${error.message}`);
    const { error: evErr } = await ctx.supabase.from('conversation_events').insert({
      account_id: ctx.accountId,
      conversation_id: id,
      actor_user_id: ctx.userId,
      event_type: action === 'pause' ? 'ai_paused' : 'ai_resumed',
      payload: {},
    });
    if (evErr) console.error('[ai/auto] event insert failed:', evErr.message);

    let queued = false;
    if (action === 'resume') {
      const admin = supabaseAdmin();
      const [{ data: rows }, { data: contact }] = await Promise.all([
        admin
          .from('messages')
          .select('id, sender_type, origin, created_at')
          .eq('conversation_id', id)
          .order('created_at', { ascending: false })
          .limit(40),
        admin
          .from('contacts')
          .select('id, opted_out_at, anonymized_at')
          .eq('id', conv.contact_id as string)
          .eq('account_id', ctx.accountId)
          .maybeSingle(),
      ]);
      const pending = unansweredCustomerMessages(
        ((rows ?? []) as { id: string; sender_type: 'customer' | 'agent' | 'bot'; origin?: string | null }[]).reverse(),
      );
      if (pending.length > 0 && contact) {
        queued = await enqueueAutoReplyIfEligible(admin, {
          accountId: ctx.accountId,
          conversation: { ...conv, ai_paused_until: null },
          contact,
          messageId: pending[pending.length - 1].id,
        });
        if (queued) after(kickAutoReplies);
      }
    }
    return NextResponse.json({ paused: action === 'pause', paused_until: pausedUntil, queued });
  } catch (err) {
    return aiErrorResponse(err);
  }
}
