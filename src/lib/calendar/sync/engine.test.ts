import { beforeEach, describe, expect, it } from 'vitest'

import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import type { CalendarConnection } from '@/types'

import { syncConnection, type SyncDeps } from './engine'
import { GOOGLE_TOKEN_URL } from './google'
import type { HttpDeps } from './http'
import { syncHash } from './mapping'
import type { ConnectionPatch, SyncEventInsert, SyncEventPatch, SyncEventRow, SyncStore } from './store'

// ------------------------------------------------------------
// In-memory store
// ------------------------------------------------------------

const NOW = new Date('2026-09-14T12:00:00Z')
const TZ = 'America/Sao_Paulo'
const ACCOUNT = 'acct-1'
const ANA = 'user-ana'
const BOB = 'user-bob'

interface MemStore extends SyncStore {
  events: SyncEventRow[]
  attendees: { event_id: string; user_id: string }[]
  connections: Map<string, ConnectionPatch>
  activeUsers: Set<string>
  seq: number
}

function memStore(): MemStore {
  const s: MemStore = {
    events: [],
    attendees: [],
    connections: new Map(),
    activeUsers: new Set([ANA]),
    seq: 0,
    async accountTimezone() {
      return TZ
    },
    async connectedUserIds() {
      return new Set(s.activeUsers)
    },
    async boundEvents(connectionId, since) {
      return s.events.filter((e) => e.external_connection_id === connectionId && (!since || e.updated_at >= since))
    },
    async unboundOwnedEvents(accountId, userId, notBefore) {
      return s.events.filter(
        (e) =>
          e.account_id === accountId &&
          e.owner_user_id === userId &&
          e.external_connection_id === null &&
          e.status === 'confirmed' &&
          e.ends_at >= notBefore,
      )
    },
    async unboundAttendedEvents(accountId, userId, notBefore) {
      const ids = new Set(s.attendees.filter((a) => a.user_id === userId).map((a) => a.event_id))
      return s.events.filter(
        (e) =>
          ids.has(e.id) &&
          e.account_id === accountId &&
          e.owner_user_id !== userId &&
          e.external_connection_id === null &&
          e.status === 'confirmed' &&
          e.ends_at >= notBefore,
      )
    },
    async findByExternalId(connectionId, externalId) {
      return s.events.find((e) => e.external_connection_id === connectionId && e.external_id === externalId) ?? null
    },
    async insertEvent(row: SyncEventInsert) {
      s.seq += 1
      s.events.push({ ...row, id: `ev-${s.seq}`, updated_at: NOW.toISOString() })
    },
    async updateEvent(id, patch: SyncEventPatch) {
      const row = s.events.find((e) => e.id === id)
      if (!row) throw new Error(`no row ${id}`)
      Object.assign(row, patch, { updated_at: NOW.toISOString() })
    },
    async saveConnection(id, patch) {
      s.connections.set(id, { ...(s.connections.get(id) ?? {}), ...patch })
    },
  }
  return s
}

function event(over: Partial<SyncEventRow> & { id: string }): SyncEventRow {
  const base: SyncEventRow = {
    id: over.id,
    account_id: ACCOUNT,
    owner_user_id: ANA,
    title: 'Reunião',
    description: null,
    location: null,
    starts_at: '2026-09-15T13:00:00.000Z',
    ends_at: '2026-09-15T14:00:00.000Z',
    all_day: false,
    status: 'confirmed',
    source: 'internal',
    external_connection_id: null,
    external_id: null,
    external_etag: null,
    external_updated_at: null,
    sync_hash: null,
    created_by: ANA,
    updated_at: '2026-09-14T11:00:00.000Z',
  }
  return { ...base, ...over }
}

// ------------------------------------------------------------
// Scripted HTTP
// ------------------------------------------------------------

interface Call {
  method: string
  url: string
  body: unknown
  headers: Record<string, string>
}

type Route = (call: Call, n: number) => { status?: number; body?: unknown; headers?: Record<string, string> }

