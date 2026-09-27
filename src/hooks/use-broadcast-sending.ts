'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import {
  BATCH_SEND_ATTEMPTS,
  batchRetryDelayMs,
} from '@/lib/broadcast-retry';
import { headerMediaMessageParams } from '@/lib/broadcast-header-media';
import { releaseDeliveryLock } from '@/lib/broadcast-delivery-lock';
import { normalizeKey } from '@/lib/contacts/dedupe';
import { toast } from 'sonner';
import { useLanguage } from '@/hooks/use-language';
import { Contact, MessageTemplate } from '@/types';

export type CustomFieldOperator = 'is' | 'is_not' | 'contains';

export interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

export interface AudienceConfig {
  type: 'all' | 'tags' | 'custom_field' | 'csv';
  tagIds?: string[];
  customField?: CustomFieldFilter;
  csvContacts?: { phone: string; name?: string }[];
  /** Contacts carrying any of these tags are subtracted from the result. */
  excludeTagIds?: string[];
}

/**
 * Variable mapping — each template placeholder (by key, usually "1",
 * "2", …) is resolved at send time. `field` maps to a built-in contact
 * field (name/phone/email/company); `custom_field` maps to a
 * contact_custom_values.value row keyed by the custom_fields.id stored
 * in `value`.
 */
export type VariableMapping =
  | { type: 'static'; value: string }
  | { type: 'field'; value: string }
  | { type: 'custom_field'; value: string };

interface BroadcastPayload {
  name: string;
  template: MessageTemplate;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  /**
   * Media URL for an IMAGE/VIDEO/DOCUMENT header. Required at send
   * time for media-header templates — Meta rejects the send without
   * it. Passed through as `messageParams.headerMediaUrl`; the builder
   * falls back to the template's stored URL only when this is empty.
   */
  headerMediaUrl?: string;
}

interface UseBroadcastSendingReturn {
  createAndSendBroadcast: (payload: BroadcastPayload) => Promise<string>;
  isProcessing: boolean;
  progress: number;
}

/**
 * Meta rate-limit buffer. 10 per batch + 1 s pause matches the spec
 * and keeps us comfortably under Meta's per-phone-number messaging
 * rate so a large broadcast never trips the upstream limiter.
 *
 * Note this shape when touching `RATE_LIMITS.broadcast`: a campaign is
 * many calls to `/api/whatsapp/broadcast`, not one. A 1 000-recipient
 * send is ~100 calls over several minutes, and a bucket sized for
 * "one call per campaign" throttles most of it away (issue #472).
 */
const SEND_BATCH_SIZE = 10;
const SEND_BATCH_DELAY_MS = 1000;

/** `broadcast_recipients` inserts are independent of the send rate. */
const INSERT_BATCH_SIZE = 200;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Response of POST /api/whatsapp/broadcast (row-based, server-stamped). */
interface BroadcastBatchResponse {
  error?: string;
  code?: string;
  lock_token?: string;
  sent?: number;
  failed?: number;
  uncertain?: number;
  skipped?: number;
}

/**
 * IN-lists travel in the URL; ~150 UUIDs / phone numbers keeps a
 * request well under common proxy URL limits (8 KB).
 */
const IN_LIST_PAGE = 150;

/** contactId → (customFieldId → value). */
type CustomValueIndex = Map<string, Map<string, string>>;

/**
 * Per-contact resolution of custom-field placeholders. Static and
 * built-in-field mappings resolve synchronously; custom fields read
 * from a pre-built index to avoid N+1 queries during the send loop.
 */
export function resolveVariables(
  variables: Record<string, VariableMapping>,
  contact: Contact,
  customValues?: Map<string, string>,
): string[] {
  // Keys are typically "1","2",... — numeric-aware sort keeps
  // {{1}} before {{10}}.
  const keys = Object.keys(variables).sort((a, b) => {
    const an = Number(a);
    const bn = Number(b);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
    return a.localeCompare(b);
  });

  return keys.map((key) => {
    const v = variables[key];
    if (v.type === 'static') return v.value;

    if (v.type === 'field') {
      const fieldMap: Record<string, string | undefined> = {
        name: contact.name,
        phone: contact.phone,
        email: contact.email,
        company: contact.company,
      };
      return fieldMap[v.value] ?? '';
    }

    // custom_field
    return customValues?.get(v.value) ?? '';
  });
}

