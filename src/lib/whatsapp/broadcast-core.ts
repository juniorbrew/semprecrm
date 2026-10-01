// ============================================================
// Server-side broadcast delivery (wacrm #472, upstream 3376991 —
// redesigned for SempreCRM so NO path can send a recipient twice).
//
// Every send — the wizard's batches through /api/whatsapp/broadcast and
// the resume route — goes through the same per-ROW protocol:
//
//   1. CLAIM   UPDATE broadcast_recipients SET status='sending',
//              claimed_at=now() WHERE id IN (...) AND status IN (...)
//              RETURNING — one statement, so two passes racing for the
//              same row can't both win it. Only claimed rows are sent.
//   2. SEND    phone-variant retry, but ONLY after a confirmed rejection.
//   3. STAMP   the server writes the outcome (WHERE status='sending'):
//                sent      — Meta returned a message id;
//                failed    — CONFIRMED not sent (Meta 4xx, bad phone,
//                            opt-out). Only these are retryable;
//                uncertain — Meta MAY have it (network, timeout, 5xx,
//                            unreadable 2xx). Never resent automatically.
//
// A pass that dies leaves its claimed rows in 'sending'; after the
// staleness window they become 'uncertain' (expireStaleSending), never
// 'pending' again.
//
// Upstream's createBroadcast() belongs to its public REST API v1, which
// SempreCRM doesn't have — the wizard creates the campaign.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  DELIVERY_LOCK_STALE_MS,
  renewDeliveryLock,
} from '@/lib/broadcast-delivery-lock';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { findSuppressedPhones } from '@/lib/lgpd/suppression';
import { decrypt } from '@/lib/whatsapp/encryption';
import { isUncertainSendError, sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import {
  isValidE164,
  normalizePhone,
  phoneVariants,
  isRecipientNotAllowedError,
  sanitizePhoneForMeta,
} from '@/lib/whatsapp/phone-utils';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import { TEMPLATE_NEEDS_SYNC_ERROR } from '@/lib/whatsapp/template-row-guard';
import type { MessageTemplate } from '@/types';

/** Caller-visible failure; routes map it to a JSON error. */
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

/** Rows claimed and sent per step (one lock renewal per step). */
export const CLAIM_CHUNK = 10;

/** Statuses a pass may claim from. 'sending'/'uncertain' never are. */
export type ClaimableStatus = 'pending' | 'failed';

/**
 * PostgREST `or()` filter for the claimable rows of the given statuses.
 *
 * 'failed' means failed UNDER THIS PROTOCOL (claimed_at set) — i.e. a
 * confirmed rejection. Rows the old browser-stamped code marked failed
 * (claimed_at NULL) may have been sent by the server and are never
 * retried; the detail page lists them as "falha antiga".
 */
export function claimableStatusFilter(from: ClaimableStatus[]): string {
  const terms: string[] = [];
  if (from.includes('pending')) terms.push('status.eq.pending');
  if (from.includes('failed')) terms.push('and(status.eq.failed,claimed_at.not.is.null)');
  return terms.join(',');
}

export type RowOutcome = 'sent' | 'failed' | 'uncertain';

export interface RowResult {
  id: string;
  outcome: RowOutcome | 'skipped';
  error?: string;
}

/** Everything needed to send this broadcast's template. */
export interface DeliveryContext {
  accountId: string;
  broadcastId: string;
  templateName: string;
  templateLanguage: string;
  phoneNumberId: string;
  accessToken: string;
  templateRow: MessageTemplate | null;
  /** Header media chosen in the wizard (#298). Null → template's stored URL. */
  headerMediaUrl: string | null;
  /**
   * Created by the old browser-stamped code (delivery_protocol NULL). Its
   * 'pending' rows may already have been sent — see planBroadcastResume.
   */
  isLegacy: boolean;
}

/**
 * Load the broadcast (account-scoped), the WhatsApp config and the
 * template row. Throws {@link BroadcastError}.
 */
export async function loadDeliveryContext(
  db: SupabaseClient,
  accountId: string,
  broadcastId: string,
): Promise<DeliveryContext> {
  const { data: broadcast, error: bcError } = await db
    .from('broadcasts')
    .select('id, template_name, template_language, header_media_url, delivery_protocol')
    .eq('id', broadcastId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (bcError || !broadcast) {
    throw new BroadcastError('not_found', 'Broadcast not found', 404);
  }

  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .single();
  if (configError || !config) {
    throw new BroadcastError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400,
    );
  }

  // Tolerant of the en / en_US split (wacrm #483): a row synced as `en`
  // still supplies the header/button components for an `en_US` campaign.
  const resolvedTemplate = await resolveTemplateRow(
    db,
    accountId,
    broadcast.template_name as string,
    (broadcast.template_language as string | null) || null,
  );
  if (resolvedTemplate.malformed) {
    throw new BroadcastError(
      'template_malformed',
      'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.',
      500,
    );
  }
  if (resolvedTemplate.needsSync) {
    // Webhook stub (migration 053) — every recipient would fail at Meta.
    throw new BroadcastError('template_needs_sync', TEMPLATE_NEEDS_SYNC_ERROR, 409);
  }
  const templateRow: MessageTemplate | null = resolvedTemplate.row;
  const templateLanguage = resolvedTemplate.language;

  return {
    accountId,
    broadcastId,
    templateName: broadcast.template_name as string,
    templateLanguage,
    phoneNumberId: config.phone_number_id,
    accessToken: decrypt(config.access_token),
    templateRow,
    headerMediaUrl: (broadcast.header_media_url as string | null) ?? null,
    isLegacy: broadcast.delivery_protocol == null,
  };
}

interface ClaimedRow {
  id: string;
  contact_id: string | null;
  template_params: unknown;
}

/**
 * Atomically claim rows for THIS pass. Rows already claimed (or sent)
 * by anyone else simply don't come back — the caller never sends them.
 */
export async function claimRecipientRows(
  db: SupabaseClient,
  broadcastId: string,
  ids: string[],
  from: ClaimableStatus[],
  now: Date = new Date(),
): Promise<ClaimedRow[]> {
  if (ids.length === 0) return [];
  const { data, error } = await db
    .from('broadcast_recipients')
    .update({ status: 'sending', claimed_at: now.toISOString() })
    .eq('broadcast_id', broadcastId)
    .in('id', ids)
    .or(claimableStatusFilter(from))
    .select('id, contact_id, template_params');
  if (error) {
    console.error('[broadcast-core] claim failed:', error.message);
    return [];
  }
  return (data ?? []) as ClaimedRow[];
}

async function stamp(
  db: SupabaseClient,
  rowId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  // Only the pass that claimed the row (status 'sending') stamps it.
  await db
    .from('broadcast_recipients')
    .update(patch)
    .eq('id', rowId)
    .eq('status', 'sending');
}

function paramsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((p): p is string => typeof p === 'string') : [];
}

