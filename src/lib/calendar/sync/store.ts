// ============================================================
// Calendar sync — the persistence the engine needs, as a small
// interface (`SyncStore`) plus its Supabase service-role implementation.
// The engine is tested against an in-memory store; this file is the
// thin query glue.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { parseAccountPreferences } from '@/lib/account-preferences'
import type { CalendarConnection, CalendarEvent, CalendarProvider } from '@/types'

import { safeTimezone } from '../range'

/** The event columns the engine reads / writes. */
export type SyncEventRow = Pick<
  CalendarEvent,
  | 'id'
  | 'account_id'
  | 'owner_user_id'
  | 'title'
  | 'description'
  | 'location'
  | 'starts_at'
  | 'ends_at'
  | 'all_day'
  | 'status'
  | 'source'
  | 'external_connection_id'
  | 'external_id'
  | 'external_etag'
  | 'external_updated_at'
  | 'sync_hash'
  | 'created_by'
  | 'updated_at'
>

export const SYNC_EVENT_COLUMNS =
  'id, account_id, owner_user_id, title, description, location, starts_at, ends_at, all_day, status, source, external_connection_id, external_id, external_etag, external_updated_at, sync_hash, created_by, updated_at'

export type SyncEventInsert = Omit<SyncEventRow, 'id' | 'updated_at'>
export type SyncEventPatch = Partial<Omit<SyncEventRow, 'id' | 'account_id'>>

export type ConnectionPatch = Partial<
  Pick<
    CalendarConnection,
    | 'access_token_enc'
    | 'refresh_token_enc'
    | 'token_expires_at'
    | 'sync_cursor'
    | 'last_sync_at'
    | 'last_error'
    | 'status'
    | 'email'
  >
>

export interface SyncStore {
  /** IANA zone of the account (`preferences.business_hours.timezone`). */
  accountTimezone(accountId: string): Promise<string>
  /** Users of the account with an active connection (any provider). */
  connectedUserIds(accountId: string): Promise<Set<string>>
  /** Rows bound to the connection, changed since `since` (null = all). */
  boundEvents(connectionId: string, since: string | null): Promise<SyncEventRow[]>
  /** Unbound rows the user owns, ending after `notBefore`. */
  unboundOwnedEvents(accountId: string, userId: string, notBefore: string): Promise<SyncEventRow[]>
  /** Unbound rows the user attends (not owns), ending after `notBefore`. */
  unboundAttendedEvents(accountId: string, userId: string, notBefore: string): Promise<SyncEventRow[]>
  findByExternalId(connectionId: string, externalId: string): Promise<SyncEventRow | null>
  insertEvent(row: SyncEventInsert): Promise<void>
  updateEvent(id: string, patch: SyncEventPatch): Promise<void>
  saveConnection(id: string, patch: ConnectionPatch): Promise<void>
}

const CONNECTION_COLUMNS =
  'id, account_id, user_id, provider, email, external_calendar_id, access_token_enc, refresh_token_enc, token_expires_at, sync_cursor, last_sync_at, last_error, status, mirror_attending, created_at, updated_at'

function fail(op: string, error: { message?: string } | null): never {
  throw new Error(`[calendar sync] ${op}: ${error?.message ?? 'unknown error'}`)
}

export function createSyncStore(admin: SupabaseClient): SyncStore {
  return {
    async accountTimezone(accountId) {
      const { data } = await admin.from('accounts').select('preferences').eq('id', accountId).maybeSingle()
      const prefs = parseAccountPreferences(data?.preferences)
      return safeTimezone(prefs.business_hours.timezone)
    },

    async connectedUserIds(accountId) {
      const { data, error } = await admin
        .from('calendar_connections')
        .select('user_id')
        .eq('account_id', accountId)
        .eq('status', 'active')
      if (error) fail('connectedUserIds', error)
      return new Set((data ?? []).map((r) => r.user_id as string))
    },

    async boundEvents(connectionId, since) {
      let q = admin.from('calendar_events').select(SYNC_EVENT_COLUMNS).eq('external_connection_id', connectionId)
      if (since) q = q.gte('updated_at', since)
      const { data, error } = await q
      if (error) fail('boundEvents', error)
      return (data ?? []) as SyncEventRow[]
    },

    async unboundOwnedEvents(accountId, userId, notBefore) {
      const { data, error } = await admin
        .from('calendar_events')
        .select(SYNC_EVENT_COLUMNS)
        .eq('account_id', accountId)
        .eq('owner_user_id', userId)
        .is('external_connection_id', null)
        .eq('status', 'confirmed')
        .gte('ends_at', notBefore)
      if (error) fail('unboundOwnedEvents', error)
      return (data ?? []) as SyncEventRow[]
    },

    async unboundAttendedEvents(accountId, userId, notBefore) {
      const { data: att, error: attErr } = await admin
        .from('calendar_event_attendees')
        .select('event_id')
        .eq('user_id', userId)
      if (attErr) fail('unboundAttendedEvents', attErr)
      const ids = (att ?? []).map((r) => r.event_id as string)
      if (ids.length === 0) return []
      const { data, error } = await admin
        .from('calendar_events')
        .select(SYNC_EVENT_COLUMNS)
        .eq('account_id', accountId)
        .in('id', ids)
        .is('external_connection_id', null)
        .eq('status', 'confirmed')
        .gte('ends_at', notBefore)
      if (error) fail('unboundAttendedEvents', error)
      return ((data ?? []) as SyncEventRow[]).filter((r) => r.owner_user_id !== userId)
    },

    async findByExternalId(connectionId, externalId) {
      const { data, error } = await admin
        .from('calendar_events')
        .select(SYNC_EVENT_COLUMNS)
        .eq('external_connection_id', connectionId)
        .eq('external_id', externalId)
        .maybeSingle()
      if (error) fail('findByExternalId', error)
      return (data as SyncEventRow | null) ?? null
    },

    async insertEvent(row) {
      const { error } = await admin.from('calendar_events').insert(row)
      if (error) fail('insertEvent', error)
    },

    async updateEvent(id, patch) {
      const { error } = await admin.from('calendar_events').update(patch).eq('id', id)
      if (error) fail('updateEvent', error)
    },

    async saveConnection(id, patch) {
      const { error } = await admin.from('calendar_connections').update(patch).eq('id', id)
      if (error) fail('saveConnection', error)
    },
  }
}

