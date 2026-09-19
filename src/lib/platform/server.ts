// ============================================================
// Server-side helpers for the platform (master) admin pages.
//
// Server-only: imports the SSR Supabase client (next/headers).
// ============================================================

import { notFound, redirect } from "next/navigation";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { cache } from 'react';

import { createClient } from '@/lib/supabase/server';
import type { PlatformAccountRow } from '@/types';

import {
  GATE_LOGIN_PATH,
  hasGateSession,
  loadGateCredentials,
  type GateCredentials,
} from "./gate";

export interface PlatformAdminContext {
  supabase: SupabaseClient;
  user: User;
  /** null until the admin sets a username/password on /platform/login. */
  gate: GateCredentials | null;
  /** Whether the request carries a valid gate cookie. */
  gateOpen: boolean;
}

/**
 * Resolve the SSR client and check the caller is a platform admin
 * via the `is_platform_admin()` RPC. Returns null for anyone else —
 * signed out, or signed in but not listed in `platform_admins`.
 */
export async function getPlatformAdmin(): Promise<PlatformAdminContext | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase.rpc("is_platform_admin");
  if (error) {
    // A fork without migration 025 has no such function; treat as
    // "not an admin" rather than crashing the route.
    console.error("[platform] is_platform_admin failed:", error.message);
    return null;
  }
  if (data !== true) return null;
  const gate = await loadGateCredentials(user.id);
  return { supabase, user, gate, gateOpen: await hasGateSession(gate) };
}

/**
 * Page guard. Non-admins get a 404, so the route's existence is not
 * advertised; admins without an open gate (no username/password yet,
 * or cookie missing/expired) are sent to /platform/login.
 */
export const requirePlatformAdminContext = cache(async (): Promise<PlatformAdminContext> => {
  const ctx = await getPlatformAdmin();
  if (!ctx) notFound();
  if (!ctx.gateOpen) redirect(GATE_LOGIN_PATH);
  return ctx;
});

export const requirePlatformAdmin = cache(async (): Promise<SupabaseClient> => {
  return (await requirePlatformAdminContext()).supabase;
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
