// ============================================================
// Calendar sync — Google Calendar adapter (OAuth 2.0 + Calendar API v3).
//
//   Auth      accounts.google.com/o/oauth2/v2/auth (offline + consent so
//             a refresh token is issued every time the user reconnects)
//   Tokens    oauth2.googleapis.com/token, /revoke
//   Profile   openidconnect.googleapis.com/v1/userinfo (`openid email`)
//   Events    www.googleapis.com/calendar/v3/calendars/primary/events
//             list with `syncToken` (incremental) or `timeMin`
//             (initial); `singleEvents=true` expands recurrences;
//             `showDeleted=true` so cancellations reach us. 410 →
//             the token expired → full read again.
// ============================================================

import { bearer, httpNow, postForm, requestJson, type HttpDeps } from './http'
import {
  fromGoogleEvent,
  toGoogleEvent,
  type GoogleEvent,
  type InboundEvent,
  type ProviderWriteResult,
} from './mapping'
import {
  DEFAULT_MAX_PAGES,
  LOOKBACK_DAYS,
  expiresAtFrom,
  type ListChangesInput,
  type ListChangesResult,
  type ProviderAdapter,
  type TokenSet,
} from './provider'

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
export const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo'
export const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3'
export const GOOGLE_SCOPES =
  'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly openid email'
export const GOOGLE_DEFAULT_CALENDAR = 'primary'

const PAGE_SIZE = 250

function calendarPath(calendarId: string | null): string {
  return `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId || GOOGLE_DEFAULT_CALENDAR)}/events`
}

interface GoogleTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
}

interface GoogleListResponse {
  items?: GoogleEvent[]
  nextPageToken?: string
  nextSyncToken?: string
}

function tokenSet(body: GoogleTokenResponse, now: Date): TokenSet {
  if (!body.access_token) throw new Error('google: token response without access_token')
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? null,
    expires_at: expiresAtFrom(body.expires_in, now),
  }
}

function writeResult(body: GoogleEvent | null, fallbackId: string): ProviderWriteResult {
  return {
    external_id: body?.id || fallbackId,
    external_etag: body?.etag ?? null,
    external_updated_at: body?.updated ? new Date(body.updated).toISOString() : null,
  }
}

export const googleAdapter: ProviderAdapter = {
  provider: 'google',

  authUrl({ creds, redirectUri, state }) {
    const params = new URLSearchParams({
      client_id: creds.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GOOGLE_SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    })
    return `${GOOGLE_AUTH_URL}?${params.toString()}`
  },

  async exchangeCode(deps, creds, code, redirectUri) {
    const body = await postForm<GoogleTokenResponse>(deps, 'google', GOOGLE_TOKEN_URL, {
      code,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    })
    return tokenSet(body, httpNow(deps))
  },

  async refreshToken(deps, creds, refreshToken) {
    const body = await postForm<GoogleTokenResponse>(deps, 'google', GOOGLE_TOKEN_URL, {
      refresh_token: refreshToken,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      grant_type: 'refresh_token',
    })
    return tokenSet(body, httpNow(deps))
  },

  async fetchEmail(deps, accessToken) {
    const res = await requestJson<{ email?: string }>(deps, 'google', GOOGLE_USERINFO_URL, {
      headers: bearer(accessToken),
    })
    const email = res.body?.email
    return typeof email === 'string' && email ? email : null
  },

  async revokeToken(deps, _creds, tokens) {
    const token = tokens.refresh || tokens.access
    if (!token) return
    try {
      await deps.fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      })
    } catch {
      // best-effort
    }
  },

  async listChanges(deps, input): Promise<ListChangesResult> {
    return listGoogleChanges(deps, input)
  },

  async createEvent(deps, accessToken, calendarId, row, tz) {
    const res = await requestJson<GoogleEvent>(deps, 'google', calendarPath(calendarId), {
      method: 'POST',
      headers: bearer(accessToken, { 'content-type': 'application/json' }),
      body: JSON.stringify(toGoogleEvent(row, tz)),
    })
    return writeResult(res.body, '')
  },

  async updateEvent(deps, accessToken, calendarId, externalId, row, tz) {
    const res = await requestJson<GoogleEvent>(
      deps,
      'google',
      `${calendarPath(calendarId)}/${encodeURIComponent(externalId)}`,
      {
        method: 'PATCH',
        headers: bearer(accessToken, { 'content-type': 'application/json' }),
        body: JSON.stringify(toGoogleEvent(row, tz)),
      },
    )
    return writeResult(res.body, externalId)
  },

  async deleteEvent(deps, accessToken, calendarId, externalId) {
    await requestJson(deps, 'google', `${calendarPath(calendarId)}/${encodeURIComponent(externalId)}`, {
      method: 'DELETE',
      headers: bearer(accessToken),
      okStatuses: [404, 410],
    })
  },
}

async function listGoogleChanges(deps: HttpDeps, input: ListChangesInput): Promise<ListChangesResult> {
  const maxPages = input.maxPages ?? DEFAULT_MAX_PAGES
  const items: InboundEvent[] = []
  let pageToken: string | null = null
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      maxResults: String(PAGE_SIZE),
      singleEvents: 'true',
      showDeleted: 'true',
    })
    if (input.cursor) params.set('syncToken', input.cursor)
    else params.set('timeMin', new Date(input.now.getTime() - LOOKBACK_DAYS * 86_400_000).toISOString())
    if (pageToken) params.set('pageToken', pageToken)

    const res = await requestJson<GoogleListResponse>(
      deps,
      'google',
      `${calendarPath(input.calendarId)}?${params.toString()}`,
      { headers: bearer(input.accessToken), okStatuses: [410] },
    )
    if (res.status === 410) {
      return { items: [], cursor: null, done: false, resetRequired: true }
    }
    for (const g of res.body?.items ?? []) {
      // Working-location / focus-time / OOO entries are not appointments.
      if (g.eventType && !['default', 'fromGmail'].includes(g.eventType)) continue
      const mapped = fromGoogleEvent(g, input.tz)
      if (mapped) items.push(mapped)
    }
    if (res.body?.nextPageToken) {
      pageToken = res.body.nextPageToken
      continue
    }
    return { items, cursor: res.body?.nextSyncToken ?? input.cursor, done: true }
  }
  // Page cap hit: apply what we have; the next run reads again from
  // the same cursor (the writes are idempotent by external_id).
  return { items, cursor: input.cursor, done: false }
}