function fakeHttp(): HttpDeps & { calls: Call[]; route: (m: string, urlPart: string, r: Route) => void; sleeps: number[] } {
  const routes: { m: string; part: string; r: Route; hits: number }[] = []
  const calls: Call[] = []
  const sleeps: number[] = []
  return {
    calls,
    sleeps,
    route(m, part, r) {
      routes.push({ m, part, r, hits: 0 })
    },
    async sleep(ms) {
      sleeps.push(ms)
    },
    async fetch(input, init) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? 'GET').toUpperCase()
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v
      let body: unknown = null
      if (typeof init?.body === 'string') {
        body = headers['content-type']?.includes('json')
          ? JSON.parse(init.body)
          : Object.fromEntries(new URLSearchParams(init.body))
      }
      const call = { method, url, body, headers }
      calls.push(call)
      // Last registered wins so a test overrides the default feed.
      const route = [...routes].reverse().find((x) => x.m === method && url.includes(x.part))
      if (!route) return new Response(JSON.stringify({ error: `unrouted ${method} ${url}` }), { status: 599 })
      route.hits += 1
      const out = route.r(call, route.hits)
      const status = out.status ?? 200
      const text = out.body === undefined ? '' : JSON.stringify(out.body)
      return new Response(status === 204 ? null : text, {
        status,
        headers: { 'content-type': 'application/json', ...(out.headers ?? {}) },
      })
    },
  }
}

function connection(over: Partial<CalendarConnection> = {}): CalendarConnection {
  return {
    id: 'conn-g',
    account_id: ACCOUNT,
    user_id: ANA,
    provider: 'google',
    email: 'ana@gmail.com',
    external_calendar_id: 'primary',
    access_token_enc: encrypt('access-ok'),
    refresh_token_enc: encrypt('refresh-ok'),
    token_expires_at: new Date(NOW.getTime() + 3600_000).toISOString(),
    sync_cursor: 'sync-1',
    last_sync_at: '2026-09-14T11:30:00.000Z',
    last_error: null,
    status: 'active',
    mirror_attending: true,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    ...over,
  }
}

let store: MemStore
let http: ReturnType<typeof fakeHttp>
let deps: SyncDeps

const GOOGLE_EVENTS = '/calendars/primary/events'

function gEvent(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    etag: `"etag-${id}"`,
    status: 'confirmed',
    summary: `Ext ${id}`,
    start: { dateTime: '2026-09-16T10:00:00-03:00' },
    end: { dateTime: '2026-09-16T11:00:00-03:00' },
    updated: '2026-09-14T11:45:00.000Z',
    ...over,
  }
}

beforeEach(() => {
  store = memStore()
  http = fakeHttp()
  deps = {
    store,
    http,
    now: () => NOW,
    crypto: { encrypt, decrypt },
    credentials: () => ({ clientId: 'cid', clientSecret: 'sec', tenant: 'common' }),
  }
  // Default: empty incremental feed.
  http.route('GET', GOOGLE_EVENTS, () => ({ body: { items: [], nextSyncToken: 'sync-2' } }))
})

// ------------------------------------------------------------

