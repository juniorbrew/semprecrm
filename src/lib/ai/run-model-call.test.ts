import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APICallError } from 'ai';
import type { SupabaseClient } from '@supabase/supabase-js';

const generateText = vi.hoisted(() => vi.fn());
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText,
}));

const store = vi.hoisted(() => ({
  loadAiSettings: vi.fn(),
  loadDecryptedKey: vi.fn(),
  usageSummarySince: vi.fn(),
  recordUsage: vi.fn(),
}));
vi.mock('./store', () => store);

import { AiError } from './errors';
import { runModelCall } from './run-model-call';

const db = {} as SupabaseClient;
const SETTINGS = {
  account_id: 'acc-1',
  enabled: true,
  provider: 'openai',
  model: 'gpt-4.1-mini',
  instructions: null,
  monthly_budget_cents: 100,
  suggest_history_messages: 20,
  consent_provider: 'openai',
  consented_by: 'u',
  consented_at: '2026-09-01T00:00:00Z',
};

function call(overrides: Partial<Parameters<typeof runModelCall>[0]> = {}) {
  return runModelCall({
    db,
    accountId: 'acc-1',
    userId: 'user-1',
    conversationId: 'conv-1',
    feature: 'suggest_reply',
    system: 'sys',
    prompt: 'prompt',
    now: () => new Date('2026-09-28T12:00:00Z'),
    ...overrides,
  });
}

beforeEach(() => {
  store.loadAiSettings.mockResolvedValue(SETTINGS);
  store.loadDecryptedKey.mockResolvedValue('sk-test-key-000000000000000000');
  store.usageSummarySince.mockResolvedValue({ calls: 3, errors: 0, inputTokens: 0, outputTokens: 0, costCents: 10 });
  store.recordUsage.mockResolvedValue(undefined);
});

describe('runModelCall', () => {
  it('success: returns text and records usage with cost (no text stored)', async () => {
    generateText.mockResolvedValue({ text: '  Olá! Posso ajudar?  ', usage: { inputTokens: 1000, outputTokens: 50 } });
    const r = await call();
    expect(r.text).toBe('Olá! Posso ajudar?');
    expect(generateText).toHaveBeenCalledOnce();
    const args = generateText.mock.calls[0][0];
    expect(args.maxOutputTokens).toBe(600);
    expect(args.abortSignal).toBeInstanceOf(AbortSignal);
    expect(args.providerOptions).toEqual({ openai: { store: false } });

    expect(store.usageSummarySince).toHaveBeenCalledWith(db, 'acc-1', new Date('2026-09-01T03:00:00.000Z'));
    expect(store.recordUsage).toHaveBeenCalledOnce();
    const rec = store.recordUsage.mock.calls[0][1];
    expect(rec).toMatchObject({
      accountId: 'acc-1',
      userId: 'user-1',
      conversationId: 'conv-1',
      feature: 'suggest_reply',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      inputTokens: 1000,
      outputTokens: 50,
      status: 'ok',
      errorCode: null,
    });
    expect(rec.costCents).toBeCloseTo(0.048, 4);
    expect(JSON.stringify(rec)).not.toContain('Olá');
    expect(JSON.stringify(rec)).not.toContain('prompt');
  });

  it('budget exceeded: blocks BEFORE calling the provider and records a blocked row', async () => {
    store.usageSummarySince.mockResolvedValue({ calls: 9, errors: 0, inputTokens: 0, outputTokens: 0, costCents: 100 });
    await expect(call()).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(generateText).not.toHaveBeenCalled();
    expect(store.recordUsage.mock.calls[0][1]).toMatchObject({ status: 'blocked', errorCode: 'budget_exceeded' });
  });

  it('not enabled / no consent for this provider / no key → refuses without calling', async () => {
    store.loadAiSettings.mockResolvedValueOnce({ ...SETTINGS, enabled: false });
    await expect(call()).rejects.toMatchObject({ code: 'not_enabled' });
    store.loadAiSettings.mockResolvedValueOnce({ ...SETTINGS, consent_provider: 'anthropic' });
    await expect(call()).rejects.toMatchObject({ code: 'not_enabled' });
    store.loadAiSettings.mockResolvedValueOnce(null);
    await expect(call()).rejects.toMatchObject({ code: 'not_enabled' });
    store.loadDecryptedKey.mockResolvedValueOnce(null);
    await expect(call()).rejects.toMatchObject({ code: 'no_key' });
    expect(generateText).not.toHaveBeenCalled();
    expect(store.recordUsage).not.toHaveBeenCalled();
  });

  it('provider errors are mapped and recorded as error rows', async () => {
    generateText.mockRejectedValueOnce(
      new APICallError({ message: 'bad key', url: 'u', requestBodyValues: {}, statusCode: 401, responseBody: 'Incorrect API key' }),
    );
    const err = await call().catch((e) => e);
    expect(err).toBeInstanceOf(AiError);
    expect(err.code).toBe('invalid_key');
    expect(err.message).toMatch(/rejected the API key/);
    expect(store.recordUsage.mock.calls[0][1]).toMatchObject({ status: 'error', errorCode: 'invalid_key', costCents: 0 });

    generateText.mockRejectedValueOnce(
      new APICallError({ message: 'slow down', url: 'u', requestBodyValues: {}, statusCode: 429, responseBody: 'Rate limit reached' }),
    );
    await expect(call()).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('times out through the abort signal', async () => {
    generateText.mockImplementationOnce(
      ({ abortSignal }: { abortSignal: AbortSignal }) =>
        new Promise((_, reject) => {
          abortSignal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    );
    await expect(call({ timeoutMs: 10 })).rejects.toMatchObject({ code: 'timeout' });
    expect(store.recordUsage.mock.calls[0][1]).toMatchObject({ status: 'error', errorCode: 'timeout' });
  });

  it('client cancel is reported as cancelled', async () => {
    const ctrl = new AbortController();
    generateText.mockImplementationOnce(
      ({ abortSignal }: { abortSignal: AbortSignal }) =>
        new Promise((_, reject) => {
          abortSignal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
          ctrl.abort();
        }),
    );
    await expect(call({ signal: ctrl.signal })).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('empty text is an error (tokens still recorded)', async () => {
    generateText.mockResolvedValueOnce({ text: '   ', usage: { inputTokens: 10, outputTokens: 0 } });
    await expect(call()).rejects.toMatchObject({ code: 'empty_response' });
    expect(store.recordUsage.mock.calls[0][1]).toMatchObject({ status: 'error', errorCode: 'empty_response', inputTokens: 10 });
  });
});
