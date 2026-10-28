import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ------------------------------------------------------------
// Connecting Instagram / Messenger: state signing, the callback (happy paths and
// every error), the Page picker, disconnect and the Instagram token renewal.
// Meta is a stubbed fetch; the database is a tiny in-memory fake. Nothing real is called.
// ------------------------------------------------------------

type Row = Record<string, unknown>
const h = vi.hoisted(() => ({
  user: 'user-1',
  account: 'acct-1',
  roleError: null as Error | null,
  moduleError: null as Error | null,
  tables: { meta_messaging_channels: [] as Row[], meta_connect_sessions: [] as Row[] } as Record<string, Row[]>,
  seq: 0,
}))

vi.mock('@/lib/auth/account', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/account')>()),
  requireRole: async () => {
    if (h.roleError) throw h.roleError
    return { userId: h.user, accountId: h.account, role: 'admin', supabase: {}, account: {} }
  },
  requireWritable: async (ctx: unknown) => ctx,
  requireModule: async () => {
    if (h.moduleError) throw h.moduleError
  },
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ encrypt: (v: string) => `enc:${v}`, decrypt: (v: string) => v.replace(/^enc:/, '') }))
vi.mock('@/lib/rate-limit', async (orig) => ({
  ...(await orig<typeof import('@/lib/rate-limit')>()),
  checkRateLimit: () => ({ success: true }),
}))
vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      const rows = () => (h.tables[table] ??= [])
      const filters: ((r: Row) => boolean)[] = []
      let op: 'select' | 'insert' | 'upsert' | 'delete' = 'select'
      let payload: Row = {}
      let conflict = ''
      const matching = () => rows().filter((r) => filters.every((f) => f(r)))
      const run = () => {
        if (op === 'insert') {
          const row = { id: `00000000-0000-4000-8000-${String(++h.seq).padStart(12, '0')}`, expires_at: new Date(Date.now() + 900_000).toISOString(), ...payload }
          rows().push(row)
          return { data: row, error: null }
        }
        if (op === 'upsert') {
          const keys = conflict.split(',')
          const hit = rows().find((r) => keys.every((k) => r[k] === payload[k]))
          const clash = rows().find((r) => r.kind === payload.kind && r.external_id === payload.external_id && r !== hit)
          if (clash) return { data: null, error: { code: '23505' } }
          if (hit) Object.assign(hit, payload)
          else rows().push({ id: `ch-${++h.seq}`, ...payload })
          return { data: null, error: null }
        }
        if (op === 'delete') {
          const gone = matching()
          h.tables[table] = rows().filter((r) => !gone.includes(r))
          return { data: null, error: null }
        }
        return { data: matching(), error: null }
      }
      const b: Record<string, unknown> = {
        select: () => b,
        insert: (p: Row) => ((op = 'insert'), (payload = p), b),
        upsert: (p: Row, o: { onConflict: string }) => ((op = 'upsert'), (payload = p), (conflict = o.onConflict), b),
        delete: () => ((op = 'delete'), b),
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
        lt: (c: string, v: string) => (filters.push((r) => String(r[c]) < v), b),
        single: async () => run(),
        maybeSingle: async () => ({ data: (run().data as Row[])[0] ?? null, error: null }),
        then: (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) => Promise.resolve(run()).then(f, r),
      }
      return b
    },
  }),
}))

import { ForbiddenError, ModuleNotIncludedError, UnauthorizedError } from '@/lib/auth/account'
import { handleCallback, handleConnect, handleDisconnect, handleListPages, handlePickPage } from './handlers'
import { dueForRefresh, refreshInstagramTokens } from './refresh'
import { signConnectState, verifyConnectState } from './state'

const KEY = 'a'.repeat(64)
const BASE = 'https://www.semprecrm.com.br'
const fetchMock = vi.fn()

