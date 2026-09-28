// ============================================================
// AI persistence — server only. Every function takes the SERVICE-ROLE
// client: `ai_provider_credentials` is not readable by any signed-in
// user, and `ai_usage` is written only by the server. Callers resolve
// `accountId` from the session, never from the request body.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import { isAiProvider, type AiFeature, type AiProvider } from './providers';

export interface AiSettingsRow {
  account_id: string;
  enabled: boolean;
  provider: AiProvider | null;
  model: string | null;
  instructions: string | null;
  monthly_budget_cents: number;
  suggest_history_messages: number;
  consent_provider: AiProvider | null;
  consented_by: string | null;
  consented_at: string | null;
  updated_at?: string | null;
}

export const AI_SETTINGS_COLUMNS =
  'account_id, enabled, provider, model, instructions, monthly_budget_cents, suggest_history_messages, consent_provider, consented_by, consented_at, updated_at';

export interface AiCredentialPublic {
  provider: AiProvider;
  last4: string;
  validated_at: string | null;
  updated_at: string | null;
}

export interface AiUsageSummary {
  calls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}

export interface AiUsageRecord {
  accountId: string;
  userId: string | null;
  conversationId: string | null;
  feature: AiFeature;
  provider: AiProvider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  status: 'ok' | 'error' | 'blocked';
  errorCode: string | null;
  latencyMs: number | null;
}

// ------------------------------------------------------------
// Keys
// ------------------------------------------------------------

/** Last four characters — the ONLY part of a key that ever leaves the server. */
export function keyLast4(apiKey: string): string {
  return apiKey.trim().slice(-4);
}

/**
 * Basic shape check before we spend a network call: no whitespace,
 * sane length. Provider-specific prefixes are not enforced (they have
 * changed before).
 */
export function isPlausibleApiKey(apiKey: unknown): apiKey is string {
  return typeof apiKey === 'string' && /^\S{20,300}$/.test(apiKey.trim());
}

export function encryptApiKey(apiKey: string): { api_key_enc: string; last4: string } {
  const trimmed = apiKey.trim();
  return { api_key_enc: encrypt(trimmed), last4: keyLast4(trimmed) };
}

export async function loadDecryptedKey(
  db: SupabaseClient,
  accountId: string,
  provider: AiProvider,
): Promise<string | null> {
  const { data, error } = await db
    .from('ai_provider_credentials')
    .select('api_key_enc')
    .eq('account_id', accountId)
    .eq('provider', provider)
    .maybeSingle();
  if (error) throw new Error(`ai credential lookup failed: ${error.message}`);
  if (!data?.api_key_enc) return null;
  return decrypt(data.api_key_enc as string);
}

export async function saveCredential(
  db: SupabaseClient,
  args: { accountId: string; provider: AiProvider; apiKey: string; userId: string; validatedAt: string },
): Promise<AiCredentialPublic> {
  const { api_key_enc, last4 } = encryptApiKey(args.apiKey);
  const { data, error } = await db
    .from('ai_provider_credentials')
    .upsert(
      {
        account_id: args.accountId,
        provider: args.provider,
        api_key_enc,
        last4,
        validated_at: args.validatedAt,
        created_by: args.userId,
      },
      { onConflict: 'account_id,provider' },
    )
    .select('provider, last4, validated_at, updated_at')
    .single();
  if (error || !data) throw new Error(`ai credential save failed: ${error?.message ?? 'no row'}`);
  return data as AiCredentialPublic;
}

export async function markCredentialValidated(
  db: SupabaseClient,
  accountId: string,
  provider: AiProvider,
  validatedAt: string,
): Promise<void> {
  const { error } = await db
    .from('ai_provider_credentials')
    .update({ validated_at: validatedAt })
    .eq('account_id', accountId)
    .eq('provider', provider);
  if (error) throw new Error(`ai credential update failed: ${error.message}`);
}

export async function deleteCredential(
  db: SupabaseClient,
  accountId: string,
  provider: AiProvider,
): Promise<boolean> {
  const { data, error } = await db
    .from('ai_provider_credentials')
    .delete()
    .eq('account_id', accountId)
    .eq('provider', provider)
    .select('id');
  if (error) throw new Error(`ai credential delete failed: ${error.message}`);
  return (data ?? []).length > 0;
}

export async function listCredentials(
  db: SupabaseClient,
  accountId: string,
): Promise<AiCredentialPublic[]> {
  const { data, error } = await db
    .from('ai_provider_credentials')
    .select('provider, last4, validated_at, updated_at')
    .eq('account_id', accountId);
  if (error) throw new Error(`ai credential list failed: ${error.message}`);
  return ((data ?? []) as AiCredentialPublic[]).filter((c) => isAiProvider(c.provider));
}

export async function hasCredential(
  db: SupabaseClient,
  accountId: string,
  provider: AiProvider,
): Promise<boolean> {
  const { data, error } = await db
    .from('ai_provider_credentials')
    .select('id')
    .eq('account_id', accountId)
    .eq('provider', provider)
    .maybeSingle();
  if (error) throw new Error(`ai credential lookup failed: ${error.message}`);
  return !!data;
}

// ------------------------------------------------------------
// Settings
// ------------------------------------------------------------

export async function loadAiSettings(
  db: SupabaseClient,
  accountId: string,
): Promise<AiSettingsRow | null> {
  const { data, error } = await db
    .from('ai_settings')
    .select(AI_SETTINGS_COLUMNS)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw new Error(`ai settings lookup failed: ${error.message}`);
  return (data as AiSettingsRow | null) ?? null;
}

// ------------------------------------------------------------
// Usage
// ------------------------------------------------------------

export async function usageSummarySince(
  db: SupabaseClient,
  accountId: string,
  since: Date,
): Promise<AiUsageSummary> {
  const { data, error } = await db.rpc('ai_usage_summary', {
    p_account_id: accountId,
    p_since: since.toISOString(),
  });
  if (error) throw new Error(`ai usage summary failed: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as
    | { calls?: unknown; errors?: unknown; input_tokens?: unknown; output_tokens?: unknown; cost_cents?: unknown }
    | null
    | undefined;
  const n = (v: unknown) => {
    const x = typeof v === 'number' ? v : Number(v ?? 0);
    return Number.isFinite(x) ? x : 0;
  };
  return {
    calls: n(row?.calls),
    errors: n(row?.errors),
    inputTokens: n(row?.input_tokens),
    outputTokens: n(row?.output_tokens),
    costCents: n(row?.cost_cents),
  };
}

/** Append one ledger row. Never throws — a failed ledger write is logged. */
export async function recordUsage(db: SupabaseClient, rec: AiUsageRecord): Promise<void> {
  try {
    const { error } = await db.from('ai_usage').insert({
      account_id: rec.accountId,
      user_id: rec.userId,
      conversation_id: rec.conversationId,
      feature: rec.feature,
      provider: rec.provider,
      model: rec.model,
      input_tokens: Math.max(0, Math.round(rec.inputTokens)),
      output_tokens: Math.max(0, Math.round(rec.outputTokens)),
      cost_cents: Math.max(0, rec.costCents),
      status: rec.status,
      error_code: rec.errorCode,
      latency_ms: rec.latencyMs,
    });
    if (error) console.error('[ai] usage insert failed:', error.message);
  } catch (err) {
    console.error('[ai] usage insert threw:', err instanceof Error ? err.message : err);
  }
}
