import { describe, expect, it } from 'vitest'

import { googleAdapter } from './google'
import { ProviderAuthError, ProviderHttpError, retryAfterMs, type HttpDeps } from './http'
import { GRAPH_API, MS_SCOPES, microsoftAdapter } from './microsoft'

const NOW = new Date('2026-09-14T12:00:00Z')
const TZ = 'America/Sao_Paulo'
const CREDS = { clientId: 'ms-id', clientSecret: 'ms-secret', tenant: 'common' }

function scripted(handler: (url: string, init: RequestInit | undefined, n: number) => { status?: number; body?: unknown }) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const deps: HttpDeps & { calls: typeof calls } = {
    calls,
    now: () => NOW,
    sleep: async () => {},
    fetch: async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push({ url, init })
      const out = handler(url, init, calls.length)
      const status = out.status ?? 200
      return new Response(status === 204 ? null : JSON.stringify(out.body ?? {}), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    },
  }
  return deps
}

describe('Microsoft adapter', () => {
  it('builds the Entra v2 authorize URL with the delegated scopes', () => {
    const url = new URL(microsoftAdapter.authUrl({ creds: CREDS, redirectUri: 'https://crm.x/api/integrations/microsoft/callback', state: 's1' }))
    expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'ms-id',
      response_type: 'code',
      redirect_uri: 'https://crm.x/api/integrations/microsoft/callback',
      response_mode: 'query',
      scope: MS_SCOPES,
      state: 's1',
    })
    expect(MS_SCOPES).toBe('Calendars.ReadWrite offline_access User.Read')
  })

  it('exchanges the code and refreshes with a rotating refresh token', async () => {
    const deps = scripted((url, init) => {
      expect(url).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token')
      const form = Object.fromEntries(new URLSearchParams(String(init?.body)))
      if (form.grant_type === 'authorization_code') {
        expect(form).toMatchObject({ code: 'c0de', redirect_uri: 'https://crm.x/cb', client_secret: 'ms-secret', scope: MS_SCOPES })
        return { body: { access_token: 'a1', refresh_token: 'r1', expires_in: 3600 } }
      }
      expect(form).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'r1' })
      return { body: { access_token: 'a2', refresh_token: 'r2', expires_in: 60 } }
    })
    const first = await microsoftAdapter.exchangeCode(deps, CREDS, 'c0de', 'https://crm.x/cb')
    expect(first).toEqual({ access_token: 'a1', refresh_token: 'r1', expires_at: '2026-09-14T13:00:00.000Z' })
    const second = await microsoftAdapter.refreshToken(deps, CREDS, first.refresh_token!)
    expect(second).toEqual({ access_token: 'a2', refresh_token: 'r2', expires_at: '2026-09-14T12:01:00.000Z' })
  })

  it('invalid_grant on the token endpoint is an auth error', async () => {
    const deps = scripted(() => ({ status: 400, body: { error: 'invalid_grant', error_description: 'AADSTS70000' } }))
    await expect(microsoftAdapter.refreshToken(deps, CREDS, 'r')).rejects.toBeInstanceOf(ProviderAuthError)
  })

  it('reads the account email from /me (mail, then userPrincipalName)', async () => {
    const deps = scripted((url, init) => {
      expect(url).toContain(`${GRAPH_API}/me?`)
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok')
      return { body: { mail: null, userPrincipalName: 'ana@contoso.com' } }
    })
    expect(await microsoftAdapter.fetchEmail(deps, 'tok')).toBe('ana@contoso.com')
  })

  it('delta: initial window, nextLink paging, deltaLink persisted, UTC preference', async () => {
    const deps = scripted((url, init, n) => {
      const prefer = (init?.headers as Record<string, string>).prefer
      expect(prefer).toContain('outlook.timezone="UTC"')
      if (n === 1) {
        expect(url).toContain(`${GRAPH_API}/me/calendarView/delta?`)
        expect(url).toContain('startDateTime=2026-08-15T12%3A00%3A00.000Z')
        expect(url).toContain('endDateTime=2027-09-14T12%3A00%3A00.000Z')
        return {
          body: {
            value: [
              {
                id: 'm1',
                subject: 'Um',
                start: { dateTime: '2026-09-16T13:00:00.0000000', timeZone: 'UTC' },
                end: { dateTime: '2026-09-16T14:00:00.0000000', timeZone: 'UTC' },
              },
            ],
            '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendarView/delta?$skiptoken=abc',
          },
        }
      }
      expect(url).toBe('https://graph.microsoft.com/v1.0/me/calendarView/delta?$skiptoken=abc')
      return {
        body: {
          value: [{ id: 'm2', '@removed': { reason: 'deleted' } }],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=xyz',
        },
      }
    })
    const res = await microsoftAdapter.listChanges(deps, { accessToken: 'tok', cursor: null, calendarId: null, now: NOW, tz: TZ })
    expect(res.done).toBe(true)
    expect(res.cursor).toBe('https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=xyz')
    expect(res.items.map((i) => [i.external_id, i.deleted])).toEqual([
      ['m1', false],
      ['m2', true],
    ])
    expect(res.items[0].fields).toMatchObject({ starts_at: '2026-09-16T13:00:00.000Z', title: 'Um' })
  })

  it('delta: a stored deltaLink is fetched as-is; 410 asks for a reset; the page cap keeps the nextLink', async () => {
    const link = 'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=old'
    const gone = scripted((url) => {
      expect(url).toBe(link)
      return { status: 410, body: { error: { code: 'SyncStateNotFound' } } }
    })
    expect(await microsoftAdapter.listChanges(gone, { accessToken: 'tok', cursor: link, calendarId: null, now: NOW, tz: TZ })).toMatchObject({
      resetRequired: true,
      cursor: null,
    })

    const paging = scripted((_url, _init, n) => ({
      body: { value: [{ id: `p${n}`, subject: 'x', start: { dateTime: '2026-09-16T13:00:00', timeZone: 'UTC' } }], '@odata.nextLink': `https://graph/next${n}` },
    }))
    const capped = await microsoftAdapter.listChanges(paging, {
      accessToken: 'tok',
      cursor: null,
      calendarId: null,
      now: NOW,
      tz: TZ,
      maxPages: 2,
    })
    expect(capped.done).toBe(false)
    expect(capped.cursor).toBe('https://graph/next2')
    expect(capped.items).toHaveLength(2)
  })

  it('create / patch / delete hit /me/events with the Graph payload', async () => {
    const deps = scripted((url, init) => {
      const method = init?.method
      if (method === 'POST') {
        expect(url).toBe(`${GRAPH_API}/me/events`)
        expect(JSON.parse(String(init?.body))).toMatchObject({
          subject: 'Reunião',
          start: { dateTime: '2026-09-15T13:00:00', timeZone: 'UTC' },
          isAllDay: false,
        })
        return { body: { id: 'new', '@odata.etag': 'W/"1"', lastModifiedDateTime: '2026-09-14T12:00:00Z' } }
      }
      if (method === 'PATCH') {
        expect(url).toBe(`${GRAPH_API}/me/events/new`)
        return { body: { id: 'new', '@odata.etag': 'W/"2"' } }
      }
      expect(method).toBe('DELETE')
      return { status: 404, body: { error: { code: 'ErrorItemNotFound' } } }
    })
    const row = {
      title: 'Reunião',
      description: null,
      location: null,
      starts_at: '2026-09-15T13:00:00Z',
      ends_at: '2026-09-15T14:00:00Z',
      all_day: false,
      status: 'confirmed' as const,
    }
    expect(await microsoftAdapter.createEvent(deps, 'tok', null, row, TZ)).toEqual({
      external_id: 'new',
      external_etag: 'W/"1"',
      external_updated_at: '2026-09-14T12:00:00.000Z',
    })
    expect(await microsoftAdapter.updateEvent(deps, 'tok', null, 'new', row, TZ)).toMatchObject({ external_etag: 'W/"2"' })
    await expect(microsoftAdapter.deleteEvent(deps, 'tok', null, 'new')).resolves.toBeUndefined()
  })
})

