// ============================================================
// Browser-side reads/writes for Configurações → Integrações. RLS does
// the gating (viewer+ reads, admin+ writes). Creating a source and
// rotating its token go through /api/lead-sources — the token must be
// minted server-side.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import type { LeadSource, LeadSourceEvent, LeadSourceFieldMap } from '@/types'

import { normalizeFieldMap } from './map-fields'

export const LEAD_SOURCE_COLUMNS =
  'id, account_id, name, token, is_active, pipeline_id, stage_id, tag_ids, assignee_user_id, field_map, received_count, last_received_at, created_by, created_at, updated_at'

function normalizeSource(row: Record<string, unknown>): LeadSource {
  return {
    ...(row as unknown as LeadSource),
    tag_ids: Array.isArray(row.tag_ids) ? (row.tag_ids as string[]) : [],
    field_map: normalizeFieldMap(row.field_map),
  }
}

export async function listLeadSources(db: SupabaseClient, accountId: string): Promise<LeadSource[]> {
  const { data, error } = await db
    .from('lead_sources')
    .select(LEAD_SOURCE_COLUMNS)
    .eq('account_id', accountId)
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  return ((data ?? []) as Record<string, unknown>[]).map(normalizeSource)
}

export interface LeadSourcePatch {
  name?: string
  is_active?: boolean
  pipeline_id?: string | null
  stage_id?: string | null
  tag_ids?: string[]
  assignee_user_id?: string | null
  field_map?: LeadSourceFieldMap
}

export async function updateLeadSource(
  db: SupabaseClient,
  id: string,
  patch: LeadSourcePatch,
): Promise<LeadSource> {
  const { data, error } = await db
    .from('lead_sources')
    .update(patch)
    .eq('id', id)
    .select(LEAD_SOURCE_COLUMNS)
    .single()
  if (error) throw new Error(error.message)
  return normalizeSource(data as Record<string, unknown>)
}

export async function deleteLeadSource(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db.from('lead_sources').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

export const LEAD_EVENTS_LIMIT = 50

export async function listLeadSourceEvents(
  db: SupabaseClient,
  sourceId: string,
  limit = LEAD_EVENTS_LIMIT,
): Promise<LeadSourceEvent[]> {
  const { data, error } = await db
    .from('lead_source_events')
    .select('id, account_id, source_id, status, error, contact_id, deal_id, payload, created_at, contact:contacts(id, name, phone)')
    .eq('source_id', sourceId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(error.message)
  return ((data ?? []) as unknown as (LeadSourceEvent & { contact: unknown })[]).map((e) => ({
    ...e,
    payload: e.payload && typeof e.payload === 'object' ? e.payload : {},
    contact: Array.isArray(e.contact) ? ((e.contact[0] as LeadSourceEvent['contact']) ?? null) : ((e.contact as LeadSourceEvent['contact']) ?? null),
  }))
}
