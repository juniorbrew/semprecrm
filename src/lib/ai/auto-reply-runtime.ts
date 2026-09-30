// ============================================================
// Automatic reply runtime (AI phase 4, migration 066) — server only,
// service-role client. The rules live in ./auto-reply.ts.
//
// Trigger: ingestInboundMessage (after flows / automations, only when
// no flow consumed the message and it was not an opt-out) calls
// enqueueAutoReplyIfEligible. That upserts ONE queued job per
// conversation (`ai_reply_enqueue`), due 8 s after the FIRST message of
// the burst; later messages attach their ids. A job answers exactly its
// `inbound_message_ids` — never a created_at cut-off (customer rows
// carry WhatsApp-second timestamps, our bubbles now()). A message that
// arrives while a job runs opens the next job.
//
// Drain: the inbound routes kick drainAutoReplies() once the debounce
// window has passed (best effort) and the cron route claims due jobs
// every tick and runs them after its response (`after()`), at most
// MAX_CONCURRENCY at a time in this process. `ai_reply_claim` reaps
// dead 'running' jobs (2 min without a heartbeat).
//
// Run: eligibility → AI still on → answered meanwhile by an automation
// / flow? → customer asked for a person → model (strict JSON) → post-
// checks (bubbles, commercial terms, instruction leak) → bubbles with
// human-like pacing. Right before EACH bubble (after the QR pacing
// wait) everything that could have changed is re-read and the job
// heartbeats; each sent bubble is recorded, so a retry never re-sends
// one. A send whose outcome is unknown is never retried: the rest is
// dropped and the conversation goes to the team.
//
// Anything that would leave the customer unanswered for good (closed
// 24 h window after a reschedule, repeated failures) hands the
// conversation to the team silently (no notice, card + pending).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/automations/admin-client';
import { engineSendText } from '@/lib/automations/meta-send';
import { paceAutomatedQrSend } from '@/lib/automations/qr-pacing';
import { startOfLocalDay } from '@/lib/business-hours';
import { accountHasModule } from '@/lib/plans-server';
import { MetaSendError } from '@/lib/whatsapp/meta-api';
import { GatewayUnreachableError } from '@/lib/whatsapp/qr-gateway';
import { AGENT_COLUMNS, DEFAULT_HANDOFF_MESSAGE, resolveAgent, splitReply, suggestionInstructions, type AiAgent } from './agents';
import {
  AUTO_REPLY,
  buildAutoReplyPrompt,
  bubbleGapMs,
  checkEligibility,
  detectHandoff,
  isPausedUntil,
  leaksInstructions,
  parseAutoReplyOutput,
  typingDelayMs,
  unverifiedCommercialTerms,
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
  inbound_message_ids: string[];
}

