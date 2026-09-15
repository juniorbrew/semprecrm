// ============================================================
// Calendar sync — the engine (spec "Fase 2 — Sincronização").
//
// One `syncConnection` run, per connection:
//
//   1. Token: decrypt; refresh when expired (or about to); persist the
//      new tokens encrypted. `invalid_grant` / 401 → status `revoked`.
//   2. Inbound (incremental): the provider change feed from the stored
//      cursor (full read on the first run or after a 410). Each item
//      is matched by (connection, external_id): new → insert
//      (`source` = provider, owner = the connected user); changed →
//      update unless the local copy is newer AND has unsent changes
//      (newer `updated_at` wins); removed / cancelled → status
//      `cancelled` here.
//   3. Outbound: rows bound to the connection changed since the last
//      run, plus unbound rows the user owns (or attends, when
//      `mirror_attending`) → create / patch / delete on the provider.
//      `sync_hash` (title, description, location, start, end, all-day,
//      status) is compared first so an untouched row is never resent.
//      A cancelled row is deleted on the provider and unbound from it
//      (`external_id` = null) so a later restore creates it again.
//   4. `last_sync_at`, `sync_cursor`, `status`, `last_error`.
//
// Inbound runs before outbound so a provider-side edit lands before
// we decide what to push. Everything is injectable (`SyncDeps`): the
// store, the HTTP layer, the clock and the crypto — the tests run
// with an in-memory store and a scripted fetch.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import type { CalendarConnection, CalendarProvider } from '@/types'

import { providerCredentials, type ProviderCredentials } from './config'
import { googleAdapter } from './google'
import { defaultHttpDeps, ProviderAuthError, type HttpDeps } from './http'
import { syncHash, type InboundEvent, type MirroredFields } from './mapping'
import { microsoftAdapter } from './microsoft'
import { LOOKBACK_DAYS, type ProviderAdapter, type TokenSet } from './provider'
import {
  createSyncStore,
  loadDueConnections,
  loadUserConnections,
  type SyncEventRow,
  type SyncStore,
} from './store'

export const ADAPTERS: Record<CalendarProvider, ProviderAdapter> = {
  google: googleAdapter,
  microsoft: microsoftAdapter,
}

/** Refresh when the access token dies within this window. */
const TOKEN_SKEW_MS = 60_000
/** `last_error` is a UI string; keep it short. */
const MAX_ERROR_LEN = 500
/** Outbound overlap so a write racing the previous run is not missed. */
const OUTBOUND_OVERLAP_MS = 60_000

export interface SyncDeps {
  store: SyncStore
  http?: HttpDeps
  now?: () => Date
  crypto?: { encrypt: (s: string) => string; decrypt: (s: string) => string }
  /** Credentials per provider (default: from process.env). */
  credentials?: (provider: CalendarProvider) => ProviderCredentials | null
  adapters?: Partial<Record<CalendarProvider, ProviderAdapter>>
}

export interface SyncCounts {
  pulled_created: number
  pulled_updated: number
  pulled_cancelled: number
  pushed_created: number
  pushed_updated: number
  pushed_deleted: number
  skipped: number
}

export interface ConnectionSyncResult extends SyncCounts {
  connection_id: string
  provider: CalendarProvider
  status: 'active' | 'error' | 'revoked' | 'skipped'
  error: string | null
  /** False when the inbound read stopped at the page cap (more next run). */
  complete: boolean
}

function emptyCounts(): SyncCounts {
  return {
    pulled_created: 0,
    pulled_updated: 0,
    pulled_cancelled: 0,
    pushed_created: 0,
    pushed_updated: 0,
    pushed_deleted: 0,
    skipped: 0,
  }
}

function resolveDeps(deps: SyncDeps) {
  return {
    store: deps.store,
    http: { ...(deps.http ?? defaultHttpDeps()), now: deps.http?.now ?? deps.now },
    now: deps.now ?? (() => new Date()),
    crypto: deps.crypto ?? { encrypt, decrypt },
    credentials: deps.credentials ?? ((p: CalendarProvider) => providerCredentials(p)),
    adapters: { ...ADAPTERS, ...(deps.adapters ?? {}) } as Record<CalendarProvider, ProviderAdapter>,
  }
}