describe('Google adapter — auth URL and HTTP errors', () => {
  it('builds the consent URL with offline access and the calendar scopes', () => {
    const url = new URL(googleAdapter.authUrl({ creds: { clientId: 'g-id', clientSecret: 's', tenant: '' }, redirectUri: 'http://localhost:3101/api/integrations/google/callback', state: 'st' }))
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'g-id',
      redirect_uri: 'http://localhost:3101/api/integrations/google/callback',
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      state: 'st',
      scope: 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly openid email',
    })
  })

  it('a 403 surfaces as ProviderHttpError with the API message', async () => {
    const deps = scripted(() => ({ status: 403, body: { error: { code: 403, message: 'Insufficient Permission' } } }))
    await expect(googleAdapter.fetchEmail(deps, 'tok')).rejects.toMatchObject({
      name: 'ProviderHttpError',
      status: 403,
      message: expect.stringContaining('Insufficient Permission'),
    })
    await expect(googleAdapter.fetchEmail(deps, 'tok')).rejects.toBeInstanceOf(ProviderHttpError)
  })

  it('retryAfterMs honours seconds, dates and the cap', () => {
    expect(retryAfterMs(null)).toBe(1000)
    expect(retryAfterMs('3')).toBe(3000)
    expect(retryAfterMs('120')).toBe(5000)
    expect(retryAfterMs('garbage')).toBe(1000)
  })
})