/** Send the rows THIS pass claimed and stamp each outcome. */
export async function sendClaimedRows(
  db: SupabaseClient,
  ctx: DeliveryContext,
  rows: ClaimedRow[],
): Promise<RowResult[]> {
  if (rows.length === 0) return [];

  const contactIds = [...new Set(rows.map((r) => r.contact_id).filter(Boolean))] as string[];
  const contacts = new Map<string, { phone?: string | null; opted_out_at?: string | null }>();
  if (contactIds.length > 0) {
    const { data } = await db
      .from('contacts')
      .select('id, phone, opted_out_at')
      .in('id', contactIds);
    for (const c of (data ?? []) as { id: string; phone?: string | null; opted_out_at?: string | null }[]) {
      contacts.set(c.id, c);
    }
  }

  // Opt-out (migration 030) by number too: another contact row with the
  // same number may carry the opt-out. Asked only for THIS chunk's numbers
  // — a blanket "every opted-out contact" read is capped at 1000 rows by
  // PostgREST and would silently miss the rest.
  const blocked = new Set<string>();
  const chunkNumbers = [
    ...new Set(
      [...contacts.values()]
        .map((c) => normalizePhone(c.phone ?? ''))
        .filter(Boolean),
    ),
  ];
  if (chunkNumbers.length > 0) {
    const { data: optedOutRows } = await db
      .from('contacts')
      .select('phone_normalized')
      .eq('account_id', ctx.accountId)
      .not('opted_out_at', 'is', null)
      .in('phone_normalized', chunkNumbers);
    for (const r of (optedOutRows ?? []) as { phone_normalized?: string | null }[]) {
      if (r.phone_normalized) blocked.add(r.phone_normalized);
    }
    // Opted-out numbers whose contact was anonymised (suppression list,
    // migration 077). Throws on a lookup failure: fail CLOSED — the claimed
    // rows are left unsent (they turn 'uncertain' and are never sent blind).
    // The list is service-role only (RLS, no member grants): always read it
    // with the service client, whatever client the caller passed in.
    for (const n of await findSuppressedPhones(supabaseAdmin(), ctx.accountId, chunkNumbers)) blocked.add(n);
  }

  const messageParams = ctx.headerMediaUrl ? { headerMediaUrl: ctx.headerMediaUrl } : undefined;
  const results: RowResult[] = [];

  for (const row of rows) {
    const contact = row.contact_id ? contacts.get(row.contact_id) : undefined;
    const phone = sanitizePhoneForMeta(contact?.phone ?? '');

    if (!isValidE164(phone)) {
      const error = 'No valid phone number on contact';
      await stamp(db, row.id, { status: 'failed', error_message: error });
      results.push({ id: row.id, outcome: 'failed', error });
      continue;
    }
    if (
      contact?.opted_out_at ||
      blocked.has(normalizePhone(phone)) ||
      blocked.has(normalizePhone(contact?.phone ?? ''))
    ) {
      const error = 'Contact opted out';
      await stamp(db, row.id, { status: 'failed', error_message: error });
      results.push({ id: row.id, outcome: 'failed', error });
      continue;
    }

    let messageId: string | null = null;
    let outcome: RowOutcome = 'failed';
    let lastError = 'Unknown error';
    for (const variant of phoneVariants(phone)) {
      try {
        const res = await sendTemplateMessage({
          phoneNumberId: ctx.phoneNumberId,
          accessToken: ctx.accessToken,
          to: variant,
          templateName: ctx.templateName,
          language: ctx.templateLanguage,
          template: ctx.templateRow ?? undefined,
          params: paramsOf(row.template_params),
          ...(messageParams ? { messageParams } : {}),
        });
        messageId = res.messageId;
        outcome = 'sent';
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : 'Unknown error';
        if (isUncertainSendError(err)) {
          // Meta may have it. Trying another variant could deliver a
          // second copy — stop here and leave it for the operator.
          outcome = 'uncertain';
          break;
        }
        // Confirmed rejection; only "recipient not allowed" is worth
        // another spelling of the number.
        if (!isRecipientNotAllowedError(lastError)) break;
      }
    }

    if (outcome === 'sent' && messageId) {
      await stamp(db, row.id, {
        status: 'sent',
        sent_at: new Date().toISOString(),
        whatsapp_message_id: messageId,
        error_message: null,
      });
      results.push({ id: row.id, outcome: 'sent' });
    } else if (outcome === 'uncertain') {
      const error = `Outcome unknown: ${lastError}`;
      await stamp(db, row.id, { status: 'uncertain', error_message: error });
      results.push({ id: row.id, outcome: 'uncertain', error });
    } else {
      await stamp(db, row.id, { status: 'failed', error_message: lastError });
      results.push({ id: row.id, outcome: 'failed', error: lastError });
    }
  }
  return results;
}