export interface AutoReplyDeps {
  db: SupabaseClient;
  /** Sends one bubble (origin 'ai'); pacing is done by `pace` beforehand. */
  send: (args: { accountId: string; userId: string; conversationId: string; contactId: string; text: string }) => Promise<unknown>;
  /** QR anti-ban spacing, awaited BEFORE the last-moment checks. */
  pace: (accountId: string, channel: string | null) => Promise<void>;
  runModel: typeof runModelCall;
  hasAiModule: (db: SupabaseClient, accountId: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  random: () => number;
}

export function defaultAutoReplyDeps(): AutoReplyDeps {
  return {
    db: supabaseAdmin(),
    send: (a) => engineSendText({ ...a, origin: 'ai', skipPacing: true }),
    pace: async (accountId, channel) => {
      if (channel === 'qr') await paceAutomatedQrSend(accountId);
    },
    runModel: runModelCall,
    hasAiModule: (db, accountId) => accountHasModule(db, accountId, 'ai'),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
    random: Math.random,
  };
}

/** Provider / budget problems the team must know about: hand over. */
const AI_HANDOFF_CODES = new Set<AiErrorCode>(['budget_exceeded', 'quota', 'invalid_key', 'model_not_found']);
/** AI switched off for the account: stay quiet. */
const AI_OFF_CODES = new Set<AiErrorCode>(['module_not_included', 'not_enabled', 'no_key']);

/**
 * The send may have reached WhatsApp: Meta timeout / 5xx / network
 * ("uncertain"), gateway unreachable / timeout / no id, or delivered
 * but not stored. Such a bubble is never sent again.
 */
export function isUncertainSend(err: unknown): boolean {
  if (err instanceof MetaSendError) return err.uncertain;
  if (err instanceof GatewayUnreachableError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /\bsent (to Meta|via gateway) but DB insert failed/i.test(msg);
}

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

async function aiSettingsEnabled(db: SupabaseClient, accountId: string): Promise<boolean> {
  const { data, error } = await db.from('ai_settings').select('enabled').eq('account_id', accountId).maybeSingle();
  if (error) throw new Error(`ai settings read failed: ${error.message}`);
  return !!(data as { enabled?: boolean } | null)?.enabled;
}

// ------------------------------------------------------------
// Enqueue (ingestInboundMessage, resume)
// ------------------------------------------------------------

/**
 * Queue (or extend) the conversation's automatic-reply job with these
 * customer message ids when an auto agent answers it and nothing rules
 * it out. Business hours and the daily cap are decided at run time.
 * Never throws — the inbound pipeline must not fail because of the AI.
 */
export async function enqueueAutoReplyIfEligible(
  db: SupabaseClient,
  input: { accountId: string; conversation: Row; contact: Row; messageIds: string[]; now?: Date },
): Promise<boolean> {
  try {
    if (input.messageIds.length === 0) return false;
    const now = input.now ?? new Date();
    const conv = input.conversation;
    const agent = await resolveConversationAgent(db, input.accountId, input.contact.id, conv.channel ?? null);
    if (!agent || agent.mode !== 'auto') return false;
    const verdict = checkEligibility({ now, agent, contact: input.contact, conversation: conv });
    if (!verdict.ok && verdict.reason !== 'outside_hours' && verdict.reason !== 'daily_cap') return false;
    if (!(await aiSettingsEnabled(db, input.accountId))) return false;
    if (!(await accountHasModule(db, input.accountId, 'ai'))) return false;

    const { error } = await db.rpc('ai_reply_enqueue', {
      p_account_id: input.accountId,
      p_conversation_id: conv.id,
      p_contact_id: input.contact.id,
      p_agent_id: agent.id,
      p_message_ids: input.messageIds,
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
// Claim + run (cron / kick)
// ------------------------------------------------------------

export interface DrainResult {
  claimed: number;
  replied: number;
  handoff: number;
  skipped: number;
  failed: number;
}

/** Jobs running in this process — the claim never takes more than the free slots. */
export const MAX_CONCURRENCY = 10;
let inFlight = 0;

export async function claimAutoReplies(deps: AutoReplyDeps = defaultAutoReplyDeps(), limit = MAX_CONCURRENCY): Promise<AiReplyJob[]> {
  const free = Math.min(limit, MAX_CONCURRENCY - inFlight);
  if (free <= 0) return [];
  const { data, error } = await deps.db.rpc('ai_reply_claim', { p_limit: free });
  if (error) throw new Error(`ai reply claim failed: ${error.message}`);
  const jobs = (data ?? []) as AiReplyJob[];
  inFlight += jobs.length; // released by runClaimedJobs
  return jobs;
}

export async function runClaimedJobs(jobs: AiReplyJob[], deps: AutoReplyDeps = defaultAutoReplyDeps()): Promise<DrainResult> {
  const result: DrainResult = { claimed: jobs.length, replied: 0, handoff: 0, skipped: 0, failed: 0 };
  await Promise.all(
    jobs.map(async (job) => {
      try {
        const outcome = await runAutoReplyJob(job, deps);
        if (outcome === 'replied' || outcome === 'handoff') result[outcome]++;
        else result.skipped++;
      } catch (err) {
        result.failed++;
        await retryOrGiveUp(job, err, deps).catch((e) => console.error('[ai/auto-reply] retry bookkeeping failed:', job.id, e));
      } finally {
        inFlight = Math.max(0, inFlight - 1);
      }
    }),
  );
  return result;
}

export async function drainAutoReplies(deps: AutoReplyDeps = defaultAutoReplyDeps(), limit = MAX_CONCURRENCY): Promise<DrainResult> {
  return runClaimedJobs(await claimAutoReplies(deps, limit), deps);
}

/** Test helper. */
export function resetAutoReplyConcurrency(): void {
  inFlight = 0;
}

const errText = (err: unknown) => (err instanceof AiError ? `ai:${err.code}` : err instanceof Error ? err.message : String(err)).slice(0, 500);

/** A thrown job: retry with back-off, or — out of attempts — hand over silently. */
async function retryOrGiveUp(job: AiReplyJob, err: unknown, deps: AutoReplyDeps): Promise<void> {
  console.error('[ai/auto-reply] job failed:', job.id, errText(err));
  if (job.attempts >= AUTO_REPLY.maxAttempts) {
    await patchJob(deps.db, job.id, { status: 'failed', last_error: errText(err) });
    await giveUp(job, deps, 'A IA falhou várias vezes ao responder');
    return;
  }
  await requeue(deps.db, job, new Date(deps.now().getTime() + 30_000 * job.attempts), { last_error: errText(err) });
}

async function patchJob(db: SupabaseClient, id: string, patch: Row): Promise<void> {
  const { error } = await db.from('ai_reply_jobs').update(patch).eq('id', id);
  if (error) console.error('[ai/auto-reply] job update failed:', id, error.message);
}

/**
 * Back to the queue. When a newer job of the conversation is already
 * queued (unique index → 23505) this job's messages move into it and
 * this one ends as 'merged' — the newer job answers all of them.
 */
async function requeue(db: SupabaseClient, job: AiReplyJob, runAfter: Date, extra: Row = {}): Promise<void> {
  const { error } = await db
    .from('ai_reply_jobs')
    .update({ status: 'queued', run_after: runAfter.toISOString(), ...extra })
    .eq('id', job.id);
  if (error?.code !== '23505') {
    if (error) console.error('[ai/auto-reply] requeue failed:', job.id, error.message);
    return;
  }
  const { data: newer } = await db
    .from('ai_reply_jobs')
    .select('id, inbound_message_ids')
    .eq('conversation_id', job.conversation_id)
    .eq('status', 'queued')
    .maybeSingle();
  if (newer) {
    const ids = [...new Set([...(job.inbound_message_ids ?? []), ...((newer as Row).inbound_message_ids ?? [])])].slice(0, 200);
    await patchJob(db, (newer as Row).id, { inbound_message_ids: ids });
  }
  await patchJob(db, job.id, { status: 'skipped', skip_reason: 'merged', reply_parts: null });
}

const skip = async (db: SupabaseClient, id: string, reason: string) => {
  await patchJob(db, id, { status: 'skipped', skip_reason: reason, reply_parts: null });
  return 'skipped' as const;
};

/** Load what a silent hand-over needs and do it (repeated failures, dead worker). */
async function giveUp(job: AiReplyJob, deps: AutoReplyDeps, reason: string): Promise<void> {
  const { db } = deps;
  const { data: conv } = await db.from('conversations').select(CONVERSATION_COLUMNS).eq('id', job.conversation_id).eq('account_id', job.account_id).maybeSingle();
  const { data: contact } = await db.from('contacts').select('id, name, opted_out_at, anonymized_at').eq('id', job.contact_id).eq('account_id', job.account_id).maybeSingle();
  if (!conv || !contact || (conv as Row).status === 'closed' || (contact as Row).opted_out_at || (contact as Row).anonymized_at) return;
  const pending = await loadJobMessages(db, job, (conv as Row).id);
  if (pending.length === 0) return;
  await handOff({ job, deps, conv, contact, agent: null }, { reason, lastWords: lastWords(pending), notify: false, finish: false });
}

// ------------------------------------------------------------
// Run one job
// ------------------------------------------------------------

export type JobOutcome = 'replied' | 'handoff' | 'skipped' | 'rescheduled';

type Msg = SuggestMessage & { id: string; origin?: string | null };

async function loadJobMessages(db: SupabaseClient, job: AiReplyJob, conversationId: string): Promise<Msg[]> {
  const ids = job.inbound_message_ids ?? [];
  if (ids.length === 0) return [];
  const { data, error } = await db
    .from('messages')
    .select('id, sender_type, origin, content_type, content_text, template_name, status, created_at')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .in('id', ids)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`messages read failed: ${error.message}`);
  return (data ?? []) as Msg[];
}

const lastWords = (msgs: Msg[]) =>
  msgs
    .map((m) => m.content_text ?? '')
    .filter((t) => t.trim())
    .slice(-3)
    .join('\n');

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
  if (conv.contact_id !== job.contact_id) return skip(db, job.id, 'contact_mismatch');
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, name, opted_out_at, anonymized_at')
    .eq('id', job.contact_id)
    .eq('account_id', job.account_id)
    .maybeSingle();
  if (contactErr) throw new Error(`contact read failed: ${contactErr.message}`);
  if (!contact) return skip(db, job.id, 'contact_missing');

  // AI switched off / module removed: quiet, nothing to the customer.
  if (!(await aiSettingsEnabled(db, job.account_id)) || !(await deps.hasAiModule(db, job.account_id))) {
    return skip(db, job.id, 'ai_disabled');
  }

  const agent = await resolveConversationAgent(db, job.account_id, contact.id, conv.channel ?? null);
  if (agent && agent.id !== job.agent_id) await patchJob(db, job.id, { agent_id: agent.id });
  const pending = await loadJobMessages(db, job, conv.id);
  const ctx: RunCtx = { job, deps, conv, contact, agent };

  // Reaped / crashed more times than allowed: stop trying, tell the team.
  if (job.attempts > AUTO_REPLY.maxAttempts) {
    if (pending.length === 0) return skip(db, job.id, 'failed_attempts');
    return handOff(ctx, { reason: 'A IA falhou várias vezes ao responder', lastWords: lastWords(pending), notify: false });
  }

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
      await requeue(db, job, verdict.retryAt, { skip_reason: 'outside_hours', attempts: Math.max(0, job.attempts - 1) });
      return 'rescheduled';
    }
    if (verdict.reason === 'meta_window_closed' && agent && pending.length > 0) {
      // We can no longer answer on WhatsApp: the team must pick it up.
      return handOff(ctx, { reason: 'A janela de 24 h do WhatsApp fechou antes da resposta', lastWords: lastWords(pending), notify: false });
    }
    if (verdict.reason === 'daily_cap' && agent) {
      return handOff(ctx, { reason: 'Limite diário de respostas automáticas atingido', lastWords: lastWords(pending), notify: true });
    }
    return skip(db, job.id, verdict.reason);
  }
  const agentCfg = agent as AiAgent;

  // A retry resumes the bubbles the previous attempt did not send.
  if (job.reply_parts?.length && job.sent_parts < job.reply_parts.length) {
    return sendParts(ctx, job.reply_parts, started);
  }
  if (pending.length === 0) return skip(db, job.id, 'nothing_to_answer');

  // Someone (automation, out-of-hours reply, flow) already answered, or
  // the customer is inside a running flow: stay out of it.
  const { count: botAfter } = await db
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conv.id)
    .eq('sender_type', 'bot')
    .in('origin', ['automation', 'flow'])
    .gte('created_at', pending[0].created_at);
  if ((botAfter ?? 0) > 0) return skip(db, job.id, 'automation_answered');
  const { count: activeFlows } = await db
    .from('flow_runs')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', job.account_id)
    .eq('contact_id', contact.id)
    .eq('status', 'active');
  if ((activeFlows ?? 0) > 0) return skip(db, job.id, 'flow_active');

  const texts = pending.map((m) => m.content_text ?? '').filter((t) => t.trim());
  const words = lastWords(pending);
  if (agentCfg.handoff_enabled && detectHandoff(texts, agentCfg.handoff_keywords)) {
    return handOff(ctx, { reason: 'O cliente pediu para falar com uma pessoa', customerWants: 'Falar com uma pessoa da equipe', lastWords: words, notify: true });
  }

  // ---- prompt ----
  const { data: rows, error: msgErr } = await db
    .from('messages')
    .select('id, sender_type, origin, content_type, content_text, template_name, status, created_at')
    .eq('conversation_id', conv.id)
    .order('created_at', { ascending: false })
    .limit(AUTO_REPLY.historyMessages + 20);
  if (msgErr) throw new Error(`messages read failed: ${msgErr.message}`);
  const history = ((rows ?? []) as Msg[]).reverse();
  const [{ data: settings }, memory, { data: account }] = await Promise.all([
    db.from('ai_settings').select('instructions').eq('account_id', job.account_id).maybeSingle(),
    loadMemory(db, job.account_id, contact.id),
    db.from('accounts').select('name').eq('id', job.account_id).maybeSingle(),
  ]);
  const instructions = suggestionInstructions((settings as { instructions?: string | null } | null)?.instructions ?? null, agentCfg);
  const knowledge = agentCfg.knowledge_enabled ? await loadKnowledge(db, job.account_id, pending) : [];
  const { system, prompt } = buildAutoReplyPrompt({
    accountName: (account as { name?: string } | null)?.name ?? '',
    contactName: contact.name ?? null,
    instructions,
    messages: history,
    pending,
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
    if (code && AI_OFF_CODES.has(code)) return skip(db, job.id, 'ai_disabled');
    if (code && AI_HANDOFF_CODES.has(code)) {
      return handOff(ctx, { reason: `A IA está indisponível (${code})`, lastWords: words, notify: true });
    }
    if (job.attempts >= AUTO_REPLY.maxAttempts) {
      return handOff(ctx, { reason: `A IA não conseguiu responder (${code ?? 'erro'})`, lastWords: words, notify: false });
    }
    throw err;
  }

  const out = parseAutoReplyOutput(text);
  if (!out) return handOff(ctx, { reason: 'A IA não conseguiu montar uma resposta válida', lastWords: words, notify: true });
  if (out.handoff || !out.reply) {
    return handOff(ctx, { reason: out.reason || 'A IA não tinha certeza da resposta', customerWants: out.customerWants, lastWords: words, notify: true });
  }

  // ---- deterministic post-checks ----
  const parts = agentCfg.split_messages
    ? splitReply(out.reply, agentCfg.max_chars_per_message, agentCfg.max_messages_per_turn)
    : [out.reply];
  const fail = (reason: string) => handOff(ctx, { reason, customerWants: out.customerWants, lastWords: words, notify: true });
  if (parts.length === 0 || parts.length > agentCfg.max_messages_per_turn || parts.some((p) => !p.trim())) {
    return fail('A resposta da IA não coube no limite de mensagens');
  }
  if (!agentCfg.split_messages && out.reply.length > AUTO_REPLY.maxSingleReplyChars) return fail('A resposta da IA ficou longa demais');
  if (leaksInstructions(out.reply, instructions)) return fail('A resposta da IA repetia as instruções internas');
  const ground = [instructions ?? '', ...knowledge.map((k) => `${k.title}\n${k.content}`)];
  const unverified = unverifiedCommercialTerms(out.reply, ground);
  if (unverified.length > 0) {
    return fail(`A IA ia citar condição comercial que não está na base (${unverified.slice(0, 3).join(', ')})`);
  }

  await patchJob(db, job.id, { reply_parts: parts, sent_parts: 0 });
  return sendParts({ ...ctx, job: { ...job, reply_parts: parts, sent_parts: 0 } }, parts, started);
}

interface RunCtx {
  job: AiReplyJob;
  deps: AutoReplyDeps;
  conv: Row;
  contact: Row;
  agent: AiAgent | null;
}

/**
 * Still ours to answer, right now? Conversation not resolved / paused
 * (a human replied, claimed or paused), contact not opted out /
 * anonymised, agent still automatic, enabled and not paused, AI on.
 */
async function stillAnswering(ctx: RunCtx): Promise<string | null> {
  const { db, now } = ctx.deps;
  const [{ data: c }, { data: ct }, { data: ag }] = await Promise.all([
    db.from('conversations').select('status, archived_at, ai_paused_until').eq('id', ctx.conv.id).maybeSingle(),
    db.from('contacts').select('opted_out_at, anonymized_at').eq('id', ctx.contact.id).maybeSingle(),
    ctx.agent
      ? db.from('ai_agents').select('enabled, mode, paused_at').eq('id', ctx.agent.id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const conv = c as Row;
  const contact = ct as Row;
  const agent = ag as Row;
  if (!conv || conv.status === 'closed' || conv.archived_at) return 'conversation_closed';
  if (isPausedUntil(conv.ai_paused_until, now())) return 'ai_paused';
  if (!contact || contact.opted_out_at || contact.anonymized_at) return 'contact_opted_out';
  if (!agent || !agent.enabled || agent.mode !== 'auto' || agent.paused_at) return 'agent_paused';
  if (!(await aiSettingsEnabled(db, ctx.job.account_id))) return 'ai_disabled';
  return null;
}

async function sendParts(ctx: RunCtx, parts: string[], started: Date): Promise<JobOutcome> {
  const { deps, job, conv, contact } = ctx;
  for (let i = job.sent_parts; i < parts.length; i++) {
    const wait =
      i === 0 ? typingDelayMs(parts[0].length, deps.now().getTime() - started.getTime()) : bubbleGapMs(deps.random);
    if (wait > 0) await deps.sleep(wait);
    await deps.pace(job.account_id, conv.channel ?? null);
    const stop = await stillAnswering(ctx);
    if (stop) return skip(deps.db, job.id, stop);
    // Heartbeat: a live job is never reaped as stale.
    await patchJob(deps.db, job.id, { sent_parts: i });
    try {
      await deps.send({ accountId: job.account_id, userId: conv.user_id, conversationId: conv.id, contactId: contact.id, text: parts[i] });
    } catch (err) {
      if (!isUncertainSend(err)) throw err; // not sent: the retry resumes at this bubble
      // It may have gone out: never send it again; the team takes over.
      console.warn('[ai/auto-reply] uncertain send, handing over:', conv.id, errText(err));
      await patchJob(deps.db, job.id, { sent_parts: i + 1, last_error: errText(err) });
      return handOff(ctx, { reason: 'Não foi possível confirmar o envio da resposta da IA', notify: false });
    }
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
 * Hand the conversation to the team. With `notify`, tell the customer
 * first (normal send path; failure → notified=false). Then pause the AI
 * for good, move an open conversation to pending (assignment untouched:
 * an unassigned one stays in the queue), and leave the card + pill.
 */
export async function handOff(
  ctx: RunCtx,
  info: { reason: string; customerWants?: string | null; lastWords?: string; notify: boolean; finish?: boolean },
): Promise<JobOutcome> {
  const { deps, job, conv, contact, agent } = ctx;
  const { db } = deps;
  let notified = false;
  if (info.notify) {
    try {
      await deps.pace(job.account_id, conv.channel ?? null);
      await deps.send({
        accountId: job.account_id,
        userId: conv.user_id,
        conversationId: conv.id,
        contactId: contact.id,
        text: agent?.handoff_message?.trim() || DEFAULT_HANDOFF_MESSAGE,
      });
      notified = true;
    } catch (err) {
      console.warn('[ai/auto-reply] hand-over notice not sent:', conv.id, errText(err));
    }
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
    agent_id: agent?.id ?? job.agent_id,
    job_id: job.id,
    reason: info.reason.slice(0, 300),
    customer_wants: info.customerWants?.slice(0, 300) ?? null,
    last_customer_words: info.lastWords ? info.lastWords.slice(-600) : null,
    notified,
  });
  if (error) console.error('[ai/auto-reply] hand-over insert failed:', error.message);
  await event(db, job.account_id, conv.id, 'ai_handoff', { reason: info.reason.slice(0, 300) });
  if (info.finish !== false) await patchJob(db, job.id, { status: 'done', outcome: 'handoff', reply_parts: null });
  return 'handoff';
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
