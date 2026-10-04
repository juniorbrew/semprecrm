// ============================================================
// Broadcast audience — ONE definition of "who this broadcast reaches",
// shared by the wizard's estimate (steps 2 and 4) and the recipient
// creation in use-broadcast-sending, so the number shown is the number
// sent to.
//
//   candidates (audience filter)
//     − duplicates (same contact id / same normalized number)
//     − contacts carrying an excluded tag
//     − opted-out or anonymised contacts           → no recipient row
//   = recipients (rows in broadcast_recipients)
//     − no valid phone      (the sender stamps them failed)
//     − suppression list    (the sender blocks them, migration 077)
//   = eligible (actually sent)
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeKey } from '@/lib/contacts/dedupe';
import { isValidE164, sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';

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

export interface AudienceContact {
  id: string;
  phone?: string | null;
  opted_out_at?: string | null;
  anonymized_at?: string | null;
}

/** Each selected contact lands in exactly one bucket. */
export interface AudienceBreakdown {
  selected: number;
  duplicate: number;
  excludedByTag: number;
  /** Opted out or anonymised. */
  optedOut: number;
  noPhone: number;
  suppressed: number;
  eligible: number;
}

export function buildAudience<T extends AudienceContact>(
  candidates: readonly T[],
  opts: { excludedIds?: ReadonlySet<string>; suppressed?: ReadonlySet<string> } = {},
): { recipients: T[]; breakdown: AudienceBreakdown } {
  const b: AudienceBreakdown = {
    selected: candidates.length,
    duplicate: 0,
    excludedByTag: 0,
    optedOut: 0,
    noPhone: 0,
    suppressed: 0,
    eligible: 0,
  };
  const recipients: T[] = [];
  const seenIds = new Set<string>();
  const seenNumbers = new Set<string>();

  for (const c of candidates) {
    const number = normalizeKey(c.phone ?? '');
    if (seenIds.has(c.id) || (number && seenNumbers.has(number))) {
      b.duplicate++;
      continue;
    }
    seenIds.add(c.id);
    if (number) seenNumbers.add(number);

    if (opts.excludedIds?.has(c.id)) b.excludedByTag++;
    else if (c.opted_out_at || c.anonymized_at) b.optedOut++;
    else {
      recipients.push(c);
      // Same checks, same order as broadcast-core's sendClaimedRows.
      if (!isValidE164(sanitizePhoneForMeta(c.phone ?? ''))) b.noPhone++;
      else if (opts.suppressed?.has(number)) b.suppressed++;
      else b.eligible++;
    }
  }
  return { recipients, breakdown: b };
}

// ── Loaders (browser client, RLS-scoped, read-only) ──────────────

/** IN-lists travel in the URL — keep each request well under 8 KB. */
const IN_LIST_PAGE = 150;

/**
 * Contacts matched by an all / tags / custom-field audience (CSV rows
 * are not contacts yet — the caller resolves them). `[]` while the
 * audience is only partly configured.
 */
export async function fetchAudienceContacts<T>(
  db: SupabaseClient,
  audience: AudienceConfig,
  columns: string,
): Promise<T[]> {
  let ids: string[];
  if (audience.type === 'all') {
    const { data, error } = await db.from('contacts').select(columns);
    if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);
    return (data ?? []) as T[];
  } else if (audience.type === 'tags' && audience.tagIds && audience.tagIds.length > 0) {
    const { data, error } = await db.from('contact_tags').select('contact_id').in('tag_id', audience.tagIds);
    if (error) throw new Error(`Failed to fetch contact tags: ${error.message}`);
    ids = (data ?? []).map((r) => r.contact_id as string);
  } else if (audience.type === 'custom_field' && audience.customField) {
    const { fieldId, operator, value } = audience.customField;
    // eq/neq/ilike — ilike with wildcards makes "contains" case-insensitive.
    let q = db.from('contact_custom_values').select('contact_id').eq('custom_field_id', fieldId);
    if (operator === 'is') q = q.eq('value', value);
    else if (operator === 'is_not') q = q.neq('value', value);
    else q = q.ilike('value', `%${value}%`);
    const { data, error } = await q;
    if (error) throw new Error(`Custom-field filter failed: ${error.message}`);
    ids = (data ?? []).map((r) => r.contact_id as string);
  } else {
    return [];
  }

  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const { data, error } = await db.from('contacts').select(columns).in('id', unique);
  if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);
  return (data ?? []) as T[];
}