/** Claim, then send only what was claimed. Unclaimed ids → 'skipped'. */
export async function deliverRecipientIds(
  db: SupabaseClient,
  ctx: DeliveryContext,
  ids: string[],
  from: ClaimableStatus[],
): Promise<RowResult[]> {
  const claimed = await claimRecipientRows(db, ctx.broadcastId, ids, from);
  const results = await sendClaimedRows(db, ctx, claimed);
  const claimedIds = new Set(claimed.map((r) => r.id));
  for (const id of ids) {
    if (!claimedIds.has(id)) results.push({ id, outcome: 'skipped' });
  }
  return results;
}

/**
 * Rows left in 'sending' longer than the staleness window belong to a
 * pass that died. Their outcome is unknown: mark them 'uncertain' —
 * never back to 'pending', which would resend them.
 */
export async function expireStaleSending(
  db: SupabaseClient,
  broadcastId: string,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - DELIVERY_LOCK_STALE_MS).toISOString();
  const { data } = await db
    .from('broadcast_recipients')
    .update({
      status: 'uncertain',
      error_message: 'Send interrupted — outcome unknown',
    })
    .eq('broadcast_id', broadcastId)
    .eq('status', 'sending')
    .lt('claimed_at', cutoff)
    .select('id');
  return Array.isArray(data) ? data.length : 0;
}