type Resolved = ReturnType<typeof resolveDeps>

function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.length > MAX_ERROR_LEN ? `${msg.slice(0, MAX_ERROR_LEN - 1)}…` : msg
}

// ------------------------------------------------------------
// Tokens
// ------------------------------------------------------------

function safeDecrypt(d: Resolved['crypto'], value: string | null): string | null {
  if (!value) return null
  try {
    return d.decrypt(value)
  } catch {
    return null
  }
}

/**
 * A usable access token for the connection, refreshing (and
 * persisting) when needed. Throws `ProviderAuthError` when there is
 * nothing to refresh with.
 */
export async function ensureAccessToken(
  conn: CalendarConnection,
  adapter: ProviderAdapter,
  r: Resolved,
): Promise<string> {
  const now = r.now().getTime()
  const access = safeDecrypt(r.crypto, conn.access_token_enc)
  const expiresAt = conn.token_expires_at ? Date.parse(conn.token_expires_at) : 0
  if (access && Number.isFinite(expiresAt) && expiresAt - now > TOKEN_SKEW_MS) return access

  const refresh = safeDecrypt(r.crypto, conn.refresh_token_enc)
  if (!refresh) {
    throw new ProviderAuthError(conn.provider, 401, null, `${conn.provider}: no refresh token — reconnect`)
  }
  const creds = r.credentials(conn.provider)
  if (!creds) throw new Error(`${conn.provider}: integration not configured on this server`)

  const tokens: TokenSet = await adapter.refreshToken(r.http, creds, refresh)
  const patch = {
    access_token_enc: r.crypto.encrypt(tokens.access_token),
    token_expires_at: tokens.expires_at,
    ...(tokens.refresh_token ? { refresh_token_enc: r.crypto.encrypt(tokens.refresh_token) } : {}),
  }
  await r.store.saveConnection(conn.id, patch)
  conn.access_token_enc = patch.access_token_enc
  conn.token_expires_at = patch.token_expires_at
  if (tokens.refresh_token) conn.refresh_token_enc = patch.refresh_token_enc!
  return tokens.access_token
}

// ------------------------------------------------------------
// Inbound
// ------------------------------------------------------------

function fieldsPatch(f: MirroredFields) {
  return {
    title: f.title,
    description: f.description,
    location: f.location,
    starts_at: f.starts_at,
    ends_at: f.ends_at,
    all_day: f.all_day,
    status: f.status,
  }
}

/** True when the local row has edits that were never pushed. */
function hasUnsentChanges(row: SyncEventRow): boolean {
  return row.sync_hash !== syncHash(row)
}

/** Local newer than the provider's stamp (both known) and with unsent edits → local wins. */
function localWins(row: SyncEventRow, item: InboundEvent): boolean {
  if (!hasUnsentChanges(row)) return false
  if (!item.external_updated_at) return true
  return Date.parse(row.updated_at) > Date.parse(item.external_updated_at)
}

async function applyInbound(
  conn: CalendarConnection,
  item: InboundEvent,
  counts: SyncCounts,
  r: Resolved,
): Promise<void> {
  const existing = await r.store.findByExternalId(conn.id, item.external_id)

  if (item.deleted) {
    if (!existing) return
    if (existing.status === 'cancelled') return
    // A local reschedule racing a remote delete: the local copy wins
    // (it will be re-created on the push since we unbind it).
    if (localWins(existing, item)) {
      await r.store.updateEvent(existing.id, {
        external_id: null,
        external_etag: null,
        external_updated_at: null,
        sync_hash: null,
      })
      counts.skipped++
      return
    }
    const cancelled = { ...existing, status: 'cancelled' as const }
    await r.store.updateEvent(existing.id, {
      status: 'cancelled',
      external_etag: item.external_etag,
      external_updated_at: item.external_updated_at,
      sync_hash: syncHash(cancelled),
    })
    counts.pulled_cancelled++
    return
  }

  const fields = item.fields!
  const hash = syncHash(fields)

  if (!existing) {
    await r.store.insertEvent({
      account_id: conn.account_id,
      owner_user_id: conn.user_id,
      created_by: conn.user_id,
      ...fieldsPatch(fields),
      source: conn.provider,
      external_connection_id: conn.id,
      external_id: item.external_id,
      external_etag: item.external_etag,
      external_updated_at: item.external_updated_at,
      sync_hash: hash,
    })
    counts.pulled_created++
    return
  }

  if (existing.sync_hash === hash && syncHash(existing) === hash) {
    // Nothing changed on either side (e.g. the echo of our own push).
    if (existing.external_etag !== item.external_etag) {
      await r.store.updateEvent(existing.id, {
        external_etag: item.external_etag,
        external_updated_at: item.external_updated_at ?? existing.external_updated_at,
      })
    }
    return
  }

  if (localWins(existing, item)) {
    counts.skipped++
    return
  }

  await r.store.updateEvent(existing.id, {
    ...fieldsPatch(fields),
    external_etag: item.external_etag,
    external_updated_at: item.external_updated_at,
    sync_hash: hash,
  })
  counts.pulled_updated++
}