describe('syncConnection — outbound (Google)', () => {
  it('creates never-sent owned events, stores external id / etag / hash and skips unchanged ones next time', async () => {
    store.events.push(event({ id: 'ev-a', description: 'Pauta', location: 'Sala' }))
    http.route('POST', GOOGLE_EVENTS, (call) => ({
      body: { id: 'g-new', etag: '"e1"', updated: '2026-09-14T12:00:01Z', ...(call.body as object) },
    }))

    const first = await syncConnection(connection(), deps)
    expect(first.status).toBe('active')
    expect(first.pushed_created).toBe(1)
    const post = http.calls.find((c) => c.method === 'POST')!
    expect(post.headers.authorization).toBe('Bearer access-ok')
    expect(post.body).toMatchObject({
      summary: 'Reunião',
      description: 'Pauta',
      location: 'Sala',
      start: { dateTime: '2026-09-15T13:00:00.000Z', timeZone: TZ },
    })
    const row = store.events[0]
    expect(row).toMatchObject({
      external_connection_id: 'conn-g',
      external_id: 'g-new',
      external_etag: '"e1"',
      external_updated_at: '2026-09-14T12:00:01.000Z',
      sync_hash: syncHash(row),
    })
    expect(store.connections.get('conn-g')).toMatchObject({
      sync_cursor: 'sync-2',
      last_sync_at: NOW.toISOString(),
      last_error: null,
      status: 'active',
    })

    // Second run: nothing changed → no write to the provider.
    const before = http.calls.length
    const second = await syncConnection(connection({ sync_cursor: 'sync-2' }), deps)
    expect(second.pushed_created + second.pushed_updated + second.pushed_deleted).toBe(0)
    expect(http.calls.slice(before).filter((c) => c.method !== 'GET')).toHaveLength(0)
  })

  it('patches a bound event whose mirrored fields changed and deletes a cancelled one', async () => {
    const changed = event({
      id: 'ev-b',
      external_connection_id: 'conn-g',
      external_id: 'g-b',
      sync_hash: 'stale',
      updated_at: '2026-09-14T11:50:00.000Z',
    })
    const cancelled = event({
      id: 'ev-c',
      status: 'cancelled',
      external_connection_id: 'conn-g',
      external_id: 'g-c',
      sync_hash: 'stale',
      updated_at: '2026-09-14T11:50:00.000Z',
    })
    // Bound but not changed since the last run (before the overlap window).
    const untouched = event({
      id: 'ev-d',
      external_connection_id: 'conn-g',
      external_id: 'g-d',
      sync_hash: 'stale',
      updated_at: '2026-09-14T10:00:00.000Z',
    })
    store.events.push(changed, cancelled, untouched)
    http.route('PATCH', `${GOOGLE_EVENTS}/g-b`, () => ({ body: { id: 'g-b', etag: '"e2"' } }))
    http.route('DELETE', `${GOOGLE_EVENTS}/g-c`, () => ({ status: 204 }))

    const res = await syncConnection(connection(), deps)
    expect(res).toMatchObject({ status: 'active', pushed_updated: 1, pushed_deleted: 1 })
    expect(store.events.find((e) => e.id === 'ev-b')).toMatchObject({ external_etag: '"e2"', sync_hash: syncHash(changed) })
    expect(store.events.find((e) => e.id === 'ev-c')).toMatchObject({
      external_id: null,
      external_etag: null,
      external_connection_id: 'conn-g',
      sync_hash: syncHash(cancelled),
    })
    expect(http.calls.some((c) => c.url.includes('g-d'))).toBe(false)
  })

  it('a delete that is already gone on the provider (404 / 410) is fine', async () => {
    store.events.push(
      event({ id: 'ev-c', status: 'cancelled', external_connection_id: 'conn-g', external_id: 'g-c', sync_hash: 'stale' }),
    )
    http.route('DELETE', `${GOOGLE_EVENTS}/g-c`, () => ({ status: 410, body: { error: { code: 410 } } }))
    const res = await syncConnection(connection({ last_sync_at: null }), deps)
    expect(res).toMatchObject({ status: 'active', pushed_deleted: 1 })
  })

  it('mirrors attended events only when the owner has no connection of their own', async () => {
    store.events.push(
      event({ id: 'ev-bob', owner_user_id: BOB, created_by: BOB, title: 'Bob sem conexão' }),
      event({ id: 'ev-carl', owner_user_id: 'user-carl', created_by: 'user-carl', title: 'Carl conectado' }),
    )
    store.attendees.push({ event_id: 'ev-bob', user_id: ANA }, { event_id: 'ev-carl', user_id: ANA })
    store.activeUsers.add('user-carl')
    http.route('POST', GOOGLE_EVENTS, (call, n) => ({ body: { id: `g-${n}`, ...(call.body as object) } }))

    const res = await syncConnection(connection(), deps)
    expect(res.pushed_created).toBe(1)
    expect(http.calls.filter((c) => c.method === 'POST').map((c) => (c.body as { summary: string }).summary)).toEqual([
      'Bob sem conexão',
    ])

    // With the toggle off nothing attended is pushed.
    store.events.find((e) => e.id === 'ev-bob')!.external_connection_id = null
    store.events.find((e) => e.id === 'ev-bob')!.external_id = null
    const off = await syncConnection(connection({ mirror_attending: false }), deps)
    expect(off.pushed_created).toBe(0)
  })
})