export interface ResumeDelivery {
  ids: string[];
  from: ClaimableStatus[];
  lockToken: string;
}

/**
 * Server-side pass (resume route, inside `after()`): renew MY lock,
 * claim + send one chunk, repeat. Stops as soon as the lock is no
 * longer mine. Returns the last token held (for the release).
 */
export async function deliverBroadcast(
  db: SupabaseClient,
  ctx: DeliveryContext,
  delivery: ResumeDelivery,
): Promise<{ lockToken: string | null; results: RowResult[] }> {
  let token: string | null = delivery.lockToken;
  const results: RowResult[] = [];
  for (let i = 0; i < delivery.ids.length; i += CLAIM_CHUNK) {
    const next: string | null = await renewDeliveryLock(db, ctx.broadcastId, token);
    if (!next) {
      token = null;
      break;
    }
    token = next;
    results.push(
      ...(await deliverRecipientIds(
        db,
        ctx,
        delivery.ids.slice(i, i + CLAIM_CHUNK),
        delivery.from,
      )),
    );
  }
  await finalizeBroadcastStatus(db, ctx.broadcastId);
  return { lockToken: token, results };
}

async function countRows(
  db: SupabaseClient,
  broadcastId: string,
  status?: string,
): Promise<number> {
  let q = db
    .from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId);
  if (status) q = q.eq('status', status);
  const { count } = await q;
  return count ?? 0;
}

/**
 * Flip a broadcast out of `sending` once nothing is pending or in
 * flight. Derived from the rows, not from one pass's counters: a resume
 * sends only leftovers, so "nothing sent this pass" must not condemn a
 * campaign that already reached hundreds. `sent` needs at least one row
 * CONFIRMED sent; when every row is failed or uncertain the campaign is
 * `failed` (the uncertain ones stay visible in uncertain_count).
 */
export async function finalizeBroadcastStatus(
  db: SupabaseClient,
  broadcastId: string,
  now: Date = new Date(),
): Promise<void> {
  await expireStaleSending(db, broadcastId, now);
  if ((await countRows(db, broadcastId, 'pending')) > 0) return;
  if ((await countRows(db, broadcastId, 'sending')) > 0) return;

  const failed = await countRows(db, broadcastId, 'failed');
  const uncertain = await countRows(db, broadcastId, 'uncertain');
  const total = await countRows(db, broadcastId);
  const confirmedSent = total - failed - uncertain;

  await db
    .from('broadcasts')
    .update({
      status: total > 0 && confirmedSent <= 0 ? 'failed' : 'sent',
      updated_at: new Date().toISOString(),
    })
    .eq('id', broadcastId)
    .eq('status', 'sending');
}