beforeEach(() => {
  process.env.ENCRYPTION_KEY = KEY
  process.env.NEXT_PUBLIC_SITE_URL = BASE
  process.env.INSTAGRAM_APP_ID = 'ig-app'
  process.env.INSTAGRAM_APP_SECRET = 'ig-secret'
  process.env.META_APP_ID = 'fb-app'
  process.env.META_APP_SECRET = 'fb-secret'
  h.user = 'user-1'
  h.account = 'acct-1'
  h.roleError = null
  h.moduleError = null
  h.tables = { meta_messaging_channels: [], meta_connect_sessions: [] }
  h.seq = 0
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => vi.unstubAllGlobals())

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

/** Route Meta calls by URL, in the order the code makes them. */
function meta(routes: Record<string, () => Response>) {
  fetchMock.mockImplementation(async (url: string) => {
    for (const [needle, make] of Object.entries(routes)) if (String(url).includes(needle)) return make()
    throw new Error(`unexpected Meta call: ${String(url).split('?')[0]}`)
  })
}
const calls = (needle: string) => fetchMock.mock.calls.filter(([u]) => String(u).includes(needle))

function callback(kind: 'instagram' | 'messenger', opts: { state?: string | null; cookie?: string | null; query?: string } = {}) {
  const state = opts.state === undefined ? signConnectState({ userId: h.user, accountId: h.account, kind }) : opts.state
  const nonce = verifyConnectState(state, { kind })?.nonce
  const cookie = opts.cookie === undefined ? nonce : opts.cookie
  const url = `${BASE}/api/meta/messaging/callback/${kind}?code=CODE${state ? `&state=${encodeURIComponent(state)}` : ''}${opts.query ?? ''}`
  return handleCallback(
    new Request(url, { headers: cookie ? { cookie: `metamsg_${kind}_nonce=${cookie}` } : {} }),
    kind,
  )
}
const where = (res: Response) => new URL(res.headers.get('location') ?? 'http://none')
const channels = () => h.tables.meta_messaging_channels

const igRoutes = (over: Record<string, () => Response> = {}) => ({
  'api.instagram.com/oauth/access_token': () => json({ data: [{ access_token: 'SHORT', user_id: '111', permissions: 'x' }] }),
  'graph.instagram.com/access_token': () => json({ access_token: 'LONG', token_type: 'bearer', expires_in: 5183944 }),
  '/me?fields=': () => json({ user_id: '999', id: '555', username: 'salao', name: 'Salão da Ana', profile_picture_url: 'https://p/x.jpg' }),
  '/subscribed_apps': () => json({ success: true }),
  ...over,
})

describe('connect state', () => {
  const sign = () => signConnectState({ userId: 'u', accountId: 'a', kind: 'instagram', now: 1_000_000 })
  it('verifies a fresh state of the right kind and carries user / account / nonce', () => {
    const s = verifyConnectState(sign(), { kind: 'instagram', now: 1_000_500 })
    expect(s).toMatchObject({ userId: 'u', accountId: 'a', kind: 'instagram' })
    expect(s?.nonce).toMatch(/^[0-9a-f]{32}$/)
  })
  it('refuses another kind, a tampered payload or signature, expiry, a future stamp and junk', () => {
    const s = sign()
    expect(verifyConnectState(s, { kind: 'messenger', now: 1_000_500 })).toBeNull()
    const [payload, sig] = s.split('.')
    const forged = Buffer.from(JSON.stringify({ u: 'evil', a: 'a', k: 'instagram', n: 'x', t: 1_000_000 })).toString('base64url')
    expect(verifyConnectState(`${forged}.${sig}`, { kind: 'instagram', now: 1_000_500 })).toBeNull()
    expect(verifyConnectState(`${payload}.${'0'.repeat(64)}`, { kind: 'instagram', now: 1_000_500 })).toBeNull()
    expect(verifyConnectState(s, { kind: 'instagram', now: 1_000_000 + 10 * 60_000 + 1 })).toBeNull()
    expect(verifyConnectState(s, { kind: 'instagram', now: 1_000_000 - 120_000 })).toBeNull()
    expect(verifyConnectState(s, { kind: 'instagram', now: 1_000_500, secret: 'b'.repeat(64) })).toBeNull()
    for (const junk of [null, undefined, '', 'abc', 'a.b', 'x'.repeat(3000)]) expect(verifyConnectState(junk, { kind: 'instagram' })).toBeNull()
  })
  it('every state is unique (nonce)', () => {
    expect(signConnectState({ userId: 'u', accountId: 'a', kind: 'instagram' })).not.toBe(signConnectState({ userId: 'u', accountId: 'a', kind: 'instagram' }))
  })
})

describe('start (connect)', () => {
  const start = (kind: 'instagram' | 'messenger') => handleConnect(new Request(`${BASE}/api/meta/messaging/connect/${kind}`), kind)

  it('redirects Instagram to the Instagram authorize URL with the scopes, our callback and a state, and sets the nonce cookie', async () => {
    const res = await start('instagram')
    const u = where(res)
    expect(u.origin + u.pathname).toBe('https://www.instagram.com/oauth/authorize')
    expect(u.searchParams.get('client_id')).toBe('ig-app')
    expect(u.searchParams.get('scope')).toBe('instagram_business_basic,instagram_business_manage_messages')
    expect(u.searchParams.get('redirect_uri')).toBe(`${BASE}/api/meta/messaging/callback/instagram`)
    expect(u.searchParams.get('response_type')).toBe('code')
    const state = verifyConnectState(u.searchParams.get('state'), { kind: 'instagram' })
    expect(state).toMatchObject({ userId: 'user-1', accountId: 'acct-1' })
    expect(res.headers.get('set-cookie')).toContain(`metamsg_instagram_nonce=${state?.nonce}`)
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly/i)
  })

  it('redirects Messenger to the Facebook dialog with the Pages scopes', async () => {
    const u = where(await start('messenger'))
    expect(u.hostname).toBe('www.facebook.com')
    expect(u.pathname).toMatch(/^\/v\d+\.\d+\/dialog\/oauth$/)
    expect(u.searchParams.get('client_id')).toBe('fb-app')
    expect(u.searchParams.get('scope')).toBe('pages_show_list,pages_messaging,pages_manage_metadata')
  })

  it('missing app keys, module off and non-admin never reach Meta', async () => {
    delete process.env.INSTAGRAM_APP_SECRET
    expect(where(await start('instagram')).searchParams.get('meta_error')).toBe('not_configured')
    h.moduleError = new ModuleNotIncludedError('channel_instagram')
    expect(where(await start('instagram')).searchParams.get('meta_error')).toBe('module')
    h.moduleError = null
    h.roleError = new ForbiddenError('no')
    expect(where(await start('instagram')).searchParams.get('meta_error')).toBe('forbidden')
    h.roleError = new UnauthorizedError()
    expect(where(await start('instagram')).searchParams.get('meta_error')).toBe('unauthorized')
  })
})

