// ============================================================
// Lead ingestion — the part of the webhook that touches the DB.
//
//   map fields → validate phone → dedupe contact (update empties /
//   create) → custom values → tags → deal (unless an open one exists
//   in the same pipeline) → counters → event row
//
// Takes the Supabase admin client as a parameter (no `next/*`, no
// engine imports) so it is unit-testable with an in-memory mock, the
// same way `src/lib/whatsapp/inbound.ts` is. Firing automations is the
// route's job — it needs the result (`contactCreated`) anyway.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { isValidE164, normalizePhone } from '@/lib/whatsapp/phone-utils'
import type { LeadSource, LeadSourceEventStatus } from '@/types'

import { mapLeadFields, type MappedLead } from './map-fields'
import type { LeadPayload } from './parse-body'

export interface IngestLeadResult {
  status: LeadSourceEventStatus
  /** HTTP status the route should answer with. */
  httpStatus: 200 | 400 | 500
  /** Machine-readable reason when `status === 'error'`. */
  error?: string
  contactId?: string
  dealId?: string
  /** True when the phone matched an existing contact. */
  duplicate: boolean
  /** True when this call created the contact row. */
  contactCreated: boolean
  /** Name the contact ended up with — handy for logs / deal titles. */
  contactName?: string | null
}

/** Source columns the ingest reads — everything the route selects. */
export type IngestLeadSource = Pick<
  LeadSource,
  | 'id'
  | 'account_id'
  | 'name'
  | 'pipeline_id'
  | 'stage_id'
  | 'tag_ids'
  | 'assignee_user_id'
  | 'field_map'
  | 'received_count'
>

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any

const nowIso = () => new Date().toISOString()

/** Deal title per spec: "<nome ou telefone> · <fonte>". */
export function leadDealTitle(name: string | null | undefined, phone: string, sourceName: string): string {
  return `${(name ?? '').trim() || phone} · ${sourceName}`
}

async function recordEvent(
  db: SupabaseClient,
  source: IngestLeadSource,
  payload: LeadPayload,
  status: LeadSourceEventStatus,
  extra: { error?: string | null; contactId?: string | null; dealId?: string | null },
): Promise<void> {
  const { error } = await db.from('lead_source_events').insert({
    account_id: source.account_id,
    source_id: source.id,
    status,
    error: extra.error ?? null,
    contact_id: extra.contactId ?? null,
    deal_id: extra.dealId ?? null,
    payload,
  })
  if (error) console.error('[lead-capture] event insert failed:', error.message)
}

async function bumpCounters(db: SupabaseClient, source: IngestLeadSource): Promise<void> {
  const { error } = await db
    .from('lead_sources')
    .update({
      received_count: (source.received_count ?? 0) + 1,
      last_received_at: nowIso(),
    })
    .eq('id', source.id)
  if (error) console.error('[lead-capture] counter update failed:', error.message)
}

/** Every outcome — success or not — is counted and logged. */
async function finish(
  db: SupabaseClient,
  source: IngestLeadSource,
  payload: LeadPayload,
  result: IngestLeadResult,
): Promise<IngestLeadResult> {
  await bumpCounters(db, source)
  await recordEvent(db, source, payload, result.status, {
    error: result.error ?? null,
    contactId: result.contactId ?? null,
    dealId: result.dealId ?? null,
  })
  return result
}

function fail(reason: string, httpStatus: 400 | 500 = 500): IngestLeadResult {
  return { status: 'error', httpStatus, error: reason, duplicate: false, contactCreated: false }
}

interface ContactOutcome {
  id: string
  name: string | null
  created: boolean
}

/**
 * Dedupe by normalized phone. An existing contact only gets the fields
 * it is missing (never overwrite what an agent typed); a new one is
 * created with everything the payload offered.
 */
async function upsertContact(
  db: SupabaseClient,
  source: IngestLeadSource,
  ownerUserId: string,
  phone: string,
  lead: MappedLead,
): Promise<ContactOutcome | { error: string }> {
  const existing = await findExistingContact(db, source.account_id, phone)
  if (existing) {
    const patch: Record<string, unknown> = {}
    const row = existing as Row
    if (lead.name && !(row.name ?? '').trim()) patch.name = lead.name
    if (lead.email && !(row.email ?? '').trim()) patch.email = lead.email
    if (lead.company && !(row.company ?? '').trim()) patch.company = lead.company
    if (Object.keys(patch).length > 0) {
      const { error } = await db
        .from('contacts')
        .update({ ...patch, updated_at: nowIso() })
        .eq('id', existing.id)
      if (error) return { error: `contact_update_failed: ${error.message}` }
    }
    return {
      id: existing.id,
      name: (patch.name as string | undefined) ?? row.name ?? null,
      created: false,
    }
  }

  const insert = {
    account_id: source.account_id,
    user_id: ownerUserId,
    phone,
    name: lead.name ?? phone,
    email: lead.email,
    company: lead.company,
  }
  const { data, error } = await db.from('contacts').insert(insert).select().single()
  if (error) {
    // Lost a race with a concurrent submission — the unique index on
    // phone_normalized (migration 022) rejected us; re-resolve.
    if (isUniqueViolation(error)) {
      const raced = await findExistingContact(db, source.account_id, phone)
      if (raced) return { id: raced.id, name: (raced.name as string | null) ?? null, created: false }
    }
    return { error: `contact_insert_failed: ${error.message}` }
  }
  return { id: (data as Row).id as string, name: insert.name, created: true }
}

