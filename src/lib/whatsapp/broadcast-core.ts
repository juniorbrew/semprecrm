// ============================================================
// Server-side broadcast delivery (wacrm #472, upstream 3376991).
//
// Upstream's broadcast-core.ts also carries `createBroadcast()` for its
// public REST API v1 (#245). SempreCRM has no public broadcast API — the
// dashboard wizard (use-broadcast-sending) creates the campaign — so
// only the delivery half is ported here, for the resume route:
//
//   deliverBroadcast()        — send each planned recipient's template via
//                               Meta (phone-variant retry), stamp each
//                               recipient row, finalize status.
//   finalizeBroadcastStatus() — terminal status derived from the rows.
//
// Recipient rows carry `whatsapp_message_id`, so the inbound webhook's
// status handler updates delivered/read for resumed sends exactly as it
// does for the wizard's.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import {
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import type { MessageTemplate } from '@/types';

/** Caller-visible failure; the route maps it to a JSON error. */
export class BroadcastError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'BroadcastError';
    this.code = code;
    this.status = status;
  }
}

export interface PlannedRecipient {
  recipientRowId: string;
  /** Digits-only phone (sanitizePhoneForMeta). */
  phone: string;
  params: string[];
}

export interface BroadcastPlan {
  broadcastId: string;
  templateName: string;
  templateLanguage: string;
  phoneNumberId: string;
  accessToken: string;
  templateRow: MessageTemplate | null;
  /**
   * Header media chosen in the wizard for image/video/document
   * templates (#298, migration 051). Null → the send builder falls back
   * to the template's stored URL.
   */
  headerMediaUrl: string | null;
  planned: PlannedRecipient[];
}

/**
 * Refresh `delivery_locked_at` every this many recipients so a long pass
 * is never mistaken for an abandoned one (see DELIVERY_LOCK_STALE_MS in
 * broadcast-resume.ts).
 */
export const DELIVERY_LOCK_HEARTBEAT_EVERY = 10;

/**
 * Fan out a {@link BroadcastPlan}: send each recipient's template
 * (phone-variant retry) and stamp its `broadcast_recipients` row.
 * Best-effort per recipient — one failure never aborts the rest.
 * Designed to run inside `after()`.
 *
 * The per-status count columns on `broadcasts` are owned by the DB
 * aggregate trigger (migrations 003/005): each recipient-row update
 * below advances them. We never write those columns here — only the
 * terminal `status` — or a manual value would clobber the trigger.
 */
export async function deliverBroadcast(
  db: SupabaseClient,
  plan: BroadcastPlan,
): Promise<void> {
  const messageParams = plan.headerMediaUrl
    ? { headerMediaUrl: plan.headerMediaUrl }
    : undefined;

  for (let i = 0; i < plan.planned.length; i++) {
    const recipient = plan.planned[i];

    if (i > 0 && i % DELIVERY_LOCK_HEARTBEAT_EVERY === 0) {
      await db
        .from('broadcasts')
        .update({ delivery_locked_at: new Date().toISOString() })
        .eq('id', plan.broadcastId);
    }

    const variants = phoneVariants(recipient.phone);
    let sentMessageId: string | null = null;
    let lastError: string | null = null;

    for (const variant of variants) {
      try {
        const result = await sendTemplateMessage({
          phoneNumberId: plan.phoneNumberId,
          accessToken: plan.accessToken,
          to: variant,
          templateName: plan.templateName,
          language: plan.templateLanguage,
          template: plan.templateRow ?? undefined,
          params: recipient.params,
          ...(messageParams ? { messageParams } : {}),
        });
        sentMessageId = result.messageId;
        lastError = null;
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        lastError = message;
        // Only a "recipient not allowed" error is worth another variant.
        if (!isRecipientNotAllowedError(message)) break;
      }
    }

    if (sentMessageId) {
      await db
        .from('broadcast_recipients')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          whatsapp_message_id: sentMessageId,
          error_message: null,
        })
        .eq('id', recipient.recipientRowId);
    } else {
      await db
        .from('broadcast_recipients')
        .update({
          status: 'failed',
          error_message: lastError || 'Unknown error',
        })
        .eq('id', recipient.recipientRowId);
    }
  }

  await finalizeBroadcastStatus(db, plan.broadcastId);
}

/**
 * Flip a broadcast out of `sending` once no recipient is left pending.
 *
 * Derived from the recipient rows rather than from a counter local to
 * one delivery pass: a resume delivers only the leftovers, so "nothing
 * sent *this* pass" must not mark a campaign failed when 800 of its
 * 1 000 recipients went out earlier. `failed` means every recipient
 * failed; anything else is `sent`, with the per-recipient failures
 * visible in `failed_count`.
 */
export async function finalizeBroadcastStatus(
  db: SupabaseClient,
  broadcastId: string,
): Promise<void> {
  const countWhere = async (status: string): Promise<number> => {
    const { count } = await db
      .from('broadcast_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('broadcast_id', broadcastId)
      .eq('status', status);
    return count ?? 0;
  };

  // Still work outstanding (a capped resume pass) — leave it 'sending'
  // so the UI keeps offering Resume.
  if ((await countWhere('pending')) > 0) return;

  const failed = await countWhere('failed');
  const { count: total } = await db
    .from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId);

  await db
    .from('broadcasts')
    .update({
      status: failed > 0 && failed === (total ?? 0) ? 'failed' : 'sent',
      updated_at: new Date().toISOString(),
    })
    .eq('id', broadcastId);
}
