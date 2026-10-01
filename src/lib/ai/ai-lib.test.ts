import { describe, expect, it } from 'vitest';
import { APICallError, RetryError } from 'ai';

import { decrypt } from '@/lib/whatsapp/encryption';
import { budgetMonthKey, crossesBudgetAlert, isBudgetExhausted, monthStartInTimeZone } from './budget';
import { AiError, mapProviderError } from './errors';
import { computeCostCents, MODEL_PRICES, resolveModelPrice, UNKNOWN_MODEL_PRICE } from './pricing';
import { AI_DEFAULT_MODELS, isValidModelId, modelMatchesProvider, parseBudgetInput } from './providers';
import { AI_SETTINGS_ERRORS, parseAiSettingsUpdate } from './settings';
import { encryptApiKey, isPlausibleApiKey, keyLast4, type AiSettingsRow } from './store';

const KEY = 'sk-proj-THISISASECRETKEY1234567890abcdWXYZ';

describe('API key encryption', () => {
  it('round-trips through AES-GCM and exposes only the last 4 chars', () => {
    const { api_key_enc, last4 } = encryptApiKey(`  ${KEY}  `);
    expect(last4).toBe('WXYZ');
    expect(api_key_enc).not.toContain(KEY);
    expect(api_key_enc).not.toContain('SECRET');
    expect(api_key_enc.split(':')).toHaveLength(3);
    expect(decrypt(api_key_enc)).toBe(KEY);
  });

  it('uses a fresh IV per encryption', () => {
    expect(encryptApiKey(KEY).api_key_enc).not.toBe(encryptApiKey(KEY).api_key_enc);
  });

  it('last4 and plausibility', () => {
    expect(keyLast4('abc')).toBe('abc');
    expect(isPlausibleApiKey(KEY)).toBe(true);
    expect(isPlausibleApiKey('short')).toBe(false);
    expect(isPlausibleApiKey('sk has spaces inside the key 123456')).toBe(false);
    expect(isPlausibleApiKey(42)).toBe(false);
  });
});

