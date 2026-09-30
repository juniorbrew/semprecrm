// ============================================================
// Automatic reply runtime (AI phase 4, migration 066) — server only,
// service-role client. The rules live in ./auto-reply.ts.
//
// Trigger: ingestInboundMessage (after flows / automations, only when
// no flow consumed the message) calls enqueueAutoReplyIfEligible. That
// upserts ONE queued job per conversation (`ai_reply_enqueue`), due 8 s
// after the FIRST message of the burst; later messages attach to it.
//
// Drain: the inbound routes kick drainAutoReplies() with `after()`
// once the debounce window has passed (best effort), and the cron
// (`/api/ai/auto-reply/cron`, every scripts/cron-tick.mjs tick) drains
// whatever is due — including jobs rescheduled to the next business
// opening and jobs whose worker died (`ai_reply_claim` reaps 'running'
// rows older than 2 minutes; 3 attempts max).
//
// Run (runAutoReplyJob): eligibility again → nothing to answer? skip →
// STOP words → opt-out + confirmation → customer asked for a person →
// hand-over → model (strict JSON) → model hand-over / invalid →
// hand-over → post-checks (bubbles, commercial terms) → send bubbles
// with human-like pacing, recording each sent bubble on the job so a
// retry never sends one twice.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/automations/admin-client';
import { engineSendText } from '@/lib/automations/meta-send';
import { startOfLocalDay } from '@/lib/business-hours';
import { accountHasModule } from '@/lib/plans-server';
import { AGENT_COLUMNS, DEFAULT_HANDOFF_MESSAGE, resolveAgent, splitReply, suggestionInstructions, type AiAgent } from './agents';
import {
  AUTO_REPLY,
  DEFAULT_STOP_CONFIRMATION,
  buildAutoReplyPrompt,
  bubbleGapMs,
  checkEligibility,
  detectHandoff,
  isPausedUntil,
  isStopRequest,
  parseAutoReplyOutput,
  typingDelayMs,
  unansweredCustomerMessages,
  unverifiedCommercialTerms,
  type SkipReason,
} from './auto-reply';
import { AiError, type AiErrorCode } from './errors';
import { kbQueryFromMessages, KB_LIMITS, selectKbHits, type KbSearchHit } from './knowledge';
import { runModelCall } from './run-model-call';
import { MEMORY_PROMPT_MAX_FACTS, type SuggestMessage } from './suggest-reply';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

export interface AiReplyJob {
  id: string;
  account_id: string;
  conversation_id: string;
  contact_id: string;
  agent_id: string | null;
  status: string;
  attempts: number;
  reply_parts: string[] | null;
  sent_parts: number;
  inbound_message_ids?: string[];
}

export interface AutoReplyDeps {
  db: SupabaseClient;
  send: (args: { accountId: string; userId: string; conversationId: string; contactId: string; text: string }) => Promise<unknown>;
  runModel: typeof runModelCall;
  hasAiModule: (db: SupabaseClient, accountId: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  random: () => number;
}

export function defaultAutoReplyDeps(): AutoReplyDeps {
  return {
    db: supabaseAdmin(),
    send: (a) => engineSendText({ ...a, origin: 'ai' }),
    runModel: runModelCall,
    hasAiModule: (db, accountId) => accountHasModule(db, accountId, 'ai'),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
    random: Math.random,
  };
}

/** The account / settings / provider can't serve a reply: hand over at once. */
const AI_UNAVAILABLE = new Set<AiErrorCode>(['module_not_included', 'not_enabled', 'no_key', 'budget_exceeded', 'invalid_key', 'quota', 'model_not_found']);

const CONVERSATION_COLUMNS =
  'id, account_id, user_id, contact_id, status, archived_at, channel, ai_paused_until, last_customer_message_at';

// ------------------------------------------------------------
// Agent resolution (service role; same order as the suggestion)
// ------------------------------------------------------------

export async function resolveConversationAgent(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  channel: string | null,
): Promise<AiAgent | null> {
  const { data: agents, error } = await db
    .from('ai_agents')
    .select(AGENT_COLUMNS)
    .eq('account_id', accountId)
    .eq('enabled', true)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`ai agents read failed: ${error.message}`);
  const list = (agents ?? []) as AiAgent[];
  // Cheap exit for the common case: no agent could answer on its own.
  if (!list.some((a) => a.mode === 'auto')) return null;
  const { data: tags, error: tagErr } = await db.from('contact_tags').select('tag_id').eq('contact_id', contactId);
  if (tagErr) throw new Error(`contact tags read failed: ${tagErr.message}`);
  const tagIds = ((tags ?? []) as { tag_id: string }[]).map((t) => t.tag_id);
  return resolveAgent(list, { channel: channel ?? 'official', tagIds })?.agent ?? null;
}

