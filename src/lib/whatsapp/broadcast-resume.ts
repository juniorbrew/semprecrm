// ============================================================
// Broadcast resume / retry (wacrm #472/#495, upstream 3376991).
//
// The dashboard wizard drives its own send loop from the browser tab
// that started the campaign, so closing the tab abandons the campaign
// mid-flight: the remaining recipients stay 'pending' and the
// broadcast sits in 'sending' forever. This module is the recovery —
// and the same machinery answers "reprocess pending" and "reprocess
// failed".
//
// It reuses `deliverBroadcast` rather than growing a second fan-out
// loop: same phone-variant retry, same per-recipient stamping, same
// trigger-owned counts. It does NOT move the *initial* send
// server-side; the wizard still owns that.
//
// SempreCRM adaptations:
//   - the wizard also holds `delivery_locked_at` while it sends and
//     refreshes it per batch, and deliverBroadcast heartbeats it, so the
//     staleness window is shorter than upstream's 30 min;
//   - opted-out contacts (migration 030) are stamped failed, never sent;
//   - the header media URL chosen in the wizard (migration 051) rides
//     along in the plan;
//   - the template row is looked up like /api/whatsapp/broadcast does
//     (exact name + language, isMessageTemplate guard).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { DELIVERY_LOCK_STALE_MS } from '@/lib/broadcast-delivery-lock';
import { BroadcastError, type BroadcastPlan } from '@/lib/whatsapp/broadcast-core';
import { decrypt } from '@/lib/whatsapp/encryption';
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard';
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils';

/** Which recipients a resume pass picks up. */
export type ResumeScope = 'pending' | 'failed' | 'all';

export const RESUME_SCOPES: readonly ResumeScope[] = ['pending', 'failed', 'all'];

/**
 * Recipients delivered per resume request. One pass runs inside
 * `after()`, so it is bounded by the host's function timeout — the cap
 * keeps a 5 000-recipient backlog from being one un-completable unit of
 * work. Whatever is left stays 'pending' and the caller is told how
 * many, so the UI can offer Resume again.
 */
export const RESUME_MAX_PER_REQUEST = 1000;

// Shared with the (client) detail page — see broadcast-delivery-lock.ts.
export { DELIVERY_LOCK_STALE_MS };

function scopeStatuses(scope: ResumeScope): string[] {
  if (scope === 'pending') return ['pending'];
  if (scope === 'failed') return ['failed'];
  return ['pending', 'failed'];
}

/**
 * Take the delivery lock for a broadcast.
 *
 * One conditional UPDATE, so the claim is atomic: a concurrent caller's
 * WHERE no longer matches and it gets `false`. Also false when the
 * broadcast doesn't exist on this account — both mean "not yours to run".
 */