// ------------------------------------------------------------
// Connection reads used by the routes and the cron.
// ------------------------------------------------------------

export async function loadConnection(
  admin: SupabaseClient,
  userId: string,
  provider: CalendarProvider,
): Promise<CalendarConnection | null> {
  const { data, error } = await admin
    .from('calendar_connections')
    .select(CONNECTION_COLUMNS)
    .eq('user_id', userId)
    .eq('provider', provider)
    .maybeSingle()
  if (error) fail('loadConnection', error)
  return (data as CalendarConnection | null) ?? null
}

export async function loadUserConnections(admin: SupabaseClient, userId: string): Promise<CalendarConnection[]> {
  const { data, error } = await admin.from('calendar_connections').select(CONNECTION_COLUMNS).eq('user_id', userId)
  if (error) fail('loadUserConnections', error)
  return (data ?? []) as CalendarConnection[]
}

/** Active connections, stalest first — the cron batch. */
export async function loadDueConnections(admin: SupabaseClient, limit: number): Promise<CalendarConnection[]> {
  const { data, error } = await admin
    .from('calendar_connections')
    .select(CONNECTION_COLUMNS)
    .eq('status', 'active')
    .order('last_sync_at', { ascending: true, nullsFirst: true })
    .limit(limit)
  if (error) fail('loadDueConnections', error)
  return (data ?? []) as CalendarConnection[]
}

/**
 * Upsert the (user, provider) connection after a successful OAuth
 * exchange. A reconnect resets the cursor (full read again), the
 * error state and — since the user consented again — the status.
 */
export async function upsertConnection(
  admin: SupabaseClient,
  row: {
    account_id: string
    user_id: string
    provider: CalendarProvider
    email: string | null
    external_calendar_id: string | null
    access_token_enc: string
    refresh_token_enc: string | null
    token_expires_at: string
  },
): Promise<CalendarConnection> {
  const existing = await loadConnection(admin, row.user_id, row.provider)
  const patch = {
    ...row,
    // Keep the old refresh token when the provider did not issue one
    // (Google only sends it on the first consent unless prompt=consent).
    refresh_token_enc: row.refresh_token_enc ?? existing?.refresh_token_enc ?? null,
    sync_cursor: null,
    last_error: null,
    status: 'active' as const,
  }
  const { data, error } = await admin
    .from('calendar_connections')
    .upsert(patch, { onConflict: 'user_id,provider' })
    .select(CONNECTION_COLUMNS)
    .single()
  if (error) fail('upsertConnection', error)
  return data as CalendarConnection
}

/**
 * Remove a connection and detach its events: rows imported from the
 * provider are deleted; internal rows that were mirrored keep living
 * here with their external columns cleared.
 */
export async function deleteConnectionAndDetach(admin: SupabaseClient, conn: CalendarConnection): Promise<void> {
  const { error: delEvents } = await admin
    .from('calendar_events')
    .delete()
    .eq('external_connection_id', conn.id)
    .eq('source', conn.provider)
  if (delEvents) fail('deleteConnection.events', delEvents)
  const { error: detach } = await admin
    .from('calendar_events')
    .update({ external_connection_id: null, external_id: null, external_etag: null, external_updated_at: null, sync_hash: null })
    .eq('external_connection_id', conn.id)
  if (detach) fail('deleteConnection.detach', detach)
  const { error } = await admin.from('calendar_connections').delete().eq('id', conn.id)
  if (error) fail('deleteConnection', error)
}