async function runInbound(
  conn: CalendarConnection,
  adapter: ProviderAdapter,
  accessToken: string,
  tz: string,
  counts: SyncCounts,
  r: Resolved,
): Promise<{ cursor: string | null; complete: boolean }> {
  let cursor = conn.sync_cursor
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await adapter.listChanges(r.http, {
      accessToken,
      cursor,
      calendarId: conn.external_calendar_id,
      now: r.now(),
      tz,
    })
    if (res.resetRequired) {
      cursor = null
      continue
    }
    for (const item of res.items) await applyInbound(conn, item, counts, r)
    return { cursor: res.cursor, complete: res.done }
  }
  throw new Error(`${conn.provider}: the change feed reset twice in a row`)
}

// ------------------------------------------------------------
// Outbound
// ------------------------------------------------------------

async function outboundCandidates(conn: CalendarConnection, r: Resolved): Promise<SyncEventRow[]> {
  const now = r.now()
  const since = conn.last_sync_at ? new Date(Date.parse(conn.last_sync_at) - OUTBOUND_OVERLAP_MS).toISOString() : null
  const notBefore = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000).toISOString()

  const bound = await r.store.boundEvents(conn.id, since)
  const owned = await r.store.unboundOwnedEvents(conn.account_id, conn.user_id, notBefore)
  let attended: SyncEventRow[] = []
  if (conn.mirror_attending) {
    // One row mirrors to one calendar: the owner's connection has
    // priority, so an attendee only claims events whose owner has no
    // connection of their own.
    const connected = await r.store.connectedUserIds(conn.account_id)
    attended = (await r.store.unboundAttendedEvents(conn.account_id, conn.user_id, notBefore)).filter(
      (row) => !row.owner_user_id || !connected.has(row.owner_user_id),
    )
  }

  const seen = new Set<string>()
  const out: SyncEventRow[] = []
  for (const row of [...bound, ...owned, ...attended]) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    out.push(row)
  }
  return out
}

async function pushOne(
  conn: CalendarConnection,
  adapter: ProviderAdapter,
  accessToken: string,
  tz: string,
  row: SyncEventRow,
  counts: SyncCounts,
  r: Resolved,
): Promise<void> {
  const hash = syncHash(row)
  if (row.external_id && row.sync_hash === hash) {
    counts.skipped++
    return
  }

  if (row.status === 'cancelled') {
    if (!row.external_id) {
      // Never sent (or already removed there): nothing to do.
      if (row.sync_hash !== hash) await r.store.updateEvent(row.id, { sync_hash: hash })
      return
    }
    await adapter.deleteEvent(r.http, accessToken, conn.external_calendar_id, row.external_id)
    await r.store.updateEvent(row.id, {
      external_connection_id: conn.id,
      external_id: null,
      external_etag: null,
      external_updated_at: null,
      sync_hash: hash,
    })
    counts.pushed_deleted++
    return
  }

  if (row.external_id) {
    const res = await adapter.updateEvent(r.http, accessToken, conn.external_calendar_id, row.external_id, row, tz)
    await r.store.updateEvent(row.id, {
      external_etag: res.external_etag,
      external_updated_at: res.external_updated_at,
      sync_hash: hash,
    })
    counts.pushed_updated++
    return
  }

  const res = await adapter.createEvent(r.http, accessToken, conn.external_calendar_id, row, tz)
  await r.store.updateEvent(row.id, {
    external_connection_id: conn.id,
    external_id: res.external_id,
    external_etag: res.external_etag,
    external_updated_at: res.external_updated_at,
    sync_hash: hash,
  })
  counts.pushed_created++
}