describe('syncConnection — inbound (Google)', () => {
  it('inserts new provider events as source=google owned by the user, cancels removed ones, updates changed ones', async () => {
    store.events.push(
      event({
        id: 'ev-old',
        source: 'google',
        external_connection_id: 'conn-g',
        external_id: 'g-old',
        title: 'Antigo',
        sync_hash: syncHash(event({ id: 'x', title: 'Antigo' })),
        updated_at: '2026-09-14T09:00:00.000Z',
      }),
      event({
        id: 'ev-gone',
        source: 'google',
        external_connection_id: 'conn-g',
        external_id: 'g-gone',
        sync_hash: syncHash(event({ id: 'x' })),
        updated_at: '2026-09-14T09:00:00.000Z',
      }),
    )
    http.route('GET', GOOGLE_EVENTS, (call) => {
      expect(call.url).toContain('syncToken=sync-1')
      expect(call.url).toContain('showDeleted=true')
      return {
        body: {
          items: [
            gEvent('g-new', { summary: 'Novo', description: 'desc', location: 'aqui' }),
            gEvent('g-old', { summary: 'Renomeado' }),
            { id: 'g-gone', status: 'cancelled' },
            gEvent('g-ooo', { eventType: 'outOfOffice' }),
            { id: 'g-nostart', status: 'confirmed' },
          ],
          nextSyncToken: 'sync-3',
        },
      }
    })

    const res = await syncConnection(connection(), deps)
    expect(res).toMatchObject({ status: 'active', pulled_created: 1, pulled_updated: 1, pulled_cancelled: 1 })
    const created = store.events.find((e) => e.external_id === 'g-new')!
    expect(created).toMatchObject({
      account_id: ACCOUNT,
      owner_user_id: ANA,
      created_by: ANA,
      source: 'google',
      external_connection_id: 'conn-g',
      external_etag: '"etag-g-new"',
      title: 'Novo',
      description: 'desc',
      location: 'aqui',
      starts_at: '2026-09-16T13:00:00.000Z',
      ends_at: '2026-09-16T14:00:00.000Z',
      all_day: false,
      status: 'confirmed',
    })
    expect(created.sync_hash).toBe(syncHash(created))
    expect(store.events.find((e) => e.id === 'ev-old')).toMatchObject({ title: 'Renomeado', external_etag: '"etag-g-old"' })
    expect(store.events.find((e) => e.id === 'ev-gone')).toMatchObject({ status: 'cancelled' })
    expect(store.events.some((e) => e.external_id === 'g-ooo')).toBe(false)
    expect(store.connections.get('conn-g')?.sync_cursor).toBe('sync-3')
    // Nothing was pushed back: the imported rows carry the hash of what we stored.
    expect(http.calls.filter((c) => c.method !== 'GET')).toHaveLength(0)
  })

  it('conflict: the newer side wins (local unsent edit newer than the provider stamp is kept and pushed)', async () => {
    const local = event({
      id: 'ev-x',
      external_connection_id: 'conn-g',
      external_id: 'g-x',
      title: 'Editado aqui',
      sync_hash: 'old-hash',
      updated_at: '2026-09-14T11:55:00.000Z',
    })
    const stale = event({
      id: 'ev-y',
      external_connection_id: 'conn-g',
      external_id: 'g-y',
      title: 'Editado aqui antes',
      sync_hash: 'old-hash',
      updated_at: '2026-09-14T11:40:00.000Z',
    })
    store.events.push(local, stale)
    http.route('GET', GOOGLE_EVENTS, () => ({
      body: {
        items: [
          gEvent('g-x', { summary: 'Editado lá', updated: '2026-09-14T11:50:00.000Z' }),
          gEvent('g-y', { summary: 'Editado lá depois', updated: '2026-09-14T11:50:00.000Z' }),
        ],
        nextSyncToken: 'sync-3',
      },
    }))
    http.route('PATCH', `${GOOGLE_EVENTS}/g-x`, () => ({ body: { id: 'g-x', etag: '"pushed"' } }))

    const res = await syncConnection(connection(), deps)
    expect(res).toMatchObject({ status: 'active', pulled_updated: 1, pushed_updated: 1 })
    expect(store.events.find((e) => e.id === 'ev-x')).toMatchObject({ title: 'Editado aqui', external_etag: '"pushed"' })
    expect(store.events.find((e) => e.id === 'ev-y')).toMatchObject({ title: 'Editado lá depois' })
    expect(http.calls.filter((c) => c.method === 'PATCH').map((c) => c.url)).toEqual([expect.stringContaining('g-x')])
  })

  it('410 on the sync token → full read (timeMin, no syncToken) and a fresh token', async () => {
    http.route('GET', GOOGLE_EVENTS, (call, n) => {
      if (n === 1) {
        expect(call.url).toContain('syncToken=sync-1')
        return { status: 410, body: { error: { code: 410, message: 'Sync token is no longer valid' } } }
      }
      expect(call.url).not.toContain('syncToken')
      expect(call.url).toContain('timeMin=')
      expect(call.url).toContain('singleEvents=true')
      return { body: { items: [gEvent('g-full')], nextSyncToken: 'sync-fresh' } }
    })
    const res = await syncConnection(connection(), deps)
    expect(res).toMatchObject({ status: 'active', pulled_created: 1, complete: true })
    expect(store.connections.get('conn-g')?.sync_cursor).toBe('sync-fresh')
  })

  it('follows nextPageToken and only persists the sync token at the end', async () => {
    http.route('GET', GOOGLE_EVENTS, (call, n) => {
      if (n === 1) return { body: { items: [gEvent('p1')], nextPageToken: 'page-2' } }
      expect(call.url).toContain('pageToken=page-2')
      return { body: { items: [gEvent('p2')], nextSyncToken: 'sync-end' } }
    })
    const res = await syncConnection(connection({ sync_cursor: null }), deps)
    expect(res.pulled_created).toBe(2)
    expect(store.connections.get('conn-g')?.sync_cursor).toBe('sync-end')
  })
})

