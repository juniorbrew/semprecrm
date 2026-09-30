// AI agents — DB helpers for the /api/ai/agents routes (server only,
// caller's RLS client; admin+ is checked by the route).

import type { AccountContext } from '@/lib/auth/account';
import { AI_DEFAULT_MODELS, isAiProvider, modelMatchesProvider, type AiProvider } from './providers';
import { AI_SETTINGS_ERRORS } from './settings';

/**
 * Make `agentId` the account's only default in ONE statement (RPC over
 * a deferred exclusion constraint — the account is never left without
 * a default half-way). 'conflict' = a concurrent swap won.
 */
export async function setDefaultAgent(ctx: AccountContext, agentId: string): Promise<'ok' | 'conflict'> {
  const { error } = await ctx.supabase.rpc('ai_agents_set_default', {
    p_account_id: ctx.accountId,
    p_agent_id: agentId,
  });
  if (error?.code === '23P01') return 'conflict';
  if (error) throw new Error(`ai agents default swap failed: ${error.message}`);
  return 'ok';
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

/** What the agents page shows next to the agents: the account's provider and default model. */
export async function loadAgentAccountAi(
  ctx: AccountContext,
): Promise<{ provider: AiProvider | null; account_model: string | null }> {
  const { data, error } = await ctx.supabase
    .from('ai_settings')
    .select('provider, model')
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (error) throw new Error(`ai settings read failed: ${error.message}`);
  const row = (data ?? {}) as { provider?: string | null; model?: string | null };
  const provider = isAiProvider(row.provider) ? row.provider : null;
  return { provider, account_model: row.model || (provider ? AI_DEFAULT_MODELS[provider] : null) };
}