describe('callback — Instagram', () => {
  it('happy path: exchanges server side, stores the webhook id (user_id), the encrypted long-lived token and its expiry, subscribes, clears the cookie', async () => {
    meta(igRoutes())
    const res = await callback('instagram')
    expect(where(res).searchParams.get('meta')).toBe('connected')
    expect(where(res).pathname).toBe('/settings')
    expect(channels()).toHaveLength(1)
    expect(channels()[0]).toMatchObject({
      account_id: 'acct-1', kind: 'instagram', external_id: '999', name: 'Salão da Ana',
      picture_url: 'https://p/x.jpg', access_token: 'enc:LONG', status: 'active',
    })
    const expires = Date.parse(channels()[0].token_expires_at as string) - Date.now()
    expect(expires).toBeGreaterThan(59 * 86_400_000)
    expect(expires).toBeLessThanOrEqual(60 * 86_400_000)
    // code exchange: POST with the secret in the body, never in a URL we could log
    const exchange = calls('api.instagram.com')[0]
    expect(String((exchange[1] as RequestInit).body)).toContain('client_secret=ig-secret')
    expect(String((exchange[1] as RequestInit).body)).toContain('code=CODE')
    // webhook subscription: account id in the path, token in the header, only `messages`
    const sub = calls('/subscribed_apps')[0]
    expect(String(sub[0])).toMatch(/graph\.instagram\.com\/v[\d.]+\/999\/subscribed_apps\?subscribed_fields=messages$/)
    expect((sub[1] as RequestInit).method).toBe('POST')
    expect(((sub[1] as RequestInit).headers as Record<string, string>).Authorization).toBe('Bearer LONG')
    expect(res.headers.get('set-cookie')).toMatch(/metamsg_instagram_nonce=;/)
  })

  it('also accepts the flat token response and falls back to the exchange user_id when /me has none', async () => {
    meta(igRoutes({
      'api.instagram.com/oauth/access_token': () => json({ access_token: 'SHORT', user_id: 777 }),
      '/me?fields=': () => json({ username: 'x' }),
    }))
    await callback('instagram')
    expect(channels()[0]).toMatchObject({ external_id: '777', name: '@x' })
  })

  it('reconnecting replaces the account\'s Instagram connection instead of adding another', async () => {
    meta(igRoutes())
    await callback('instagram')
    await callback('instagram')
    expect(channels()).toHaveLength(1)
  })

  it('bad state, wrong user, wrong account, missing / wrong nonce cookie: refused before any Meta call', async () => {
    const cases = [
      callback('instagram', { state: 'garbage' }),
      callback('instagram', { state: null }),
      callback('instagram', { state: signConnectState({ userId: 'someone-else', accountId: 'acct-1', kind: 'instagram' }) }),
      callback('instagram', { state: signConnectState({ userId: 'user-1', accountId: 'acct-other', kind: 'instagram' }) }),
      callback('instagram', { state: signConnectState({ userId: 'user-1', accountId: 'acct-1', kind: 'messenger' }) }),
      callback('instagram', { cookie: null }),
      callback('instagram', { cookie: 'forged' }),
    ]
    for (const c of cases) expect(where(await c).searchParams.get('meta_error')).toBe('state')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(channels()).toHaveLength(0)
  })

  it('an expired state is refused', async () => {
    const old = signConnectState({ userId: 'user-1', accountId: 'acct-1', kind: 'instagram', now: Date.now() - 11 * 60_000 })
    expect(where(await callback('instagram', { state: old })).searchParams.get('meta_error')).toBe('state')
  })

  it('the person said no at Meta (access_denied) or Meta reported another error', async () => {
    expect(where(await callback('instagram', { query: '&error=access_denied' })).searchParams.get('meta_error')).toBe('denied')
    expect(where(await callback('instagram', { query: '&error=server_error' })).searchParams.get('meta_error')).toBe('provider')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a Meta error on the code exchange becomes "exchange" and stores nothing', async () => {
    meta(igRoutes({ 'api.instagram.com/oauth/access_token': () => json({ error_type: 'OAuthException', code: 400, error_message: 'Matching code was not found or was already used' }, 400) }))
    expect(where(await callback('instagram')).searchParams.get('meta_error')).toBe('exchange')
    expect(channels()).toHaveLength(0)
  })

  it('an id owned by ANOTHER account is refused, not stolen, and the webhook is not even subscribed', async () => {
    h.tables.meta_messaging_channels.push({ id: 'ch-x', account_id: 'acct-OTHER', kind: 'instagram', external_id: '999', access_token: 'enc:THEIRS' })
    meta(igRoutes())
    expect(where(await callback('instagram')).searchParams.get('meta_error')).toBe('owned')
    expect(channels()).toHaveLength(1)
    expect(channels()[0]).toMatchObject({ account_id: 'acct-OTHER', access_token: 'enc:THEIRS' })
    expect(calls('/subscribed_apps')).toHaveLength(0)
  })

  it('a failing webhook subscription leaves nothing stored', async () => {
    meta(igRoutes({ '/subscribed_apps': () => json({ error: { code: 200, message: 'x' } }, 400) }))
    expect(where(await callback('instagram')).searchParams.get('meta_error')).toBe('subscribe')
    expect(channels()).toHaveLength(0)
  })

  it('module off, missing keys and non-admin are refused without a Meta call', async () => {
    h.moduleError = new ModuleNotIncludedError('channel_instagram')
    expect(where(await callback('instagram')).searchParams.get('meta_error')).toBe('module')
    h.moduleError = null
    delete process.env.INSTAGRAM_APP_ID
    expect(where(await callback('instagram')).searchParams.get('meta_error')).toBe('not_configured')
    process.env.INSTAGRAM_APP_ID = 'ig-app'
    h.roleError = new ForbiddenError('no')
    expect(where(await callback('instagram')).searchParams.get('meta_error')).toBe('forbidden')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never puts a token or secret in the redirect', async () => {
    meta(igRoutes())
    const res = await callback('instagram')
    const target = res.headers.get('location') ?? ''
    expect(target).not.toMatch(/LONG|SHORT|ig-secret/)
  })
})

