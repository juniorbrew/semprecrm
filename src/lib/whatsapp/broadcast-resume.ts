// ============================================================
// Broadcast resume / retry (wacrm #472/#495, upstream 3376991).
//
// The wizard's send loop runs in the tab that started the campaign, so
// closing it abandons the campaign with rows still 'pending'. This is
// the recovery — and the same machinery retries rows that FAILED with a
// confirmed error. Delivery itself is broadcast-core's per-row
// claim/send/stamp, so a resume can never resend a row another pass
// claimed or already sent.
//
// Never picked up by any scope:
//   'sending'   — claimed by a pass (live, or dead → becomes 'uncertain');
//   'uncertain' — Meta may have it; left for the operator.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { DELIVERY_LOCK_STALE_MS } from '@/lib/broadcast-delivery-lock';
import {
  BroadcastError,
  expireStaleSending,
  loadDeliveryContext,
  type ClaimableStatus,
  type DeliveryContext,
} from '@/lib/whatsapp/broadcast-core';

/** Which recipients a resume pass picks up. */
export type ResumeScope = 'pending' | 'failed' | 'all';

export const RESUME_SCOPES: readonly ResumeScope[] = ['pending', 'failed', 'all'];

/**
 * Recipients delivered per resume request. One pass runs inside
 * `after()`, bounded by the function timeout; whatever is left stays
 * put and the caller is told how many, so the UI can offer Resume again.
 */
export const RESUME_MAX_PER_REQUEST = 1000;

// Shared with the (client) detail page.
export { DELIVERY_LOCK_STALE_MS };

export function scopeStatuses(scope: ResumeScope): ClaimableStatus[] {
  if (scope === 'pending') return ['pending'];
  if (scope === 'failed') return ['failed'];
  return ['pending', 'failed'];
}

/**
 * Take the delivery lock with MY token. One conditional UPDATE: it wins
 * only when nobody holds a fresh lock — and, for a campaign started by a
 * tab that predates the lock (NULL lock), only when the campaign isn't
 * still 'sending' with recently-moving counts.
 */
export async function claimBroadcastDelivery(
  db: SupabaseClient,
  accountId: string,
  broadcastId: string,
  token: string,
  now: Date = new Date(),
): Promise<boolean> {
  const cutoff = new Date(now.getTime() - DELIVERY_LOCK_STALE_MS).toISOString();

  const { data, error } = await db
    .from('broadcasts')
    .update({ delivery_locked_at: token })
    .eq('id', broadcastId)
    .eq('account_id', accountId)
    .or(
      `delivery_locked_at.lt.${cutoff},` +
        `and(delivery_locked_at.is.null,status.neq.sending),` +
        `and(delivery_locked_at.is.null,updated_at.lt.${cutoff})`,
    )
    .select('id');

  if (error) {
    console.error('[broadcast-resume] claim failed:', error.message);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

export interface ResumePlan {
  ctx: DeliveryContext;
  /** Row ids for this pass (oldest first, at most RESUME_MAX_PER_REQUEST). */
  ids: string[];
  from: ClaimableStatus[];
  /** In-scope rows beyond this pass's cap. */
  remaining: number;
}

/**
 * Plan a resume. Counts with `count: 'exact'` (never capped by the
 * PostgREST row limit) and loads one page of ids. Throws
 * {@link BroadcastError}.
 */
export async function planBroadcastResume(
  db: SupabaseClient,
  accountId: string,
  broadcastId: string,
  scope: ResumeScope,
  now: Date = new Date(),
): Promise<ResumePlan> {
  const ctx = await loadDeliveryContext(db, accountId, broadcastId);
  const from = scopeStatuses(scope);

  // Rows a dead pass left in 'sending' → 'uncertain' (never resent).
  await expireStaleSending(db, broadcastId, now);

  // A campaign created before migration 051 has no frozen params. If the
  // template has variables, a resume would send "{{1}}"-less messages —
  // refuse instead.
  if (ctx.hasBodyVariables) {
    const { count: legacy } = await db
      .from('broadcast_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('broadcast_id', broadcastId)
      .in('status', from)
      .is('template_params', null);
    if ((legacy ?? 0) > 0) {
      throw new BroadcastError(
        'legacy_broadcast',
        'This broadcast was created before resuming existed and did not save each recipient’s variables. Resuming would send the message without them — create a new broadcast for the remaining contacts.',
        409,
      );
    }
  }

  const { count: total } = await db
    .from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId)
    .in('status', from);

  const { data: page, error } = await db
    .from('broadcast_recipients')
    .select('id')
    .eq('broadcast_id', broadcastId)
    .in('status', from)
    // Oldest first, so repeated capped passes walk the backlog in order.
    .order('created_at', { ascending: true })
    .range(0, RESUME_MAX_PER_REQUEST - 1);
  if (error) {
    console.error('[broadcast-resume] recipient load failed:', error.message);
    throw new BroadcastError('internal', 'Failed to load recipients', 500);
  }

  const ids = ((page ?? []) as { id: string }[]).map((r) => r.id);
  if (ids.length === 0) {
    throw new BroadcastError(
      'nothing_to_resume',
      scope === 'failed'
        ? 'This broadcast has no failed recipients to retry'
        : 'This broadcast has no recipients left to send',
      400,
    );
  }

  return { ctx, ids, from, remaining: Math.max(0, (total ?? ids.length) - ids.length) };
}

/**
 * Put the broadcast back into `sending` for the duration of the pass,
 * so the detail page reads as in-flight rather than finished.
 */
export async function markBroadcastSending(
  db: SupabaseClient,
  broadcastId: string,
): Promise<void> {
  await db
    .from('broadcasts')
    .update({ status: 'sending', updated_at: new Date().toISOString() })
    .eq('id', broadcastId);
}
