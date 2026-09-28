// ============================================================
// /api/ai/settings — Settings → Inteligência Artificial. Admin+ and
// plan module `ai`.
//
// GET  → settings (defaults when no row yet), saved keys (provider +
//        last4 only, through `ai_provider_credentials_public`) and this
//        month's usage (America/Sao_Paulo calendar month).
// PUT  → partial update; see parseAiSettingsUpdate for the rules
//        (enabling needs provider + model + LGPD consent for that
//        provider + a saved key). Audited without values of free text.
//
// Everything runs through the caller's RLS client — no service role:
// the encrypted key is never touched here.
// ============================================================

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import { AUDIT_ACTIONS } from '@/lib/audit';
import { audit } from '@/lib/audit-server';
import { requireModule, requireRole } from '@/lib/auth/account';
import { budgetMonthKey, monthStartInTimeZone } from '@/lib/ai/budget';
import { aiErrorResponse } from '@/lib/ai/http';
import { AI_LIMITS, isAiProvider, type AiProvider } from '@/lib/ai/providers';
import { parseAiSettingsUpdate } from '@/lib/ai/settings';
import {
  AI_SETTINGS_COLUMNS,
  usageSummarySince,
  type AiCredentialPublic,
  type AiSettingsRow,
} from '@/lib/ai/store';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

async function loadState(supabase: SupabaseClient, accountId: string) {
  const [settingsRes, credsRes] = await Promise.all([
    supabase.from('ai_settings').select(AI_SETTINGS_COLUMNS).eq('account_id', accountId).maybeSingle(),
    supabase
      .from('ai_provider_credentials_public')
      .select('provider, last4, validated_at, updated_at')
      .eq('account_id', accountId),
  ]);
  if (settingsRes.error) throw new Error(`ai settings read failed: ${settingsRes.error.message}`);
  if (credsRes.error) throw new Error(`ai credentials read failed: ${credsRes.error.message}`);
  const settings = (settingsRes.data as AiSettingsRow | null) ?? null;
  const credentials = ((credsRes.data ?? []) as AiCredentialPublic[]).filter((c) => isAiProvider(c.provider));
  return { settings, credentials };
}

async function payload(supabase: SupabaseClient, accountId: string) {
  const { settings, credentials } = await loadState(supabase, accountId);
  const now = new Date();
  const since = monthStartInTimeZone(now);
  const usage = await usageSummarySince(supabase, accountId, since);

  let consentedByName: string | null = null;
  if (settings?.consented_by) {
    const { data } = await supabase
      .from('profiles')
      .select('full_name')
      .eq('user_id', settings.consented_by)
      .maybeSingle();
    consentedByName = (data?.full_name as string | undefined) ?? null;
  }

  return {
    settings: {
      enabled: settings?.enabled ?? false,
      provider: settings?.provider ?? null,
      model: settings?.model ?? null,
      instructions: settings?.instructions ?? '',
      monthly_budget_cents: settings?.monthly_budget_cents ?? AI_LIMITS.budgetDefaultCents,
      suggest_history_messages: settings?.suggest_history_messages ?? AI_LIMITS.historyDefault,
      consent_provider: settings?.consent_provider ?? null,
      consented_at: settings?.consented_at ?? null,
      consented_by_name: consentedByName,
    },
    credentials,
    usage: { month: budgetMonthKey(now), since: since.toISOString(), ...usage },
  };
}

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    await requireModule(ctx, 'ai');
    return NextResponse.json(await payload(ctx.supabase, ctx.accountId));
  } catch (err) {
    return aiErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');
    await requireModule(ctx, 'ai');

    const limit = checkRateLimit(`admin:ai-settings:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as unknown;
    const { settings: current, credentials } = await loadState(ctx.supabase, ctx.accountId);
    const keyProviders = new Set<AiProvider>(credentials.map((c) => c.provider));

    const parsed = parseAiSettingsUpdate(current, body, keyProviders);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const next = parsed.write;

    const { error } = await ctx.supabase
      .from('ai_settings')
      .upsert({ account_id: ctx.accountId, ...next, updated_by: ctx.userId }, { onConflict: 'account_id' });
    if (error) {
      console.error('[PUT /api/ai/settings] upsert failed:', error.message);
      return NextResponse.json({ error: 'Failed to save the AI settings' }, { status: 500 });
    }

    // Audit which fields changed; free text (instructions) is logged as
    // "changed" only, never its content.
    const before: Record<string, unknown> = {
      enabled: current?.enabled ?? false,
      provider: current?.provider ?? null,
      model: current?.model ?? null,
      monthly_budget_cents: current?.monthly_budget_cents ?? AI_LIMITS.budgetDefaultCents,
      suggest_history_messages: current?.suggest_history_messages ?? AI_LIMITS.historyDefault,
    };
    const after: Record<string, unknown> = {
      enabled: next.enabled,
      provider: next.provider,
      model: next.model,
      monthly_budget_cents: next.monthly_budget_cents,
      suggest_history_messages: next.suggest_history_messages,
    };
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of Object.keys(after)) {
      if (before[k] !== after[k]) changes[k] = { from: before[k], to: after[k] };
    }
    const keys = Object.keys(changes);
    if ((current?.instructions ?? null) !== next.instructions) keys.push('instructions');
    if (parsed.consentChanged) {
      keys.push('consent');
      changes.consent = {
        from: current?.consent_provider ?? null,
        to: next.consent_provider,
      };
    }
    if (keys.length > 0) {
      await audit({
        accountId: ctx.accountId,
        actorUserId: ctx.userId,
        action: AUDIT_ACTIONS.AI_SETTINGS_UPDATED,
        entityType: 'ai_settings',
        entityId: ctx.accountId,
        metadata: { keys, changes },
      });
    }

    return NextResponse.json(await payload(ctx.supabase, ctx.accountId));
  } catch (err) {
    return aiErrorResponse(err);
  }
}