const page = (id: string, name: string) => ({ id, name, access_token: `PT-${id}`, picture: { data: { url: `https://p/${id}.jpg` } } })
const fbRoutes = (pages: unknown[], over: Record<string, () => Response> = {}) => ({
  '/oauth/access_token?grant_type=fb_exchange_token': () => json({ access_token: 'LONGUSER', token_type: 'bearer', expires_in: 5000000 }),
  '/oauth/access_token': () => json({ access_token: 'SHORTUSER', token_type: 'bearer' }),
  '/me/accounts': () => json({ data: pages }),
  '/subscribed_apps': () => json({ success: true }),
  ...over,
})

describe('callback — Messenger', () => {
  it('one Page: stores the PAGE token (no expiry) and subscribes messages + message_echoes', async () => {
    meta(fbRoutes([page('P1', 'Clínica Sol')]))
    const res = await callback('messenger')
    expect(where(res).searchParams.get('meta')).toBe('connected')
    expect(channels()[0]).toMatchObject({ kind: 'messenger', external_id: 'P1', name: 'Clínica Sol', access_token: 'enc:PT-P1', token_expires_at: null, status: 'active' })
    const sub = calls('/subscribed_apps')[0]
    expect(String(sub[0])).toContain('/P1/subscribed_apps?subscribed_fields=messages%2Cmessage_echoes')
    expect(((sub[1] as RequestInit).headers as Record<string, string>).Authorization).toBe('Bearer PT-P1')
    // the user token only ever read the Pages list
    expect(JSON.stringify(h.tables)).not.toContain('LONGUSER')
  })

  it('several Pages: parks them encrypted for 15 min and lets the admin choose; tokens never leave the server', async () => {
    meta(fbRoutes([page('P1', 'A'), page('P2', 'B')]))
    const res = await callback('messenger')
    const u = where(res)
    expect(u.searchParams.get('meta')).toBe('pick')
    const sessionId = u.searchParams.get('session') as string
    expect(channels()).toHaveLength(0)
    expect(h.tables.meta_connect_sessions).toHaveLength(1)
    expect(h.tables.meta_connect_sessions[0].pages).toMatch(/^enc:/)

    const list = await handleListPages(new Request(`${BASE}/api/meta/messaging/pages?session=${sessionId}`))
    const body = await list.json()
    expect(body.pages.map((p: { id: string }) => p.id)).toEqual(['P1', 'P2'])
    expect(JSON.stringify(body)).not.toContain('PT-')

    const pick = await handlePickPage(new Request(`${BASE}/api/meta/messaging/pages`, { method: 'POST', body: JSON.stringify({ session: sessionId, page_id: 'P2' }) }))
    expect(pick.status).toBe(200)
    expect(channels()[0]).toMatchObject({ external_id: 'P2', access_token: 'enc:PT-P2' })
    // single use: the session is gone, a replay is refused
    expect(h.tables.meta_connect_sessions).toHaveLength(0)
    const replay = await handlePickPage(new Request(`${BASE}/api/meta/messaging/pages`, { method: 'POST', body: JSON.stringify({ session: sessionId, page_id: 'P1' }) }))
    expect(replay.status).toBe(410)
  })

  it('a session of another user / account / expired / unknown page is refused', async () => {
    meta(fbRoutes([page('P1', 'A'), page('P2', 'B')]))
    const sessionId = where(await callback('messenger')).searchParams.get('session') as string
    const post = (body: unknown) => handlePickPage(new Request(`${BASE}/api/meta/messaging/pages`, { method: 'POST', body: JSON.stringify(body) }))
    expect((await post({ session: sessionId, page_id: 'NOPE' })).status).toBe(400)
    h.user = 'user-2'
    expect((await post({ session: sessionId, page_id: 'P1' })).status).toBe(410)
    h.user = 'user-1'
    h.account = 'acct-2'
    expect((await post({ session: sessionId, page_id: 'P1' })).status).toBe(410)
    h.account = 'acct-1'
    h.tables.meta_connect_sessions[0].expires_at = new Date(Date.now() - 1000).toISOString()
    expect((await post({ session: sessionId, page_id: 'P1' })).status).toBe(410)
    expect(channels()).toHaveLength(0)
  })

  it('a Page owned by another account is refused on the picker too (409), nothing subscribed', async () => {
    h.tables.meta_messaging_channels.push({ id: 'ch-x', account_id: 'acct-OTHER', kind: 'messenger', external_id: 'P2', access_token: 'enc:T' })
    meta(fbRoutes([page('P1', 'A'), page('P2', 'B')]))
    const sessionId = where(await callback('messenger')).searchParams.get('session') as string
    const res = await handlePickPage(new Request(`${BASE}/api/meta/messaging/pages`, { method: 'POST', body: JSON.stringify({ session: sessionId, page_id: 'P2' }) }))
    expect(res.status).toBe(409)
    expect(calls('/subscribed_apps')).toHaveLength(0)
  })

  it('no Pages at all, and a Meta error, give clear codes', async () => {
    meta(fbRoutes([]))
    expect(where(await callback('messenger')).searchParams.get('meta_error')).toBe('no_pages')
    meta(fbRoutes([], { '/oauth/access_token': () => json({ error: { message: 'x', code: 100 } }, 400) }))
    expect(where(await callback('messenger')).searchParams.get('meta_error')).toBe('exchange')
  })
})