describe('syncConnection — tokens and failures', () => {
  it('refreshes an expired access token (Google) and stores it encrypted', async () => {
    http.route('POST', GOOGLE_TOKEN_URL, (call) => {
      expect(call.body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'refresh-ok', client_id: 'cid' })
      return { body: { access_token: 'access-new', expires_in: 3599 } }
    })
    const conn = connection({ token_expires_at: new Date(NOW.getTime() - 1000).toISOString() })
    const res = await syncConnection(conn, deps)
    expect(res.status).toBe('active')
    const saved = store.connections.get('conn-g')!
    expect(decrypt(saved.access_token_enc!)).toBe('access-new')
    expect(saved.token_expires_at).toBe(new Date(NOW.getTime() + 3599_000).toISOString())
    expect(saved.refresh_token_enc).toBeUndefined() // not rotated → untouched
    const list = http.calls.find((c) => c.method === 'GET')!
    expect(list.headers.authorization).toBe('Bearer access-new')
  })

  it('invalid_grant on refresh → status revoked with the reason', async () => {
    http.route('POST', GOOGLE_TOKEN_URL, () => ({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
    }))
    const res = await syncConnection(connection({ token_expires_at: null }), deps)
    expect(res.status).toBe('revoked')
    expect(store.connections.get('conn-g')).toMatchObject({ status: 'revoked' })
    expect(store.connections.get('conn-g')?.last_error).toContain('invalid_grant')
    expect(http.calls.some((c) => c.method === 'GET')).toBe(false)
  })

  it('401 from the API → revoked; other errors → status error and the cursor is kept', async () => {
    http.route('GET', GOOGLE_EVENTS, () => ({ status: 401, body: { error: { code: 401, message: 'Invalid Credentials' } } }))
    expect((await syncConnection(connection(), deps)).status).toBe('revoked')

    store = memStore()
    http = fakeHttp()
    deps = { ...deps, store, http }
    http.route('GET', GOOGLE_EVENTS, () => ({ status: 500, body: { error: { code: 500, message: 'Backend Error' } } }))
    const res = await syncConnection(connection(), deps)
    expect(res.status).toBe('error')
    expect(res.error).toContain('500')
    expect(store.connections.get('conn-g')).toMatchObject({ status: 'error' })
    expect(store.connections.get('conn-g')?.sync_cursor).toBeUndefined()
  })

  it('429 → waits Retry-After (capped) and retries once', async () => {
    http.route('GET', GOOGLE_EVENTS, (_c, n) =>
      n === 1
        ? { status: 429, body: { error: { code: 429 } }, headers: { 'retry-after': '2' } }
        : { body: { items: [], nextSyncToken: 'sync-2' } },
    )
    const res = await syncConnection(connection(), deps)
    expect(res.status).toBe('active')
    expect(http.sleeps).toEqual([2000])
    expect(http.calls.filter((c) => c.method === 'GET')).toHaveLength(2)
  })

  it('a revoked connection is skipped without touching the network', async () => {
    const res = await syncConnection(connection({ status: 'revoked', last_error: 'x' }), deps)
    expect(res).toMatchObject({ status: 'skipped', error: 'x' })
    expect(http.calls).toHaveLength(0)
  })
})