/** Ids of the contacts carrying any excluded tag. */
export async function fetchExcludedIds(db: SupabaseClient, excludeTagIds?: string[]): Promise<Set<string>> {
  if (!excludeTagIds || excludeTagIds.length === 0) return new Set();
  const { data, error } = await db.from('contact_tags').select('contact_id').in('tag_id', excludeTagIds);
  if (error) throw new Error(`Failed to fetch excluded tags: ${error.message}`);
  return new Set((data ?? []).map((r) => r.contact_id as string));
}

const ESTIMATE_COLUMNS = 'id, phone, opted_out_at, anonymized_at';

/**
 * CSV rows as candidates without writing anything: the account's
 * existing contact for the number (its opt-out and tags count), else a
 * stand-in for the contact the send would create.
 */
async function csvCandidates(
  db: SupabaseClient,
  accountId: string,
  rows: { phone: string }[],
): Promise<AudienceContact[]> {
  const keys = [...new Set(rows.map((r) => normalizeKey(r.phone)).filter(Boolean))];
  const byKey = new Map<string, AudienceContact>();
  for (let i = 0; i < keys.length; i += IN_LIST_PAGE) {
    const { data, error } = await db
      .from('contacts')
      .select(ESTIMATE_COLUMNS)
      .eq('account_id', accountId)
      .in('phone_normalized', keys.slice(i, i + IN_LIST_PAGE));
    if (error) throw new Error(`Failed to look up CSV contacts: ${error.message}`);
    for (const c of (data ?? []) as unknown as AudienceContact[]) byKey.set(normalizeKey(c.phone ?? ''), c);
  }
  return rows.map((r, i) => byKey.get(normalizeKey(r.phone)) ?? { id: `csv:${i}`, phone: r.phone });
}

/** Phones per suppression-check call (the route's cap). */
export const SUPPRESSION_CHECK_MAX = 500;

/**
 * The given normalized numbers that are on the suppression list. The list
 * is service-role only, so the browser asks the server.
 */
async function fetchSuppressed(numbers: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < numbers.length; i += SUPPRESSION_CHECK_MAX) {
    const res = await fetch('/api/contacts/suppressions/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phones: numbers.slice(i, i + SUPPRESSION_CHECK_MAX) }),
    });
    if (!res.ok) throw new Error(`suppression check failed: ${res.status}`);
    const body = (await res.json()) as { suppressed?: string[] };
    for (const n of body.suppressed ?? []) out.add(n);
  }
  return out;
}

export interface AudienceEstimate {
  breakdown: AudienceBreakdown;
  /** False when the suppression list couldn't be read: eligible is an upper bound. */
  suppressionChecked: boolean;
}

/** The estimate both wizard steps show. `null` while the audience is incomplete. */
export async function estimateAudience(
  db: SupabaseClient,
  audience: AudienceConfig,
  accountId: string | null,
): Promise<AudienceEstimate | null> {
  let candidates: AudienceContact[];
  if (audience.type === 'csv') {
    if (!audience.csvContacts?.length || !accountId) return null;
    candidates = await csvCandidates(db, accountId, audience.csvContacts);
  } else {
    const ready =
      audience.type === 'all' ||
      (audience.type === 'tags' && !!audience.tagIds?.length) ||
      (audience.type === 'custom_field' && !!audience.customField?.fieldId && !!audience.customField.value);
    if (!ready) return null;
    candidates = await fetchAudienceContacts<AudienceContact>(db, audience, ESTIMATE_COLUMNS);
  }

  const excludedIds = await fetchExcludedIds(db, audience.excludeTagIds);
  const first = buildAudience(candidates, { excludedIds });
  const numbers = first.recipients
    .filter((c) => isValidE164(sanitizePhoneForMeta(c.phone ?? '')))
    .map((c) => normalizeKey(c.phone ?? ''));
  if (numbers.length === 0) return { breakdown: first.breakdown, suppressionChecked: true };

  try {
    const suppressed = await fetchSuppressed(numbers);
    return { breakdown: buildAudience(candidates, { excludedIds, suppressed }).breakdown, suppressionChecked: true };
  } catch {
    return { breakdown: first.breakdown, suppressionChecked: false };
  }
}