describe('disconnect', () => {
  const post = (body: unknown) => handleDisconnect(new Request(`${BASE}/api/meta/messaging/disconnect`, { method: 'POST', body: JSON.stringify(body) }))

  it('unsubscribes at Meta, deletes the row of THIS account and leaves the other kind alone', async () => {
    channels().push(
      { id: 'c1', account_id: 'acct-1', kind: 'instagram', external_id: '999', access_token: 'enc:LONG' },
      { id: 'c2', account_id: 'acct-1', kind: 'messenger', external_id: 'P1', access_token: 'enc:PT' },
      { id: 'c3', account_id: 'acct-2', kind: 'instagram', external_id: '123', access_token: 'enc:X' },
    )
    meta({ '/subscribed_apps': () => json({ success: true }) })
    const res = await post({ kind: 'instagram' })
    expect(res.status).toBe(200)
    expect((calls('/subscribed_apps')[0][1] as RequestInit).method).toBe('DELETE')
    expect(channels().map((c) => c.id)).toEqual(['c2', 'c3'])
  })

  it('still disconnects when Meta refuses the unsubscribe', async () => {
    channels().push({ id: 'c1', account_id: 'acct-1', kind: 'messenger', external_id: 'P1', access_token: 'enc:PT' })
    meta({ '/subscribed_apps': () => json({ error: { code: 190, message: 'x' } }, 400) })
    expect((await post({ kind: 'messenger' })).status).toBe(200)
    expect(channels()).toHaveLength(0)
  })

  it('404 when not connected, 400 for a bad kind, role is enforced', async () => {
    expect((await post({ kind: 'instagram' })).status).toBe(404)
    expect((await post({ kind: 'whatsapp' })).status).toBe(400)
    channels().push({ id: 'c1', account_id: 'acct-1', kind: 'instagram', external_id: '999', access_token: 'enc:L' })
    h.roleError = new ForbiddenError('no')
    expect((await post({ kind: 'instagram' })).status).toBe(403)
    expect(channels()).toHaveLength(1)
  })

  it('still disconnects after the plan lost the channel module', async () => {
    channels().push({ id: 'c1', account_id: 'acct-1', kind: 'instagram', external_id: '999', access_token: 'enc:L' })
    meta({ '/subscribed_apps': () => json({ success: true }) })
    h.moduleError = new ModuleNotIncludedError('channel_instagram')
    expect((await post({ kind: 'instagram' })).status).toBe(200)
    expect(channels()).toHaveLength(0)
  })
})