/**
 * Bulk-fetch contact_custom_values for a set of contacts. Returns an
 * index keyed by contact_id → field_id → value.
 */
async function fetchCustomValueIndex(
  supabase: ReturnType<typeof createClient>,
  contactIds: string[],
): Promise<CustomValueIndex> {
  const index: CustomValueIndex = new Map();
  if (contactIds.length === 0) return index;

  // The IN-list goes in the URL — page it (see IN_LIST_PAGE).
  for (let i = 0; i < contactIds.length; i += IN_LIST_PAGE) {
    const slice = contactIds.slice(i, i + IN_LIST_PAGE);
    const { data } = await supabase
      .from('contact_custom_values')
      .select('contact_id, custom_field_id, value')
      .in('contact_id', slice);

    for (const row of data ?? []) {
      const bucket = index.get(row.contact_id) ?? new Map<string, string>();
      bucket.set(row.custom_field_id, row.value ?? '');
      index.set(row.contact_id, bucket);
    }
  }
  return index;
}

export function useBroadcastSending(): UseBroadcastSendingReturn {
  const { accountId } = useAuth();
  const { t } = useLanguage();
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);

  async function resolveAudience(audience: AudienceConfig): Promise<Contact[]> {
    const supabase = createClient();

    let contacts: Contact[] = [];

    if (audience.type === 'all') {
      const { data, error } = await supabase.from('contacts').select('*');
      if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);
      contacts = data ?? [];
    } else if (
      audience.type === 'tags' &&
      audience.tagIds &&
      audience.tagIds.length > 0
    ) {
      const { data: contactTags, error: tagError } = await supabase
        .from('contact_tags')
        .select('contact_id')
        .in('tag_id', audience.tagIds);

      if (tagError)
        throw new Error(`Failed to fetch contact tags: ${tagError.message}`);

      if (contactTags && contactTags.length > 0) {
        const uniqueContactIds = [
          ...new Set(contactTags.map((ct) => ct.contact_id)),
        ];
        const { data, error } = await supabase
          .from('contacts')
          .select('*')
          .in('id', uniqueContactIds);
        if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);
        contacts = data ?? [];
      }
    } else if (audience.type === 'custom_field' && audience.customField) {
      contacts = await resolveCustomFieldAudience(supabase, audience.customField);
    } else if (audience.type === 'csv' && audience.csvContacts) {
      contacts = await upsertCsvContacts(supabase, audience.csvContacts);
    }

    // Apply exclude tags (works across all contact-derived audience
    // types). CSV contacts are synthetic so exclusion doesn't apply.
    if (audience.excludeTagIds && audience.excludeTagIds.length > 0) {
      const { data: excludeRows } = await supabase
        .from('contact_tags')
        .select('contact_id')
        .in('tag_id', audience.excludeTagIds);
      const excludedIds = new Set((excludeRows ?? []).map((r) => r.contact_id));
      contacts = contacts.filter((c) => !excludedIds.has(c.id));
    }

    // Opt-out (migration 030): contacts who asked to stop never make it
    // into broadcast_recipients. The API route re-checks by phone as a
    // second line of defence.
    contacts = contacts.filter((c) => !c.opted_out_at);

    return contacts;
  }

  /**
   * CSV uploads arrive as raw phone/name pairs, not DB rows. Before we
   * can insert broadcast_recipients (whose contact_id FKs contacts.id),
   * we need real contacts.id UUIDs. So: look up each CSV phone in the
   * caller's contacts table; insert any that don't exist; return the
   * resolved set.
   *
   * Pre-existing implementation synthesized `csv-N` strings as
   * contact_id, which failed the UUID cast on insert — every CSV
   * broadcast silently created zero recipients.
   *
   * Matching is on the normalized number throughout (wacrm #512), so it
   * agrees with the account-wide unique index rather than colliding
   * with it.
   */
  async function upsertCsvContacts(
    supabase: ReturnType<typeof createClient>,
    csvRows: { phone: string; name?: string }[],
  ): Promise<Contact[]> {
    if (csvRows.length === 0) return [];

    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      throw new Error('You are not signed in.');
    }
    if (!accountId) {
      throw new Error('Your profile is not linked to an account.');
    }

    // De-duplicate within the CSV on the NORMALIZED number — the same
    // key the DB's UNIQUE (account_id, phone_normalized) index uses
    // (migration 022). Keyed on the raw string instead, "+55 11 9…" and
    // "5511…" survived as two rows and the insert below died on a 23505,
    // failing the whole broadcast.
    const uniqueByKey = new Map<string, { phone: string; name?: string }>();
    for (const row of csvRows) {
      const key = normalizeKey(row.phone);
      if (key && !uniqueByKey.has(key)) uniqueByKey.set(key, row);
    }
    const keys = [...uniqueByKey.keys()];

    // Lookup of the contacts already in this ACCOUNT, in pages (PostgREST
    // caps the IN-list). Scoping to `user_id` missed rows a teammate
    // created on the shared account, so those numbers looked new and
    // their inserts collided with the account-wide unique index.
    const byKey = new Map<string, Contact>();
    for (let i = 0; i < keys.length; i += IN_LIST_PAGE) {
      const { data: existing, error: lookupErr } = await supabase
        .from('contacts')
        .select('*')
        .eq('account_id', accountId)
        .in('phone_normalized', keys.slice(i, i + IN_LIST_PAGE));
      if (lookupErr) {
        throw new Error(`Failed to look up CSV contacts: ${lookupErr.message}`);
      }
      for (const c of (existing ?? []) as Contact[]) {
        const key = normalizeKey(c.phone ?? '');
        if (key) byKey.set(key, c);
      }
    }

    // Insert only missing contacts, in one batch per 200 rows (PostgREST
    // has a default payload cap — 200 keeps individual requests small).
    const missing = keys
      .filter((k) => !byKey.has(k))
      .map((k) => uniqueByKey.get(k)!)
      .map((row) => ({
        user_id: user.id,
        account_id: accountId,
        phone: row.phone,
        name: row.name ?? null,
      }));

    const INSERT_CHUNK = 200;
    for (let i = 0; i < missing.length; i += INSERT_CHUNK) {
      const chunk = missing.slice(i, i + INSERT_CHUNK);
      const { data: inserted, error: insertErr } = await supabase
        .from('contacts')
        .insert(chunk)
        .select();
      if (insertErr) {
        throw new Error(`Failed to create CSV contacts: ${insertErr.message}`);
      }
      for (const c of (inserted ?? []) as Contact[]) {
        const key = normalizeKey(c.phone ?? '');
        if (key) byKey.set(key, c);
      }
    }

    // Preserve input order so analytics roughly matches the CSV order.
    return keys
      .map((k) => byKey.get(k))
      .filter((c): c is Contact => Boolean(c));
  }

  async function resolveCustomFieldAudience(
    supabase: ReturnType<typeof createClient>,
    filter: CustomFieldFilter,
  ): Promise<Contact[]> {
    const { fieldId, operator, value } = filter;

    // Build the WHERE clause for the operator. PostgREST supports
    // eq/neq/ilike via the query builder — use ilike with wildcards
    // for "contains" so the match is case-insensitive.
    let query = supabase
      .from('contact_custom_values')
      .select('contact_id')
      .eq('custom_field_id', fieldId);

    if (operator === 'is') query = query.eq('value', value);
    else if (operator === 'is_not') query = query.neq('value', value);
    else if (operator === 'contains') query = query.ilike('value', `%${value}%`);

    const { data: matches, error: matchErr } = await query;
    if (matchErr)
      throw new Error(`Custom-field filter failed: ${matchErr.message}`);

    const contactIds = [...new Set((matches ?? []).map((m) => m.contact_id))];
    if (contactIds.length === 0) return [];

    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .in('id', contactIds);
    if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);
    return data ?? [];
  }

  async function createAndSendBroadcast(payload: BroadcastPayload): Promise<string> {
    setIsProcessing(true);
    setProgress(0);

    const supabase = createClient();
    // This tab's delivery lock (migration 051): the broadcast id plus MY
    // token. The server renews it per batch and hands back the next token;
    // releasing is conditional on the token, so this tab can never clear a
    // lock a resume pass took over. Cleared once released.
    let held: { id: string; token: string } | null = null;

    try {
      // ── Step 0: Resolve current user ──────────────────────────────
      // broadcasts.user_id is NOT NULL + guarded by RLS
      // (auth.uid() = user_id). Without this, the INSERT below was
      // silently failing with 23502 / 42501 — the wizard would
      // no-op with no feedback.
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) {
        throw new Error('You are not signed in.');
      }
      if (!accountId) {
        throw new Error('Your profile is not linked to an account.');
      }

      // ── Step 1: Resolve audience contacts ─────────────────────────
      setProgress(5);
      const contacts = await resolveAudience(payload.audience);

      if (contacts.length === 0) {
        throw new Error('No contacts found for this audience.');
      }

      // ── Step 2: Create broadcast row ──────────────────────────────
      setProgress(10);
      const { data: broadcast, error: broadcastError } = await supabase
        .from('broadcasts')
        .insert({
          user_id: user.id,
          account_id: accountId,
          name: payload.name,
          template_name: payload.template.name,
          template_language: payload.template.language ?? 'en_US',
          template_variables: payload.variables,
          // Frozen for a server-side resume (migration 051, #298/#472).
          header_media_url:
            headerMediaMessageParams(payload.template, payload.headerMediaUrl)
              ?.headerMediaUrl ?? null,
          // Per-row claim protocol (migration 051) — not a legacy campaign.
          delivery_protocol: 1,
          audience_filter: {
            type: payload.audience.type,
            tagIds: payload.audience.tagIds,
            customField: payload.audience.customField,
            excludeTagIds: payload.audience.excludeTagIds,
          },
          status: 'sending',
          total_recipients: contacts.length,
          sent_count: 0,
          delivered_count: 0,
          read_count: 0,
          replied_count: 0,
          failed_count: 0,
        })
        .select()
        .single();

      if (broadcastError || !broadcast) {
        throw new Error(
          `Failed to create broadcast: ${broadcastError?.message ?? 'unknown error'}`,
        );
      }

      // This tab is the delivery pass: the SERVER takes the lock and mints
      // the first token from its own clock (renewed per batch), so
      // "Retomar" can't start while this tab sends.
      const startRes = await fetch(`/api/whatsapp/broadcast/${broadcast.id}/start`, {
        method: 'POST',
      });
      const startData = (await startRes.json().catch(() => ({}))) as BroadcastBatchResponse;
      if (!startRes.ok || !startData.lock_token) {
        throw new Error(startData.error || 'Could not start the broadcast');
      }
      held = { id: broadcast.id, token: startData.lock_token };

      // ── Step 3: Insert recipient rows ─────────────────────────────
      // Custom values are fetched BEFORE the insert so each row can
      // carry its resolved template params (migration 051). Those params
      // are what makes the campaign resumable server-side (wacrm #472):
      // the send loop below runs in this browser tab, and if the tab goes
      // away the only record of what {{1}} should be for each contact is
      // this column. Resolving once here also means a resume sends
      // exactly what this pass would have.
      setProgress(20);
      const customValueIndex = await fetchCustomValueIndex(
        supabase,
        contacts.map((c) => c.id),
      );
      const recipientRows = contacts.map((contact) => ({
        broadcast_id: broadcast.id,
        contact_id: contact.id,
        status: 'pending' as const,
        template_params: resolveVariables(
          payload.variables,
          contact,
          customValueIndex.get(contact.id),
        ),
      }));

      // Ids come back from the insert itself — a later SELECT would be
      // capped at 1000 rows by PostgREST and silently drop the rest.
      const recipientIds: string[] = [];
      for (let i = 0; i < recipientRows.length; i += INSERT_BATCH_SIZE) {
        const batch = recipientRows.slice(i, i + INSERT_BATCH_SIZE);
        const { data: insertedRows, error: recipientError } = await supabase
          .from('broadcast_recipients')
          .insert(batch)
          .select('id');
        if (recipientError) {
          // Previous impl logged and marched on — the broadcast then ran
          // with an incomplete recipient set, so webhook status updates
          // couldn't find some rows and the aggregate counts drifted.
          // Flip the broadcast to failed so the user sees the problem
          // immediately, then throw to abort the send loop.
          await supabase
            .from('broadcasts')
            .update({
              status: 'failed',
              failed_count: contacts.length,
              delivery_locked_at: null,
            })
            .eq('id', broadcast.id)
            .eq('delivery_locked_at', held.token);
          held = null;
          throw new Error(
            `Failed to insert recipient batch ${i / INSERT_BATCH_SIZE + 1}: ${recipientError.message}`,
          );
        }
        for (const r of (insertedRows ?? []) as { id: string }[]) recipientIds.push(r.id);
      }

      // ── Step 4: Send, one server-side batch at a time ─────────────
      // The SERVER claims each row (pending → sending, atomically), sends
      // it and stamps sent / failed / uncertain itself. This tab only
      // passes row ids: it never stamps rows, so a reload, a second tab or
      // a resume pass can't make anyone get the message twice — a row
      // someone else already claimed just comes back 'skipped'.
      setProgress(30);
      const totalRecipients = recipientIds.length;
      let stopReason: string | null = null;
      let uncertainCount = 0;

      for (let i = 0; i < recipientIds.length; i += SEND_BATCH_SIZE) {
        const batchIds = recipientIds.slice(i, i + SEND_BATCH_SIZE);
        if (!held) break;
        const token = held.token;

        let data: BroadcastBatchResponse = {};
        let ok = false;
        try {
          // Only a 429 is replayed: the route rate-limits BEFORE it
          // claims or sends anything (see batchRetryDelayMs).
          for (let attempt = 1; ; attempt++) {
            const res = await fetch('/api/whatsapp/broadcast', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                broadcast_id: broadcast.id,
                recipient_ids: batchIds,
                lock_token: token,
              }),
            });
            data = await res.json().catch(() => ({}));
            if (res.ok) {
              ok = true;
              break;
            }
            const retryIn =
              attempt < BATCH_SEND_ATTEMPTS
                ? batchRetryDelayMs(res.status, res.headers.get('Retry-After'))
                : null;
            if (retryIn === null) break;
            await sleep(retryIn);
          }
        } catch (err) {
          // Network drop: the server may or may not have processed the
          // batch. Its rows are stamped (or expire to 'uncertain')
          // server-side — never re-sent from here.
          data = { error: err instanceof Error ? err.message : 'Network error' };
        }

        if (!ok) {
          if (data.code === 'delivery_lock_lost') held = null;
          stopReason = data.error || 'Broadcast API request failed';
          break;
        }
        if (data.lock_token && held) held = { ...held, token: data.lock_token };
        uncertainCount += data.uncertain ?? 0;

        setProgress(30 + Math.round(((i + batchIds.length) / totalRecipients) * 65));

        if (i + SEND_BATCH_SIZE < recipientIds.length) {
          await sleep(SEND_BATCH_DELAY_MS);
        }
      }

      // ── Step 5: Finish ────────────────────────────────────────────
      // The final status is settled server-side from the rows
      // (finalizeBroadcastStatus); counts are trigger-owned (003/005).
      if (stopReason) {
        toast.warning(
          `${t('The broadcast stopped before finishing')}: ${stopReason}`,
        );
      } else if (uncertainCount > 0) {
        toast.warning(
          `${t('Recipients with an uncertain result (not resent)')}: ${uncertainCount}`,
        );
      }
      setProgress(100);
      return broadcast.id;
    } finally {
      if (held) {
        // Release MY lock (a no-op if someone else holds it now), so the
        // detail page can resume the rest right away.
        await releaseDeliveryLock(supabase, held.id, held.token).catch(() => undefined);
      }
      setIsProcessing(false);
    }
  }

  return { createAndSendBroadcast, isProcessing, progress };
}
