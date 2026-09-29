// AI agents — DB helpers for the /api/ai/agents routes (server only,
// caller's RLS client; admin+ is checked by the route).

import type { AccountContext } from '@/lib/auth/account';
import { modelMatchesProvider } from './providers';
import { AI_SETTINGS_ERRORS } from './settings';

/** Unset `is_default` on every other agent of the account. */
export async function clearOtherDefaults(ctx: AccountContext, keepId: string | null): Promise<void> {
  let q = ctx.supabase
    .from('ai_agents')
    .update({ is_default: false })
    .eq('account_id', ctx.accountId)
    .eq('is_default', true);
  if (keepId) q = q.neq('id', keepId);
  const { error } = await q;
  if (error) throw new Error(`ai agents default reset failed: ${error.message}`);
}

/**
 * A model override must belong to the account's current provider
 * (runModelCall ignores a mismatched one anyway). Error key or null.
 */
export async function checkAgentModel(ctx: AccountContext, model: string | null | undefined): Promise<string | null> {
  if (!model) return null;
  const { data, error } = await ctx.supabase
    .from('ai_settings')
    .select('provider')
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (error) throw new Error(`ai settings read failed: ${error.message}`);
  const provider = (data as { provider?: string | null } | null)?.provider;
  if ((provider === 'openai' || provider === 'anthropic') && !modelMatchesProvider(provider, model)) {
    return AI_SETTINGS_ERRORS.modelProvider;
  }
  return null;
}