describe('Instagram token renewal', () => {
  const now = new Date('2026-10-28T12:00:00Z')
  const inDays = (d: number) => new Date(now.getTime() + d * 86_400_000).toISOString()

  it('selects tokens at least a week old (expiring within 53 days); flags the already expired; skips the rest', () => {
    const due = dueForRefresh(
      [
        { id: 'fresh', status: 'active', token_expires_at: inDays(59) },
        { id: 'week-old', status: 'active', token_expires_at: inDays(52) },
        { id: 'soon', status: 'active', token_expires_at: inDays(9) },
        { id: 'past', status: 'active', token_expires_at: inDays(-1) },
        { id: 'already', status: 'expired', token_expires_at: inDays(-5) },
        { id: 'no-expiry', status: 'active', token_expires_at: null },
      ],
      now,
    )
    expect(due.refresh).toEqual(['week-old', 'soon'])
    expect(due.expired).toEqual(['past'])
  })

  const seed = () =>
    channels().push(
      { id: 'a', kind: 'instagram', status: 'active', token_expires_at: inDays(5), access_token: 'enc:OLD-A' },
      { id: 'b', kind: 'instagram', status: 'active', token_expires_at: inDays(5), access_token: 'enc:OLD-B' },
      { id: 'c', kind: 'instagram', status: 'active', token_expires_at: inDays(-2), access_token: 'enc:OLD-C' },
    )

  // the cron fake needs gt/lte/not/order/limit on top of the shared one
  function cronDb() {
    return {
      from: () => {
        const filters: ((r: Row) => boolean)[] = []
        let update: Row | null = null
        const b: Record<string, unknown> = {
          select: () => b,
          update: (p: Row) => ((update = p), b),
          eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
          not: (c: string) => (filters.push((r) => r[c] != null), b),
          lte: (c: string, v: string) => (filters.push((r) => String(r[c]) <= v), b),
          order: () => b,
          limit: () => b,
          then: (f: (v: unknown) => unknown) => {
            const hit = channels().filter((r) => r.kind === 'instagram' && filters.every((fn) => fn(r)))
            if (update) hit.forEach((r) => Object.assign(r, update))
            return Promise.resolve({ data: update ? null : hit, error: null }).then(f)
          },
        }
        return b
      },
    } as never
  }

  it('refreshes due tokens (encrypted, new expiry), marks a refused one expired, leaves a network failure for the next tick', async () => {
    seed()
    const { MessagingApiError } = await import('../graph')
    const refresh = vi.fn(async (token: string) => {
      if (token === 'OLD-A') return { token: 'NEW-A', expiresIn: 5183944 }
      throw new MessagingApiError('x', 400, 190, null)
    })
    const summary = await refreshInstagramTokens(cronDb(), { now, refresh })
    expect(summary).toEqual({ checked: 3, refreshed: 1, expired: 2, errors: 0 })
    const byId = Object.fromEntries(channels().map((c) => [c.id, c]))
    expect(byId.a).toMatchObject({ access_token: 'enc:NEW-A', status: 'active' })
    expect(Date.parse(byId.a.token_expires_at as string)).toBeGreaterThan(now.getTime() + 59 * 86_400_000)
    expect(byId.b.status).toBe('expired')
    expect(byId.c.status).toBe('expired')
    expect(refresh).not.toHaveBeenCalledWith('OLD-C')

    channels().length = 0
    seed()
    const net = vi.fn(async () => {
      throw new MessagingApiError('x', 503, null, null)
    })
    const s2 = await refreshInstagramTokens(cronDb(), { now, refresh: net })
    expect(s2).toMatchObject({ refreshed: 0, errors: 2, expired: 1 })
    expect(channels().find((c) => c.id === 'a')?.status).toBe('active')
  })
})
