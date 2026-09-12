// ============================================================
// Server-side entitlement lookups.
//
// Thin I/O wrapper over the pure resolver in `./plans`. Takes the
// Supabase client as a parameter so it works with both the RLS-
// scoped SSR client (API routes) and the service-role client (the
// automation / flow engines, which run without a user session).
//
// No `next/*` imports here on purpose — the engines' unit tests
// mock only the admin client, so this module must stay importable
// in a bare node environment.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  resolveEntitlements,
  type Entitlements,
  type Module,
  type PlanAccountFields,
} from './plans';

/** Columns the resolver needs — keep in sync with `PlanAccountFields`. */
export const PLAN_COLUMNS =
  'plan, plan_status, plan_expires_at, module_overrides, limit_overrides';

/**
 * Load and resolve the entitlements for one account.
 *
 * Returns `null` when the row can't be read (missing account or DB
 * error). Callers decide what that means — the engines treat it as
 * "don't run" (fail closed), the settings UI as "show trial".
 */
export async function loadAccountEntitlements(
  db: SupabaseClient,
  accountId: string,
): Promise<Entitlements | null> {
  const { data, error } = await db
    .from('accounts')
    .select(PLAN_COLUMNS)
    .eq('id', accountId)
    .maybeSingle();

  if (error) {
    console.error('[plans] failed to load account plan:', accountId, error.message);
    return null;
  }
  if (!data) return null;
  return resolveEntitlements(data as PlanAccountFields);
}

/**
 * `true` iff the account exists, is not blocked, and has `module` on.
 *
 * A blocked account (suspended / past_due / canceled / expired trial)
 * has every module off from the API's point of view — the customer
 * can't use the UI, so background engines shouldn't keep sending
 * messages on their behalf either.
 */
export async function accountHasModule(
  db: SupabaseClient,
  accountId: string,
  module: Module,
): Promise<boolean> {
  const ent = await loadAccountEntitlements(db, accountId);
  if (!ent) return false;
  if (ent.blocked) return false;
  return ent.modules[module];
}
