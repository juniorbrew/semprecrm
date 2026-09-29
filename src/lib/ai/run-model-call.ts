// ============================================================
// runModelCall — the ONE seam every AI feature goes through.
//
//   1. load the account's settings + key server-side (service role)
//   2. refuse unless enabled, consented for this provider, and keyed
//   3. refuse when this month's spend (America/Sao_Paulo, derived from
//      `ai_usage`) has reached the budget — BEFORE any byte leaves
//   4. call the provider with a timeout and an output-token cap
//   5. record the call in `ai_usage` — on success AND on error — with
//      tokens/cost/status only (no prompt, no response text)
//   6. map provider failures to our error codes (see ./errors.ts)
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { generateText } from 'ai';

import { monthStartInTimeZone, isBudgetExhausted } from './budget';
import { createLanguageModel } from './client';
import { AiError, mapProviderError, type AiErrorCode } from './errors';
import { computeCostCents } from './pricing';
import type { AiFeature, AiProvider } from './providers';
import { loadAiSettings, loadDecryptedKey, recordUsage, usageSummarySince } from './store';

export const AI_CALL_TIMEOUT_MS = 30_000;
export const AI_DEFAULT_MAX_OUTPUT_TOKENS = 600;
/** Reasoning models spend output tokens thinking before the text. */
export const AI_REASONING_MAX_OUTPUT_TOKENS = 4000;

type ProviderOptions = Record<string, Record<string, string | boolean>>;

/**
 * Per-model call profile. Reasoning models (OpenAI gpt-5* / o-series,
 * Anthropic models with adaptive thinking) get low effort and a bigger
 * output cap — with 600 tokens they can think the whole budget away and
 * return an empty suggestion.
 */
export function callProfile(
  provider: AiProvider,
  model: string,
): { maxOutputTokens: number; providerOptions: ProviderOptions } {
  const id = model.toLowerCase();
  if (provider === 'openai') {
    const reasoning = /^(gpt-5|o\d)/.test(id);
    return {
      maxOutputTokens: reasoning ? AI_REASONING_MAX_OUTPUT_TOKENS : AI_DEFAULT_MAX_OUTPUT_TOKENS,
      // store:false — OpenAI must not retain conversation text (LGPD).
      providerOptions: { openai: reasoning ? { store: false, reasoningEffort: 'low' } : { store: false } },
    };
  }
  const effortCapable = /^claude-(opus-5|fable|sonnet-5|opus-4-[5-8]|sonnet-4-6)/.test(id);
  return {
    maxOutputTokens: effortCapable ? AI_REASONING_MAX_OUTPUT_TOKENS : AI_DEFAULT_MAX_OUTPUT_TOKENS,
    providerOptions: effortCapable ? { anthropic: { effort: 'low' } } : {},
  };
}

/** Rough token estimate (~4 chars/token) for calls that fail mid-way. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Failures where the provider refused before processing the prompt —
// nothing billed. Everything else (timeout, cancel, 5xx, unknown) may
// have consumed the input, so it is charged at the estimated input
// cost; otherwise spamming "cancel" would bypass the budget.
const NOT_BILLED = new Set(['invalid_key', 'quota', 'rate_limited', 'model_not_found']);

export interface RunModelCallInput {
  /** Service-role client. */
  db: SupabaseClient;
  /** From the session — never from the request body. */
  accountId: string;
  userId: string;
  conversationId: string | null;
  feature: AiFeature;
  system: string;
  prompt: string;
  maxOutputTokens?: number;
  /** The prompt carries knowledge-base snippets — flagged in `ai_usage`. */
  kbUsed?: boolean;
  /** Client cancel (request aborted). */
  signal?: AbortSignal;
  /** Injectable for tests. */
  now?: () => Date;
  timeoutMs?: number;
}

export interface RunModelCallResult {
  text: string;
  provider: AiProvider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}

export async function runModelCall(input: RunModelCallInput): Promise<RunModelCallResult> {
  const now = input.now ?? (() => new Date());
  const settings = await loadAiSettings(input.db, input.accountId);

  if (
    !settings ||
    !settings.enabled ||
    !settings.provider ||
    !settings.model ||
    !settings.consented_at ||
    settings.consent_provider !== settings.provider
  ) {
    throw new AiError('not_enabled');
  }
  const provider = settings.provider;
  const model = settings.model;

  const apiKey = await loadDecryptedKey(input.db, input.accountId, provider);
  if (!apiKey) throw new AiError('no_key');

  const base = {
    accountId: input.accountId,
    userId: input.userId,
    conversationId: input.conversationId,
    feature: input.feature,
    provider,
    model,
    kbUsed: input.kbUsed ?? false,
  };

  const spent = await usageSummarySince(input.db, input.accountId, monthStartInTimeZone(now()));
  if (isBudgetExhausted(spent.costCents, settings.monthly_budget_cents)) {
    await recordUsage(input.db, {
      ...base,
      inputTokens: 0,
      outputTokens: 0,
      costCents: 0,
      status: 'blocked',
      errorCode: 'budget_exceeded',
      latencyMs: null,
    });
    throw new AiError('budget_exceeded');
  }

  // Timeout and client-cancel share one abort signal; `timedOut` tells
  // them apart when classifying the failure.
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, input.timeoutMs ?? AI_CALL_TIMEOUT_MS);
  const onClientAbort = () => ctrl.abort();
  if (input.signal) {
    if (input.signal.aborted) ctrl.abort();
    else input.signal.addEventListener('abort', onClientAbort, { once: true });
  }

  const profile = callProfile(provider, model);
  const started = Date.now();
  try {
    const result = await generateText({
      model: createLanguageModel(provider, apiKey, model),
      system: input.system,
      prompt: input.prompt,
      maxOutputTokens: input.maxOutputTokens ?? profile.maxOutputTokens,
      maxRetries: 1,
      abortSignal: ctrl.signal,
      providerOptions: Object.keys(profile.providerOptions).length ? profile.providerOptions : undefined,
    });
    const inputTokens = result.usage?.inputTokens ?? 0;
    const outputTokens = result.usage?.outputTokens ?? 0;
    const costCents = computeCostCents(model, inputTokens, outputTokens);
    const text = (result.text ?? '').trim();

    await recordUsage(input.db, {
      ...base,
      inputTokens,
      outputTokens,
      costCents,
      status: text ? 'ok' : 'error',
      errorCode: text ? null : 'empty_response',
      latencyMs: Date.now() - started,
    });
    if (!text) throw new AiError('empty_response');

    return { text, provider, model, inputTokens, outputTokens, costCents };
  } catch (err) {
    if (err instanceof AiError) throw err;
    const code: AiErrorCode = mapProviderError(err, { timedOut });
    const billed = !NOT_BILLED.has(code);
    const inputTokens = billed ? estimateTokens(input.system) + estimateTokens(input.prompt) : 0;
    await recordUsage(input.db, {
      ...base,
      inputTokens,
      outputTokens: 0,
      costCents: billed ? computeCostCents(model, inputTokens, 0) : 0,
      status: 'error',
      errorCode: code,
      latencyMs: Date.now() - started,
    });
    throw new AiError(code);
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', onClientAbort);
  }
}
