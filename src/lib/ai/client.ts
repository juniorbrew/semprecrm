// ============================================================
// Provider clients — server only. Built per call from the account's
// own key; never from env vars (there is no platform key).
// ============================================================

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';

import type { AiErrorCode } from './errors';
import type { AiProvider } from './providers';

export function createLanguageModel(provider: AiProvider, apiKey: string, model: string): LanguageModel {
  if (provider === 'anthropic') return createAnthropic({ apiKey })(model);
  return createOpenAI({ apiKey })(model);
}

export type KeyValidation =
  | { ok: true; models: string[] }
  | { ok: false; code: Extract<AiErrorCode, 'invalid_key' | 'quota' | 'rate_limited' | 'timeout' | 'provider_unavailable'> };

const VALIDATE_TIMEOUT_MS = 10_000;

/**
 * Check a key with the provider's model-list endpoint: it requires a
 * valid key, costs nothing and returns the models the key can use.
 */
export async function validateProviderKey(
  provider: AiProvider,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<KeyValidation> {
  const key = apiKey.trim();
  const url =
    provider === 'anthropic' ? 'https://api.anthropic.com/v1/models?limit=100' : 'https://api.openai.com/v1/models';
  const headers: Record<string, string> =
    provider === 'anthropic'
      ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
      : { Authorization: `Bearer ${key}` };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), VALIDATE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { method: 'GET', headers, signal: ctrl.signal, cache: 'no-store' });
    if (res.status === 401 || res.status === 403) return { ok: false, code: 'invalid_key' };
    if (res.status === 402) return { ok: false, code: 'quota' };
    if (res.status === 429) return { ok: false, code: 'rate_limited' };
    if (res.status >= 500) return { ok: false, code: 'provider_unavailable' };
    if (!res.ok) return { ok: false, code: 'invalid_key' };
    const json = (await res.json().catch(() => null)) as { data?: { id?: unknown }[] } | null;
    const models = (json?.data ?? [])
      .map((m) => (typeof m.id === 'string' ? m.id : ''))
      .filter(Boolean)
      .sort();
    return { ok: true, models };
  } catch (err) {
    const name = (err as { name?: unknown } | null)?.name;
    return { ok: false, code: name === 'AbortError' ? 'timeout' : 'provider_unavailable' };
  } finally {
    clearTimeout(timer);
  }
}
