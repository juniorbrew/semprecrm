/**
 * How long a `broadcasts.delivery_locked_at` stamp (migration 051) is
 * honoured before it is read as abandoned. Client-safe on purpose: the
 * detail page uses it to tell "someone is still sending" from "stalled",
 * and the resume route uses it for the conditional claim.
 *
 * Every live sender refreshes the lock — the wizard once per batch
 * (worst case ~6 min of 429 back-off between renewals) and the
 * server-side resume every few recipients — so 10 min is never a live
 * pass, and a closed tab becomes resumable 10 min after its last batch.
 */
export const DELIVERY_LOCK_STALE_MS = 10 * 60 * 1000;

/** True when a delivery pass is (probably) still running. */
export function isDeliveryLockActive(
  lockedAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!lockedAt) return false;
  const t = Date.parse(lockedAt);
  return Number.isFinite(t) && now - t < DELIVERY_LOCK_STALE_MS;
}