export async function claimBroadcastDelivery(
  db: SupabaseClient,
  accountId: string,
  broadcastId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const staleCutoff = new Date(now.getTime() - DELIVERY_LOCK_STALE_MS).toISOString();

  const { data, error } = await db
    .from('broadcasts')
    .update({ delivery_locked_at: now.toISOString() })
    .eq('id', broadcastId)
    .eq('account_id', accountId)
    .or(`delivery_locked_at.is.null,delivery_locked_at.lt.${staleCutoff}`)
    .select('id');

  if (error) {
    console.error('[broadcast-resume] claim failed:', error.message);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

/** Release the delivery lock. Best-effort; a stale lock self-expires. */
export async function releaseBroadcastDelivery(
  db: SupabaseClient,
  broadcastId: string,
): Promise<void> {
  const { error } = await db
    .from('broadcasts')
    .update({ delivery_locked_at: null })
    .eq('id', broadcastId);
  if (error) {
    console.error('[broadcast-resume] release failed:', error.message);
  }
}

export interface ResumePlan {
  plan: BroadcastPlan;
  /** In-scope recipients left over after the per-request cap. */
  remaining: number;
  /**
   * In-scope rows that can never send (no usable phone, or the contact
   * opted out). Stamped 'failed' so they stop blocking the terminal
   * status.
   */
  unsendable: number;
}

type ContactEmbed = { phone?: string | null; opted_out_at?: string | null };

interface RecipientRow {
  id: string;
  template_params: unknown;
  contact: ContactEmbed | ContactEmbed[] | null;
}

/** Supabase renders an embedded to-one join as an object or a 1-array. */
function contactOf(row: RecipientRow): ContactEmbed | null {
  return (Array.isArray(row.contact) ? row.contact[0] : row.contact) ?? null;
}

/**
 * Build a {@link BroadcastPlan} for the recipients of an existing
 * broadcast that still need sending.
 *
 * Params come off the recipient rows (frozen at plan time, migration
 * 051) rather than being re-resolved from contact data, so a resume
 * sends what the original pass would have sent.
 *
 * Throws {@link BroadcastError}; the route maps it.
 */
export async function planBroadcastResume(
  db: SupabaseClient,
  accountId: string,
  broadcastId: string,
  scope: ResumeScope,
): Promise<ResumePlan> {
  const { data: broadcast, error: bcError } = await db
    .from('broadcasts')
    .select('id, template_name, template_language, header_media_url')
    .eq('id', broadcastId)
    .eq('account_id', accountId)
    .maybeSingle();

  if (bcError || !broadcast) {
    throw new BroadcastError('not_found', 'Broadcast not found', 404);
  }

  const { data: rawRows, error: recError } = await db
    .from('broadcast_recipients')
    .select('id, template_params, contact:contacts(phone, opted_out_at)')
    .eq('broadcast_id', broadcastId)
    .in('status', scopeStatuses(scope))
    // Oldest first, so repeated capped passes chew through the backlog
    // in a stable order instead of re-picking the same slice.
    .order('created_at', { ascending: true });

  if (recError) {
    console.error('[broadcast-resume] recipient load failed:', recError.message);
    throw new BroadcastError('internal', 'Failed to load recipients', 500);
  }

  const rows = (rawRows ?? []) as RecipientRow[];

  // A recipient whose contact has no usable phone can never send; one
  // who opted out must never be sent to. Stamp both failed now — left
  // 'pending' they would keep the broadcast in 'sending' forever.
  const sendable: RecipientRow[] = [];
  const noPhone: string[] = [];
  const optedOut: string[] = [];
  for (const row of rows) {
    const contact = contactOf(row);
    if (contact?.opted_out_at) optedOut.push(row.id);
    else if (isValidE164(sanitizePhoneForMeta(contact?.phone ?? ''))) sendable.push(row);
    else noPhone.push(row.id);
  }
  if (noPhone.length > 0) {
    await db
      .from('broadcast_recipients')
      .update({ status: 'failed', error_message: 'No valid phone number on contact' })
      .in('id', noPhone);
  }
  if (optedOut.length > 0) {
    await db
      .from('broadcast_recipients')
      .update({ status: 'failed', error_message: 'Contact opted out' })
      .in('id', optedOut);
  }

  const slice = sendable.slice(0, RESUME_MAX_PER_REQUEST);
  const remaining = sendable.length - slice.length;

  if (slice.length === 0) {
    throw new BroadcastError(
      'nothing_to_resume',
      scope === 'failed'
        ? 'This broadcast has no failed recipients to retry'
        : 'This broadcast has no recipients left to send',
      400,
    );
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

  const templateLanguage = (broadcast.template_language as string) || 'en_US';
  const { data: rawTemplateRow } = await db
    .from('message_templates')
    .select('*')
    .eq('account_id', accountId)
    .eq('name', broadcast.template_name)
    .eq('language', templateLanguage)
    .maybeSingle();
  if (rawTemplateRow && !isMessageTemplate(rawTemplateRow)) {
    throw new BroadcastError(
      'template_malformed',
      'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.',
      500,
    );
  }

  const plan: BroadcastPlan = {
    broadcastId,
    templateName: broadcast.template_name as string,
    templateLanguage,
    phoneNumberId: config.phone_number_id,
    accessToken: decrypt(config.access_token),
    templateRow: rawTemplateRow ?? null,
    headerMediaUrl: (broadcast.header_media_url as string | null) ?? null,
    planned: slice.map((row) => ({
      recipientRowId: row.id,
      phone: sanitizePhoneForMeta(contactOf(row)?.phone ?? ''),
      params: Array.isArray(row.template_params)
        ? row.template_params.filter((p): p is string => typeof p === 'string')
        : [],
    })),
  };

  return { plan, remaining, unsendable: noPhone.length + optedOut.length };
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