describe('monthly budget window (America/Sao_Paulo)', () => {
  it('starts at local midnight of the 1st (UTC-3)', () => {
    expect(monthStartInTimeZone(new Date('2026-09-15T12:00:00Z')).toISOString()).toBe('2026-09-01T03:00:00.000Z');
  });

  it('late evening of the last day is still the previous month in São Paulo', () => {
    // 2026-10-01T01:00Z = 30/09 22:00 in São Paulo.
    const now = new Date('2026-10-01T01:00:00Z');
    expect(monthStartInTimeZone(now).toISOString()).toBe('2026-09-01T03:00:00.000Z');
    expect(budgetMonthKey(now)).toBe('2026-09');
  });

  it('rolls over at São Paulo midnight, not UTC midnight', () => {
    const now = new Date('2026-10-01T03:00:00Z');
    expect(monthStartInTimeZone(now).toISOString()).toBe('2026-10-01T03:00:00.000Z');
    expect(budgetMonthKey(now)).toBe('2026-10');
  });

  it('handles January and other zones', () => {
    expect(monthStartInTimeZone(new Date('2027-01-01T02:59:00Z')).toISOString()).toBe('2026-12-01T03:00:00.000Z');
    expect(monthStartInTimeZone(new Date('2026-07-10T00:00:00Z'), 'UTC').toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('exhausted when spend reaches the budget; 0 budget blocks', () => {
    expect(isBudgetExhausted(99.99, 100)).toBe(false);
    expect(isBudgetExhausted(100, 100)).toBe(true);
    expect(isBudgetExhausted(0, 0)).toBe(true);
    // 80% alert line: before the call below it, after the call at / above it
    expect(crossesBudgetAlert(79, 80, 100)).toBe(true);
    expect(crossesBudgetAlert(79, 95, 100)).toBe(true); // parallel calls landed meanwhile
    expect(crossesBudgetAlert(70, 75, 100)).toBe(false);
    expect(crossesBudgetAlert(80, 81, 100)).toBe(false);
    expect(crossesBudgetAlert(0, 0, 0)).toBe(false);
  });
});

describe('pricing', () => {
  it('prices known models and dated snapshots', () => {
    expect(resolveModelPrice('gpt-4o-mini')).toEqual({ price: { input: 15, output: 60 }, known: true });
    expect(resolveModelPrice('gpt-4o-mini-2024-07-18').price.input).toBe(15);
    expect(resolveModelPrice('claude-haiku-4-5-20251001').price).toEqual({ input: 100, output: 500 });
  });

  it('charges unknown models at the conservative default', () => {
    expect(resolveModelPrice('some-new-model')).toEqual({ price: UNKNOWN_MODEL_PRICE, known: false });
    // No generic prefix fallback: a pricier sibling is never priced as its base.
    expect(resolveModelPrice('gpt-5-pro-preview').known).toBe(false);
    expect(resolveModelPrice('claude-opus-4-9').known).toBe(false);
    for (const p of Object.values(MODEL_PRICES)) {
      expect(UNKNOWN_MODEL_PRICE.input).toBeGreaterThanOrEqual(p.input);
      expect(UNKNOWN_MODEL_PRICE.output).toBeGreaterThanOrEqual(p.output);
    }
  });

  it('prices the expensive tiers explicitly', () => {
    expect(resolveModelPrice('claude-opus-4-1').price).toEqual({ input: 1500, output: 7500 });
    expect(resolveModelPrice('claude-opus-4-1-20250805').price).toEqual({ input: 1500, output: 7500 });
    expect(resolveModelPrice('claude-opus-4-0').price).toEqual({ input: 1500, output: 7500 });
    expect(resolveModelPrice('claude-opus-4-20250514').price).toEqual({ input: 1500, output: 7500 });
    expect(resolveModelPrice('gpt-5-pro').price.output).toBe(12000);
    expect(resolveModelPrice('o1-pro').price.input).toBe(15000);
    expect(resolveModelPrice('o3-pro').price.input).toBe(2000);
    expect(resolveModelPrice('gpt-5').price.input).toBe(125);
    expect(resolveModelPrice('claude-opus-5-5').known).toBe(true);
    expect(resolveModelPrice('claude-sonnet-4-5-latest').known).toBe(true);
  });

  it('computes cents and rounds up', () => {
    // 1M in + 1M out on gpt-4.1-mini = 40 + 160 cents.
    expect(computeCostCents('gpt-4.1-mini', 1_000_000, 1_000_000)).toBe(200);
    expect(computeCostCents('gpt-4.1-mini', 1, 0)).toBe(0.0001);
    expect(computeCostCents('gpt-4.1-mini', 0, 0)).toBe(0);
    expect(computeCostCents('gpt-4.1-mini', -5, Number.NaN)).toBe(0);
  });

  it('default models are priced', () => {
    for (const m of Object.values(AI_DEFAULT_MODELS)) {
      expect(resolveModelPrice(m).known).toBe(true);
      expect(isValidModelId(m)).toBe(true);
    }
  });
});

function apiError(statusCode: number, body = '') {
  return new APICallError({
    message: `HTTP ${statusCode}`,
    url: 'https://api.example/v1',
    requestBodyValues: {},
    statusCode,
    responseBody: body,
  });
}

describe('mapProviderError', () => {
  it('maps provider HTTP errors to action codes', () => {
    expect(mapProviderError(apiError(401))).toBe('invalid_key');
    expect(mapProviderError(apiError(429, '{"error":{"code":"insufficient_quota"}}'))).toBe('quota');
    expect(mapProviderError(apiError(400, 'Your credit balance is too low'))).toBe('quota');
    expect(mapProviderError(apiError(429, 'rate limit reached'))).toBe('rate_limited');
    expect(mapProviderError(apiError(404, 'model not found'))).toBe('model_not_found');
    expect(mapProviderError(apiError(529, 'overloaded'))).toBe('provider_unavailable');
    expect(mapProviderError(apiError(500))).toBe('provider_unavailable');
  });

  it('unwraps RetryError and tells timeout from cancel', () => {
    const retry = new RetryError({ message: 'x', reason: 'maxRetriesExceeded', errors: [apiError(503)] });
    expect(mapProviderError(retry)).toBe('provider_unavailable');
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(mapProviderError(abort, { timedOut: true })).toBe('timeout');
    expect(mapProviderError(abort, { timedOut: false })).toBe('cancelled');
    expect(mapProviderError(new TypeError('fetch failed'))).toBe('provider_unavailable');
    expect(mapProviderError(new Error('???'))).toBe('unknown');
    expect(mapProviderError(new AiError('no_key'))).toBe('no_key');
  });
});

const BASE: AiSettingsRow = {
  account_id: 'a',
  enabled: false,
  provider: 'openai',
  model: 'gpt-4.1-mini',
  instructions: null,
  monthly_budget_cents: 1000,
  suggest_history_messages: 20,
  consent_provider: null,
  consented_by: null,
  consented_at: null,
};
const NOW = new Date('2026-09-28T12:00:00Z');

describe('parseAiSettingsUpdate', () => {
  const keys = new Set(['openai'] as const);

  it('refuses to enable without consent, then with consent but without a key', () => {
    expect(parseAiSettingsUpdate(BASE, { enabled: true }, keys, NOW)).toEqual({
      ok: false,
      error: AI_SETTINGS_ERRORS.needsConsent,
    });
    expect(
      parseAiSettingsUpdate(BASE, { enabled: true, accept_consent: true }, new Set(), NOW),
    ).toEqual({ ok: false, error: AI_SETTINGS_ERRORS.needsKey });
  });

  it('enables with consent + key and stamps the consent for the provider', () => {
    const r = parseAiSettingsUpdate(BASE, { enabled: true, accept_consent: true }, keys, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.write.enabled).toBe(true);
    expect(r.write.consent_provider).toBe('openai');
    expect(r.write.consented_at).toBe(NOW.toISOString());
    expect(r.consentChanged).toBe(true);
  });

  it('switching provider drops consent validity and turns AI off silently', () => {
    const on: AiSettingsRow = { ...BASE, enabled: true, consent_provider: 'openai', consented_at: NOW.toISOString() };
    const r = parseAiSettingsUpdate(on, { provider: 'anthropic' }, new Set(['openai', 'anthropic']), NOW);
    expect(r.ok && r.write.enabled).toBe(false);
    expect(r.ok && r.write.model).toBe(AI_DEFAULT_MODELS.anthropic);
  });

  it('revoking consent disables AI', () => {
    const on: AiSettingsRow = { ...BASE, enabled: true, consent_provider: 'openai', consented_at: NOW.toISOString() };
    const r = parseAiSettingsUpdate(on, { accept_consent: false }, keys, NOW);
    expect(r.ok && r.write.enabled).toBe(false);
    expect(r.ok && r.write.consented_at).toBe(null);
  });

  it('rejects a model from the other provider', () => {
    expect(parseAiSettingsUpdate(BASE, { model: 'claude-haiku-4-5' }, keys)).toEqual({ ok: false, error: AI_SETTINGS_ERRORS.modelProvider });
    expect(parseAiSettingsUpdate(BASE, { provider: 'anthropic', model: 'gpt-4.1-mini' }, keys)).toEqual({
      ok: false,
      error: AI_SETTINGS_ERRORS.modelProvider,
    });
    expect(modelMatchesProvider('openai', 'o3-mini')).toBe(true);
    expect(modelMatchesProvider('anthropic', 'claude-sonnet-5')).toBe(true);
  });

  it('validates fields', () => {
    expect(parseAiSettingsUpdate(BASE, { provider: 'gemini' }, keys)).toEqual({ ok: false, error: AI_SETTINGS_ERRORS.provider });
    expect(parseAiSettingsUpdate(BASE, { model: 'bad model' }, keys)).toEqual({ ok: false, error: AI_SETTINGS_ERRORS.model });
    expect(parseAiSettingsUpdate(BASE, { monthly_budget_cents: 1.5 }, keys)).toEqual({ ok: false, error: AI_SETTINGS_ERRORS.budget });
    expect(parseAiSettingsUpdate(BASE, { suggest_history_messages: 0 }, keys)).toEqual({ ok: false, error: AI_SETTINGS_ERRORS.history });
    expect(parseAiSettingsUpdate(BASE, { instructions: 'x'.repeat(4001) }, keys)).toEqual({ ok: false, error: AI_SETTINGS_ERRORS.instructions });
    expect(parseAiSettingsUpdate(BASE, [], keys)).toEqual({ ok: false, error: AI_SETTINGS_ERRORS.body });
    const ok = parseAiSettingsUpdate(null, { provider: 'anthropic', model: 'claude-sonnet-5', monthly_budget_cents: 0 }, keys);
    expect(ok.ok && ok.write).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5', monthly_budget_cents: 0, enabled: false });
  });
});

describe('parseBudgetInput', () => {
  it.each([
    ['10', 1000],
    ['10,5', 1050],
    ['1.000,50', 100050],
    ['1.000', 100000],
    ['1000.50', 100050],
    ['1,000.50', 100050],
    ['US$ 25,00', 2500],
    ['0', 0],
  ])('%s -> %i cents', (raw, cents) => {
    expect(parseBudgetInput(raw)).toBe(cents);
  });

  it.each(['', 'abc', '-5', '1,2,3', '10,555', '99999999'])('rejects %s', (raw) => {
    expect(parseBudgetInput(raw)).toBeNull();
  });
});
