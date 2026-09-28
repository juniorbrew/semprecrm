// ============================================================
// AI error vocabulary — one code per ACTION the user can take
// (enable AI, fix the key, top up credit, wait, pick another model).
//
// Messages are English keys, like every API error in this app; the
// pt-BR text lives in src/lib/i18n-dict/ai.ts and the UI shows them
// through `t()`. Codes go to `ai_usage.error_code` — never the raw
// provider message (it can echo the prompt or the key).
// ============================================================

import { APICallError, RetryError } from 'ai';

export const AI_ERROR_CODES = [
  'module_not_included',
  'not_enabled',
  'no_key',
  'budget_exceeded',
  'invalid_key',
  'quota',
  'rate_limited',
  'timeout',
  'model_not_found',
  'provider_unavailable',
  'empty_response',
  'cancelled',
  'unknown',
] as const;
export type AiErrorCode = (typeof AI_ERROR_CODES)[number];

export const AI_ERROR_MESSAGES: Record<AiErrorCode, string> = {
  module_not_included: 'The AI assistant is not included in your plan.',
  not_enabled:
    'AI is not enabled for this account. An admin can turn it on in Settings → Artificial Intelligence.',
  no_key:
    'No API key is saved for the selected AI provider. An admin can add one in Settings → Artificial Intelligence.',
  budget_exceeded:
    "This month's AI budget has been used up. An admin can raise it in Settings → Artificial Intelligence.",
  invalid_key:
    'The AI provider rejected the API key. An admin needs to check or replace it in Settings → Artificial Intelligence.',
  quota: 'The AI provider account has no credit or quota left. Check the billing with the provider.',
  rate_limited: 'The AI provider is limiting requests for this key. Try again in a minute.',
  timeout: 'The AI provider took too long to answer. Try again.',
  model_not_found:
    'The configured AI model does not exist or is not available for this key. Pick another model in Settings → Artificial Intelligence.',
  provider_unavailable: 'The AI provider is unavailable right now. Try again in a few minutes.',
  empty_response: 'The AI did not return a suggestion. Try again.',
  cancelled: 'The suggestion was cancelled.',
  unknown: 'Could not generate the suggestion. Try again.',
};

const AI_ERROR_STATUS: Record<AiErrorCode, number> = {
  module_not_included: 403,
  not_enabled: 409,
  no_key: 409,
  budget_exceeded: 402,
  invalid_key: 422,
  quota: 422,
  rate_limited: 429,
  timeout: 504,
  model_not_found: 422,
  provider_unavailable: 502,
  empty_response: 502,
  cancelled: 499,
  unknown: 502,
};

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly status: number;
  constructor(code: AiErrorCode) {
    super(AI_ERROR_MESSAGES[code]);
    this.name = 'AiError';
    this.code = code;
    this.status = AI_ERROR_STATUS[code];
  }
}

function statusOf(err: unknown): number | null {
  if (APICallError.isInstance(err)) return err.statusCode ?? null;
  const s = (err as { statusCode?: unknown; status?: unknown } | null)?.statusCode
    ?? (err as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : null;
}

function textOf(err: unknown): string {
  const parts: string[] = [];
  if (err instanceof Error) parts.push(err.message);
  if (APICallError.isInstance(err) && typeof err.responseBody === 'string') {
    parts.push(err.responseBody);
  }
  return parts.join(' ').toLowerCase();
}

function isAbort(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/**
 * Classify anything the provider call threw. `timedOut` tells a timeout
 * abort apart from the user pressing "cancel".
 */
export function mapProviderError(err: unknown, opts: { timedOut?: boolean } = {}): AiErrorCode {
  if (err instanceof AiError) return err.code;
  // The SDK wraps the last attempt when retries run out.
  if (RetryError.isInstance(err)) {
    if (err.reason === 'abort') return opts.timedOut ? 'timeout' : 'cancelled';
    return mapProviderError(err.lastError, opts);
  }
  if (isAbort(err)) return opts.timedOut ? 'timeout' : 'cancelled';

  const status = statusOf(err);
  const text = textOf(err);

  if (status === 401 || status === 403 || /invalid.{0,20}api.?key|incorrect api key|authentication/.test(text)) {
    return 'invalid_key';
  }
  if (/insufficient_quota|exceeded your current quota|credit balance|billing|payment required/.test(text) || status === 402) {
    return 'quota';
  }
  if (status === 429 || /rate.?limit/.test(text)) return 'rate_limited';
  if (status === 404 || /model.{0,40}(not.?found|does not exist|not available)|not_found_error/.test(text)) {
    return 'model_not_found';
  }
  if (status === 408 || /timed? ?out|etimedout/.test(text)) return 'timeout';
  if ((status !== null && status >= 500) || /overloaded|fetch failed|econnrefused|econnreset|enotfound|network/.test(text)) {
    return 'provider_unavailable';
  }
  return 'unknown';
}