// ------------------------------------------------------------
// Enqueue (called by ingestInboundMessage)
// ------------------------------------------------------------

/**
 * Queue (or extend) the conversation's automatic-reply job when an auto
 * agent answers it and nothing rules it out. Business hours and the
 * daily cap are decided at run time (reschedule / hand-over). Never
 * throws — the inbound pipeline must not fail because of the AI.
 */
export async function enqueueAutoReplyIfEligible(
  db: SupabaseClient,
  input: { accountId: string; conversation: Row; contact: Row; messageId: string | null; now?: Date },
): Promise<boolean> {
  try {
    const now = input.now ?? new Date();
    const conv = input.conversation;
    const agent = await resolveConversationAgent(db, input.accountId, input.contact.id, conv.channel ?? null);
    if (!agent || agent.mode !== 'auto') return false;
    const verdict = checkEligibility({ now, agent, contact: input.contact, conversation: conv });
    if (!verdict.ok && verdict.reason !== 'outside_hours' && verdict.reason !== 'daily_cap') return false;

    const { data: settings } = await db.from('ai_settings').select('enabled').eq('account_id', input.accountId).maybeSingle();
    if (!(settings as { enabled?: boolean } | null)?.enabled) return false;
    if (!(await accountHasModule(db, input.accountId, 'ai'))) return false;

    const { error } = await db.rpc('ai_reply_enqueue', {
      p_account_id: input.accountId,
      p_conversation_id: conv.id,
      p_contact_id: input.contact.id,
      p_agent_id: agent.id,
      p_message_id: input.messageId,
      p_delay_seconds: AUTO_REPLY.debounceSeconds,
    });
    if (error) {
      console.error('[ai/auto-reply] enqueue failed:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[ai/auto-reply] enqueue threw:', err instanceof Error ? err.message : err);
    return false;
  }
}

/** Best-effort kick for `after()`: wait out the debounce window, then drain. */
export async function kickAutoReplies(): Promise<void> {
  await new Promise((r) => setTimeout(r, AUTO_REPLY.debounceSeconds * 1000 + 500));
  await drainAutoReplies().catch((err) => console.error('[ai/auto-reply] kick drain failed:', err));
}

// ------------------------------------------------------------
// Drain (cron + kick)
// ------------------------------------------------------------

export interface DrainResult {
  claimed: number;
  replied: number;
  handoff: number;
  skipped: number;
  failed: number;
}

export async function drainAutoReplies(deps: AutoReplyDeps = defaultAutoReplyDeps(), limit = 10): Promise<DrainResult> {
  const { data, error } = await deps.db.rpc('ai_reply_claim', { p_limit: limit });
  if (error) throw new Error(`ai reply claim failed: ${error.message}`);
  const jobs = (data ?? []) as AiReplyJob[];
  const result: DrainResult = { claimed: jobs.length, replied: 0, handoff: 0, skipped: 0, failed: 0 };
  await Promise.all(
    jobs.map(async (job) => {
      try {
        const outcome = await runAutoReplyJob(job, deps);
        if (outcome === 'replied' || outcome === 'handoff') result[outcome]++;
        else result.skipped++;
      } catch (err) {
        result.failed++;
        await retryOrFail(deps.db, job, err, deps.now());
      }
    }),
  );
  return result;
}

const errText = (err: unknown) => (err instanceof AiError ? `ai:${err.code}` : err instanceof Error ? err.message : String(err)).slice(0, 500);

async function retryOrFail(db: SupabaseClient, job: AiReplyJob, err: unknown, now: Date): Promise<void> {
  console.error('[ai/auto-reply] job failed:', job.id, errText(err));
  if (job.attempts >= AUTO_REPLY.maxAttempts) {
    await patchJob(db, job.id, { status: 'failed', last_error: errText(err) });
    return;
  }
  await requeue(db, job.id, new Date(now.getTime() + 30_000 * job.attempts), { last_error: errText(err) });
}

async function patchJob(db: SupabaseClient, id: string, patch: Row): Promise<void> {
  const { error } = await db.from('ai_reply_jobs').update(patch).eq('id', id);
  if (error) console.error('[ai/auto-reply] job update failed:', id, error.message);
}

/** Back to the queue; a newer queued job of the conversation wins (unique index) → superseded. */
async function requeue(db: SupabaseClient, id: string, runAfter: Date, extra: Row = {}): Promise<void> {
  const { error } = await db
    .from('ai_reply_jobs')
    .update({ status: 'queued', run_after: runAfter.toISOString(), ...extra })
    .eq('id', id);
  if (error?.code === '23505') await patchJob(db, id, { status: 'skipped', skip_reason: 'superseded' });
  else if (error) console.error('[ai/auto-reply] requeue failed:', id, error.message);
}

const skip = async (db: SupabaseClient, id: string, reason: SkipReason | string) => {
  await patchJob(db, id, { status: 'skipped', skip_reason: reason, reply_parts: null });
  return 'skipped' as const;
};

// ------------------------------------------------------------
// Run one job
// ------------------------------------------------------------

export type JobOutcome = 'replied' | 'handoff' | 'opted_out' | 'skipped' | 'rescheduled';

export async function runAutoReplyJob(job: AiReplyJob, deps: AutoReplyDeps): Promise<JobOutcome> {
  const { db } = deps;
  const started = deps.now();

  const { data: conv, error: convErr } = await db
    .from('conversations')
    .select(CONVERSATION_COLUMNS)
    .eq('id', job.conversation_id)
    .eq('account_id', job.account_id)
    .maybeSingle();
  if (convErr) throw new Error(`conversation read failed: ${convErr.message}`);
  if (!conv) return skip(db, job.id, 'conversation_missing');
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, name, opted_out_at, anonymized_at')
    .eq('id', job.contact_id)
    .eq('account_id', job.account_id)
    .maybeSingle();
  if (contactErr) throw new Error(`contact read failed: ${contactErr.message}`);
  if (!contact) return skip(db, job.id, 'contact_missing');

  if (!(await deps.hasAiModule(db, job.account_id))) return skip(db, job.id, 'module_off');
  const agent = await resolveConversationAgent(db, job.account_id, contact.id, conv.channel ?? null);

  const tz = agent?.business_hours?.timezone || 'America/Sao_Paulo';
  const { count: repliesToday } = await db
    .from('ai_reply_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conv.id)
    .eq('outcome', 'replied')
    .gte('updated_at', startOfLocalDay(started, tz).toISOString());

  const verdict = checkEligibility({ now: started, agent, contact, conversation: conv, repliesToday: repliesToday ?? 0 });
  if (!verdict.ok) {
    if (verdict.reason === 'outside_hours' && verdict.retryAt) {
      // Waiting for the opening is not a failed attempt.
      await requeue(db, job.id, verdict.retryAt, { skip_reason: 'outside_hours', attempts: Math.max(0, job.attempts - 1) });
      return 'rescheduled';
    }
    if (!(verdict.handoff && agent)) return skip(db, job.id, verdict.reason);
  }
  const ctx: RunCtx = { job, deps, conv, contact, agent: agent as AiAgent };

  const { data: rows, error: msgErr } = await db
    .from('messages')
    .select('id, sender_type, origin, content_type, content_text, template_name, status, created_at')
    .eq('conversation_id', conv.id)
    .order('created_at', { ascending: false })
    .limit(AUTO_REPLY.historyMessages + 20);
  if (msgErr) throw new Error(`messages read failed: ${msgErr.message}`);
  const messages = ((rows ?? []) as (SuggestMessage & { origin?: string | null })[]).reverse();
  const unanswered = unansweredCustomerMessages(messages);
  const texts = unanswered.map((m) => m.content_text ?? '').filter((t) => t.trim());

  if (!verdict.ok) {
    return handOff(ctx, { reason: 'Limite diário de respostas automáticas atingido', lastWords: texts.slice(-3).join('\n') });
  }

  // A retry resumes the bubbles the previous attempt did not send.
  if (job.reply_parts?.length && job.sent_parts < job.reply_parts.length) {
    return sendParts(ctx, job.reply_parts, started);
  }
  if (unanswered.length === 0) return skip(db, job.id, 'nothing_to_answer');

  if (texts.some(isStopRequest)) return optOut(ctx, texts);

  const lastWords = texts.slice(-3).join('\n');
  const agentCfg = ctx.agent;
  if (agentCfg.handoff_enabled) {
    const asked = detectHandoff(texts, agentCfg.handoff_keywords);
    if (asked) return handOff(ctx, { reason: 'O cliente pediu para falar com uma pessoa', customerWants: 'Falar com uma pessoa da equipe', lastWords });
  }

  // ---- prompt ----
  const [{ data: settings }, memory] = await Promise.all([
    db.from('ai_settings').select('instructions').eq('account_id', job.account_id).maybeSingle(),
    loadMemory(db, job.account_id, contact.id),
  ]);
  const { data: account } = await db.from('accounts').select('name').eq('id', job.account_id).maybeSingle();
  const instructions = suggestionInstructions((settings as { instructions?: string | null } | null)?.instructions ?? null, agentCfg);
  const knowledge = agentCfg.knowledge_enabled ? await loadKnowledge(db, job.account_id, messages) : [];
  const { system, prompt } = buildAutoReplyPrompt({
    accountName: (account as { name?: string } | null)?.name ?? '',
    contactName: contact.name ?? null,
    instructions,
    messages,
    knowledge,
    memory,
    maxMessages: agentCfg.max_messages_per_turn,
    maxCharsPerMessage: agentCfg.max_chars_per_message,
  });

  let text: string;
  try {
    const result = await deps.runModel({
      db,
      accountId: job.account_id,
      userId: null,
      conversationId: conv.id,
      feature: 'auto_reply',
      system,
      prompt,
      kbUsed: knowledge.length > 0,
      model: agentCfg.model,
    });
    text = result.text;
  } catch (err) {
    const code = err instanceof AiError ? err.code : null;
    if ((code && AI_UNAVAILABLE.has(code)) || job.attempts >= AUTO_REPLY.maxAttempts) {
      return handOff(ctx, { reason: `A IA não conseguiu responder (${code ?? 'erro'})`, lastWords });
    }
    throw err;
  }

  const out = parseAutoReplyOutput(text);
  if (!out) return handOff(ctx, { reason: 'A IA não conseguiu montar uma resposta válida', lastWords });
  if (out.handoff || !out.reply) {
    return handOff(ctx, { reason: out.reason || 'A IA não tinha certeza da resposta', customerWants: out.customerWants, lastWords });
  }

  // ---- deterministic post-checks ----
  const parts = agentCfg.split_messages
    ? splitReply(out.reply, agentCfg.max_chars_per_message, agentCfg.max_messages_per_turn)
    : [out.reply];
  if (parts.length === 0 || parts.length > agentCfg.max_messages_per_turn || parts.some((p) => !p.trim())) {
    return handOff(ctx, { reason: 'A resposta da IA não coube no limite de mensagens', customerWants: out.customerWants, lastWords });
  }
  if (!agentCfg.split_messages && out.reply.length > AUTO_REPLY.maxSingleReplyChars) {
    return handOff(ctx, { reason: 'A resposta da IA ficou longa demais', customerWants: out.customerWants, lastWords });
  }
  const ground = [instructions ?? '', ...knowledge.map((k) => `${k.title}\n${k.content}`)];
  const unverified = unverifiedCommercialTerms(out.reply, ground);
  if (unverified.length > 0) {
    return handOff(ctx, {
      reason: `A IA ia citar condição comercial que não está na base (${unverified.slice(0, 3).join(', ')})`,
      customerWants: out.customerWants,
      lastWords,
    });
  }

  await patchJob(db, job.id, { reply_parts: parts, sent_parts: 0 });
  return sendParts({ ...ctx, job: { ...job, reply_parts: parts, sent_parts: 0 } }, parts, started);
}

interface RunCtx {
  job: AiReplyJob;
  deps: AutoReplyDeps;
  conv: Row;
  contact: Row;
  agent: AiAgent;
}

/** Still ours to answer? A human reply / pause / resolve since the job started stops the bubbles. */
async function stillAnswering(ctx: RunCtx): Promise<boolean> {
  const { data } = await ctx.deps.db
    .from('conversations')
    .select('status, archived_at, ai_paused_until')
    .eq('id', ctx.conv.id)
    .maybeSingle();
  const c = data as Row;
  return !!c && c.status !== 'closed' && !c.archived_at && !isPausedUntil(c.ai_paused_until, ctx.deps.now());
}

async function sendParts(ctx: RunCtx, parts: string[], started: Date): Promise<JobOutcome> {
  const { deps, job, conv, contact } = ctx;
  for (let i = job.sent_parts; i < parts.length; i++) {
    const wait =
      i === job.sent_parts && i === 0
        ? typingDelayMs(parts[0].length, deps.now().getTime() - started.getTime())
        : bubbleGapMs(deps.random);
    if (wait > 0) await deps.sleep(wait);
    if (!(await stillAnswering(ctx))) {
      return skip(deps.db, job.id, 'ai_paused');
    }
    await deps.send({ accountId: job.account_id, userId: conv.user_id, conversationId: conv.id, contactId: contact.id, text: parts[i] });
    // Recorded right after each bubble: a retry resumes from here.
    await patchJob(deps.db, job.id, { sent_parts: i + 1 });
  }
  await deps.db.from('conversations').update({ ai_last_reply_at: deps.now().toISOString() }).eq('id', conv.id);
  await patchJob(deps.db, job.id, { status: 'done', outcome: 'replied', reply_parts: null, last_error: null });
  return 'replied';
}

async function event(db: SupabaseClient, accountId: string, conversationId: string, eventType: string, payload: Row) {
  const { error } = await db.from('conversation_events').insert({
    account_id: accountId,
    conversation_id: conversationId,
    actor_user_id: null,
    event_type: eventType,
    payload,
  });
  if (error) console.error(`[ai/auto-reply] ${eventType} event insert failed:`, error.message);
}

/**
 * Hand the conversation to the team: tell the customer first (normal
 * send path; failure → notified=false), then pause the AI for good,
 * move an open conversation to pending (assignment untouched: an
 * unassigned one stays in the queue), and leave the card + pill.
 */
export async function handOff(
  ctx: RunCtx,
  info: { reason: string; customerWants?: string | null; lastWords?: string },
): Promise<JobOutcome> {
  const { deps, job, conv, contact, agent } = ctx;
  const { db } = deps;
  let notified = false;
  try {
    await deps.send({
      accountId: job.account_id,
      userId: conv.user_id,
      conversationId: conv.id,
      contactId: contact.id,
      text: agent.handoff_message?.trim() || DEFAULT_HANDOFF_MESSAGE,
    });
    notified = true;
  } catch (err) {
    console.warn('[ai/auto-reply] hand-over notice not sent:', conv.id, errText(err));
  }
  await db
    .from('conversations')
    .update({ ai_paused_until: 'infinity', ...(conv.status === 'open' ? { status: 'pending' } : {}) })
    .eq('id', conv.id)
    .eq('account_id', job.account_id);
  const { error } = await db.from('ai_handoffs').insert({
    account_id: job.account_id,
    conversation_id: conv.id,
    contact_id: contact.id,
    agent_id: agent.id,
    job_id: job.id,
    reason: info.reason.slice(0, 300),
    customer_wants: info.customerWants?.slice(0, 300) ?? null,
    last_customer_words: info.lastWords ? info.lastWords.slice(-600) : null,
    notified,
  });
  if (error) console.error('[ai/auto-reply] hand-over insert failed:', error.message);
  await event(db, job.account_id, conv.id, 'ai_handoff', { reason: info.reason.slice(0, 300) });
  await patchJob(db, job.id, { status: 'done', outcome: 'handoff', reply_parts: null });
  return 'handoff';
}

/** STOP words: confirm, then opt out through the same columns / pill as inbound opt-out. */
async function optOut(ctx: RunCtx, texts: string[]): Promise<JobOutcome> {
  const { deps, job, conv, contact } = ctx;
  const { db } = deps;
  try {
    await deps.send({ accountId: job.account_id, userId: conv.user_id, conversationId: conv.id, contactId: contact.id, text: DEFAULT_STOP_CONFIRMATION });
  } catch (err) {
    console.warn('[ai/auto-reply] opt-out confirmation not sent:', conv.id, errText(err));
  }
  const now = deps.now().toISOString();
  await db.from('contacts').update({ opted_out_at: now, updated_at: now }).eq('id', contact.id).eq('account_id', job.account_id);
  await db.from('conversations').update({ ai_paused_until: 'infinity' }).eq('id', conv.id);
  const keyword = texts.find(isStopRequest) ?? '';
  await event(db, job.account_id, conv.id, 'contact_opted_out', { keyword: keyword.slice(0, 100), source: 'ai_auto_reply' });
  await patchJob(db, job.id, { status: 'done', outcome: 'opted_out', reply_parts: null });
  return 'opted_out';
}

async function loadMemory(db: SupabaseClient, accountId: string, contactId: string): Promise<string[]> {
  const { data, error } = await db
    .from('ai_contact_memories')
    .select('fact')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('status', 'active')
    .order('updated_at', { ascending: false })
    .limit(MEMORY_PROMPT_MAX_FACTS);
  if (error) {
    console.error('[ai/auto-reply] memory read failed:', error.message);
    return [];
  }
  return ((data ?? []) as { fact: string }[]).map((r) => r.fact);
}

/** Service-role knowledge search (066), strictly this account. Failure → no snippets. */
async function loadKnowledge(db: SupabaseClient, accountId: string, messages: SuggestMessage[]) {
  const query = kbQueryFromMessages(messages);
  if (!query) return [];
  const { data, error } = await db.rpc('ai_knowledge_search_service', {
    p_account_id: accountId,
    p_query: query,
    p_limit: KB_LIMITS.promptMaxChunks,
  });
  if (error) {
    console.error('[ai/auto-reply] knowledge search failed:', error.message);
    return [];
  }
  return selectKbHits(((data ?? []) as KbSearchHit[]).map((h) => ({ ...h, rank: Number(h.rank) || 0 }))).map((h) => ({
    title: h.title,
    content: h.content,
  }));
}
