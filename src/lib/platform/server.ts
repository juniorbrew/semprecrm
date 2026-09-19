// ============================================================
// Server-side helpers for the platform (master) admin pages.
//
// Server-only: imports the SSR Supabase client (next/headers).
// ============================================================

import { notFound } from 'next/navigation';
import { cache } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

import { createClient } from '@/lib/supabase/server';
import type { PlatformAccountRow } from '@/types';

/**
 * Resolve the SSR client and verify the caller is a platform admin
 * via the `is_platform_admin()` RPC. Anyone else — signed out,
 * signed in but not listed in `platform_admins` — gets a 404, so
 * the route's existence is not advertised.
 */
export const requirePlatformAdmin = cache(async (): Promise<SupabaseClient> => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('is_platform_admin');
  if (error) {
    // A fork without migration 025 has no such function; treat as
    // "not an admin" rather than crashing the route.
    console.error('[platform] is_platform_admin failed:', error.message);
    notFound();
  }
  if (data !== true) notFound();
  return supabase;
});

/** Every account with owner + counts, newest first. */
export async function listPlatformAccounts(
  supabase: SupabaseClient
): Promise<PlatformAccountRow[]> {
  const { data, error } = await supabase.rpc('platform_list_accounts');
  if (error) {
    console.error('[platform] platform_list_accounts failed:', error.message);
    throw new Error('Failed to load accounts');
  }
  return (data ?? []) as PlatformAccountRow[];
}

/** One account by id (via the same RPC so the counts come along). */
export async function getPlatformAccount(
  supabase: SupabaseClient,
  accountId: string
): Promise<PlatformAccountRow | null> {
  const rows = await listPlatformAccounts(supabase);
  return rows.find((r) => r.id === accountId) ?? null;
}