async function writeCustomValues(
  db: SupabaseClient,
  source: IngestLeadSource,
  contactId: string,
  custom: Record<string, string>,
): Promise<void> {
  const ids = Object.keys(custom)
  if (ids.length === 0) return
  // Only fields of this account — the map is admin-edited, but the
  // service-role client would happily write to a foreign field id.
  const { data: fields, error } = await db
    .from('custom_fields')
    .select('id')
    .eq('account_id', source.account_id)
    .in('id', ids)
  if (error) {
    console.error('[lead-capture] custom_fields lookup failed:', error.message)
    return
  }
  const allowed = new Set(((fields ?? []) as Row[]).map((f) => f.id as string))
  const rows = ids
    .filter((id) => allowed.has(id))
    .map((id) => ({ contact_id: contactId, custom_field_id: id, value: custom[id] }))
  if (rows.length === 0) return
  const { error: upErr } = await db
    .from('contact_custom_values')
    .upsert(rows, { onConflict: 'contact_id,custom_field_id' })
  if (upErr) console.error('[lead-capture] custom values upsert failed:', upErr.message)
}

async function applyTags(
  db: SupabaseClient,
  source: IngestLeadSource,
  contactId: string,
): Promise<void> {
  const tagIds = (source.tag_ids ?? []).filter(Boolean)
  if (tagIds.length === 0) return
  const { data: tags, error } = await db
    .from('tags')
    .select('id')
    .eq('account_id', source.account_id)
    .in('id', tagIds)
  if (error) {
    console.error('[lead-capture] tags lookup failed:', error.message)
    return
  }
  const rows = ((tags ?? []) as Row[]).map((t) => ({ contact_id: contactId, tag_id: t.id as string }))
  if (rows.length === 0) return
  const { error: upErr } = await db
    .from('contact_tags')
    .upsert(rows, { onConflict: 'contact_id,tag_id', ignoreDuplicates: true })
  if (upErr) console.error('[lead-capture] tag upsert failed:', upErr.message)
}

/**
 * Create the deal the source points at, unless the contact already has
 * an open deal in that pipeline (a returning lead shouldn't clutter the
 * board). Returns the created deal id or null.
 */
async function maybeCreateDeal(
  db: SupabaseClient,
  source: IngestLeadSource,
  ownerUserId: string,
  currency: string,
  contactId: string,
  title: string,
): Promise<string | null> {
  if (!source.pipeline_id || !source.stage_id) return null

  const { data: open, error: openErr } = await db
    .from('deals')
    .select('id')
    .eq('account_id', source.account_id)
    .eq('contact_id', contactId)
    .eq('pipeline_id', source.pipeline_id)
    .eq('status', 'open')
    .limit(1)
  if (openErr) {
    console.error('[lead-capture] open deal lookup failed:', openErr.message)
    return null
  }
  if (open && (open as Row[]).length > 0) return null

  // deals.assigned_to points at profiles.id, the source stores auth uid.
  let assignedTo: string | null = null
  if (source.assignee_user_id) {
    const { data: prof } = await db
      .from('profiles')
      .select('id')
      .eq('user_id', source.assignee_user_id)
      .maybeSingle()
    assignedTo = ((prof as Row | null)?.id as string | undefined) ?? null
  }

  const { data, error } = await db
    .from('deals')
    .insert({
      account_id: source.account_id,
      user_id: ownerUserId,
      pipeline_id: source.pipeline_id,
      stage_id: source.stage_id,
      contact_id: contactId,
      title,
      value: 0,
      currency,
      status: 'open',
      assigned_to: assignedTo,
    })
    .select('id')
    .single()
  if (error) {
    console.error('[lead-capture] deal insert failed:', error.message)
    return null
  }
  return ((data as Row)?.id as string | undefined) ?? null
}

/**
 * Ingest one lead payload for an active source. Never throws; every
 * outcome is recorded as a `lead_source_events` row and bumps the
 * source counters.
 */
export async function ingestLead(
  db: SupabaseClient,
  source: IngestLeadSource,
  payload: LeadPayload,
): Promise<IngestLeadResult> {
  try {
    const lead = mapLeadFields(payload, source.field_map)

    const phone = normalizePhone(lead.phone ?? '')
    if (!phone) {
      return finish(db, source, payload, fail('phone_missing', 400))
    }
    if (!isValidE164(phone)) {
      return finish(db, source, payload, fail('phone_invalid', 400))
    }

    // Sender-of-record for the NOT NULL `user_id` columns + currency
    // for the deal, in one read.
    const { data: acct, error: acctErr } = await db
      .from('accounts')
      .select('owner_user_id, default_currency')
      .eq('id', source.account_id)
      .maybeSingle()
    const ownerUserId = (acct as Row | null)?.owner_user_id as string | undefined
    if (acctErr || !ownerUserId) {
      return finish(db, source, payload, fail('account_owner_not_found'))
    }
    const currency = ((acct as Row).default_currency as string | undefined) ?? 'USD'

    const contact = await upsertContact(db, source, ownerUserId, phone, lead)
    if ('error' in contact) {
      return finish(db, source, payload, fail(contact.error))
    }

    await writeCustomValues(db, source, contact.id, lead.custom)
    await applyTags(db, source, contact.id)

    const dealId = await maybeCreateDeal(
      db,
      source,
      ownerUserId,
      currency,
      contact.id,
      leadDealTitle(contact.name, phone, source.name),
    )

    return finish(db, source, payload, {
      status: contact.created ? 'ok' : 'duplicate',
      httpStatus: 200,
      contactId: contact.id,
      dealId: dealId ?? undefined,
      duplicate: !contact.created,
      contactCreated: contact.created,
      contactName: contact.name,
    })
  } catch (err) {
    console.error('[lead-capture] ingest failed:', err)
    const message = err instanceof Error ? err.message : String(err)
    return finish(db, source, payload, fail(`unexpected: ${message}`))
  }
}