// ------------------------------------------------------------
// One connection
// ------------------------------------------------------------

export async function syncConnection(conn: CalendarConnection, deps: SyncDeps): Promise<ConnectionSyncResult> {
  const r = resolveDeps(deps)
  const counts = emptyCounts()
  const base = { connection_id: conn.id, provider: conn.provider, ...counts }
  if (conn.status === 'revoked') {
    return { ...base, status: 'skipped', error: conn.last_error, complete: true }
  }
  const adapter = r.adapters[conn.provider]

  try {
    const tz = await r.store.accountTimezone(conn.account_id)
    const accessToken = await ensureAccessToken(conn, adapter, r)

    const inbound = await runInbound(conn, adapter, accessToken, tz, counts, r)

    const candidates = await outboundCandidates(conn, r)
    for (const row of candidates) await pushOne(conn, adapter, accessToken, tz, row, counts, r)

    await r.store.saveConnection(conn.id, {
      sync_cursor: inbound.cursor,
      last_sync_at: r.now().toISOString(),
      last_error: null,
      status: 'active',
    })
    return { ...base, ...counts, status: 'active', error: null, complete: inbound.complete }
  } catch (err) {
    const revoked = err instanceof ProviderAuthError
    const message = errorText(err)
    try {
      await r.store.saveConnection(conn.id, {
        status: revoked ? 'revoked' : 'error',
        last_error: message,
        // A failed run keeps its cursor; the next one resumes.
      })
    } catch (saveErr) {
      console.error('[calendar sync] could not record the error:', saveErr)
    }
    console.error(`[calendar sync] ${conn.provider} connection ${conn.id} failed:`, message)
    return { ...base, ...counts, status: revoked ? 'revoked' : 'error', error: message, complete: false }
  }
}

// ------------------------------------------------------------
// Batches (cron / "Sincronizar agora")
// ------------------------------------------------------------

export interface BatchSyncResult {
  connections: number
  synced: number
  errors: number
  revoked: number
  results: ConnectionSyncResult[]
}

function summarise(results: ConnectionSyncResult[]): BatchSyncResult {
  return {
    connections: results.length,
    synced: results.filter((x) => x.status === 'active').length,
    errors: results.filter((x) => x.status === 'error').length,
    revoked: results.filter((x) => x.status === 'revoked').length,
    results,
  }
}

export interface RunSyncOptions {
  admin: SupabaseClient
  http?: HttpDeps
  now?: () => Date
}

export const CRON_BATCH_LIMIT = 20

/** The cron tick: the stalest active connections, `limit` at most. */
export async function syncDueConnections(opts: RunSyncOptions & { limit?: number }): Promise<BatchSyncResult> {
  const conns = await loadDueConnections(opts.admin, opts.limit ?? CRON_BATCH_LIMIT)
  const deps: SyncDeps = { store: createSyncStore(opts.admin), http: opts.http, now: opts.now }
  const results: ConnectionSyncResult[] = []
  for (const conn of conns) results.push(await syncConnection(conn, deps))
  return summarise(results)
}

/**
 * Every connection of one user ("Sincronizar agora"). With
 * `staleAfterMs`, only the ones not synced within that window (the
 * /agenda page uses 2 min).
 */
export async function syncUserConnections(
  opts: RunSyncOptions & { userId: string; staleAfterMs?: number },
): Promise<BatchSyncResult> {
  const now = (opts.now ?? (() => new Date()))()
  const all = await loadUserConnections(opts.admin, opts.userId)
  const conns = all.filter((c) => {
    if (c.status === 'revoked') return false
    if (!opts.staleAfterMs) return true
    if (!c.last_sync_at) return true
    return now.getTime() - Date.parse(c.last_sync_at) >= opts.staleAfterMs
  })
  const deps: SyncDeps = { store: createSyncStore(opts.admin), http: opts.http, now: opts.now }
  const results: ConnectionSyncResult[] = []
  for (const conn of conns) results.push(await syncConnection(conn, deps))
  return summarise(results)
}
