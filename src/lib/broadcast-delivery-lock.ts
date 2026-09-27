/**
 * Broadcast delivery lock (`broadcasts.delivery_locked_at`, migration
 * 051). Client-safe on purpose: the wizard (browser) creates and
 * releases its lock, the server renews it per batch, and the detail
 * page reads it.
 *
 * The lock value doubles as the OWNER'S TOKEN: every renew / release is
 * `UPDATE ... WHERE delivery_locked_at = <my token>`, so a stale tab or
 * a dead pass can never renew or clear a lock someone else now holds.
 * (The lock is the coarse layer — it keeps two passes from running at
 * once. What actually prevents a double send is the per-row claim in
 * broadcast-core.ts.)
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * How long a lock (or a row stuck in 'sending') is honoured before it
 * is read as abandoned. Every live pass renews the lock once per batch
 * of 10 sends (each send capped at 30 s), so 10 min is never a live pass.
 */
export const DELIVERY_LOCK_STALE_MS = 10 * 60 * 1000;

/**
 * A fresh, practically unique lock token: an ISO instant with random
 * microseconds (timestamptz keeps microseconds, so the token survives the
 * round trip and `.eq()` on it is exact).
 */
export function newLockToken(now: Date = new Date()): string {
  const micro = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
  return now.toISOString().replace('Z', `${micro}Z`);
}

/** True when a lock stamp is fresh enough to belong to a live pass. */
export function isDeliveryLockActive(
  lockedAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!lockedAt) return false;
  const t = Date.parse(lockedAt);
  return Number.isFinite(t) && now - t < DELIVERY_LOCK_STALE_MS;
}

/**
 * Is somebody still delivering this broadcast? A fresh lock, or — for a
 * campaign started by a tab that predates the lock (NULL lock) — a
 * 'sending' broadcast whose counts moved recently (the count trigger
 * bumps updated_at on every sent/failed stamp).
 */
export function isDeliveryActive(
  b: { status: string; delivery_locked_at?: string | null; updated_at?: string | null },
  now: number = Date.now(),
): boolean {
  if (b.delivery_locked_at) return isDeliveryLockActive(b.delivery_locked_at, now);
  if (b.status !== 'sending' || !b.updated_at) return false;
  const t = Date.parse(b.updated_at);
  return Number.isFinite(t) && now - t < DELIVERY_LOCK_STALE_MS;
}

/**
 * Renew MY lock. Returns the new token, or null when the lock is no
 * longer mine (someone took over after it went stale) — the caller must
 * stop sending.
 */
export async function renewDeliveryLock(
  db: SupabaseClient,
  broadcastId: string,
  ownToken: string,
  now: Date = new Date(),
): Promise<string | null> {
  const next = newLockToken(now);
  const { data, error } = await db
    .from('broadcasts')
    .update({ delivery_locked_at: next })
    .eq('id', broadcastId)
    .eq('delivery_locked_at', ownToken)
    .select('id');
  if (error || !Array.isArray(data) || data.length === 0) return null;
  return next;
}

/** Release MY lock — a no-op when someone else holds it now. */
export async function releaseDeliveryLock(
  db: SupabaseClient,
  broadcastId: string,
  ownToken: string,
): Promise<void> {
  await db
    .from('broadcasts')
    .update({ delivery_locked_at: null })
    .eq('id', broadcastId)
    .eq('delivery_locked_at', ownToken);
}
