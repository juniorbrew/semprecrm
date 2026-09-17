// ============================================================
// Calendar sync — Microsoft (Outlook) adapter: Entra ID OAuth 2.0
// (v2 endpoints) + Microsoft Graph.
//
//   Auth      login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize
//   Tokens    login.microsoftonline.com/{tenant}/oauth2/v2.0/token
//             (the refresh token rotates on every refresh)
//   Profile   graph.microsoft.com/v1.0/me (`mail` / `userPrincipalName`)
//   Events    /me/events (default calendar) or /me/calendars/{id}/events;
//             changes through /me/calendarView/delta (a window of
//             -30 / +365 days) following `@odata.nextLink` until the
//             `@odata.deltaLink` we persist. 410 → the delta state is
//             gone → full read again. `Prefer: outlook.timezone="UTC"`
//             makes every wall clock UTC.
//   Revoke    there is no per-token revoke endpoint; disconnect just
//             drops the tokens.
// ============================================================

import { bearer, httpNow, postForm, requestJson, type HttpDeps } from './http'
import {
  fromGraphEvent,
  toGraphEvent,
  type GraphEvent,
  type InboundEvent,
  type ProviderWriteResult,
} from './mapping'
import {
  DEFAULT_MAX_PAGES,
  LOOKAHEAD_DAYS,
  LOOKBACK_DAYS,
  expiresAtFrom,
  type ListChangesInput,
  type ListChangesResult,
  type ProviderAdapter,
  type TokenSet,
} from './provider'

export const MS_LOGIN_BASE = 'https://login.microsoftonline.com'
export const GRAPH_API = 'https://graph.microsoft.com/v1.0'
export const MS_SCOPES = 'Calendars.ReadWrite offline_access User.Read'

const PREFER_UTC = 'outlook.timezone="UTC"'
const PAGE_SIZE = 50

export function msAuthorizeUrl(tenant: string): string {
  return `${MS_LOGIN_BASE}/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`
}
export function msTokenUrl(tenant: string): string {
  return `${MS_LOGIN_BASE}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`
}

function eventsPath(calendarId: string | null): string {
  return calendarId ? `${GRAPH_API}/me/calendars/${encodeURIComponent(calendarId)}/events` : `${GRAPH_API}/me/events`
}

interface MsTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
}

interface GraphDeltaResponse {
  value?: GraphEvent[]
  '@odata.nextLink'?: string
  '@odata.deltaLink'?: string
}

function tokenSet(body: MsTokenResponse, now: Date): TokenSet {
  if (!body.access_token) throw new Error('microsoft: token response without access_token')
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? null,
    expires_at: expiresAtFrom(body.expires_in, now),
  }
}

function writeResult(body: GraphEvent | null, fallbackId: string): ProviderWriteResult {
  return {
    external_id: body?.id || fallbackId,
    external_etag: body?.['@odata.etag'] ?? null,
    external_updated_at: body?.lastModifiedDateTime ? new Date(body.lastModifiedDateTime).toISOString() : null,
  }
}

export const microsoftAdapter: ProviderAdapter = {
  provider: 'microsoft',

  authUrl({ creds, redirectUri, state }) {
    const params = new URLSearchParams({
      client_id: creds.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      response_mode: 'query',
      scope: MS_SCOPES,
      state,
    })
    return `${msAuthorizeUrl(creds.tenant)}?${params.toString()}`
  },

  async exchangeCode(deps, creds, code, redirectUri) {
    const body = await postForm<MsTokenResponse>(deps, 'microsoft', msTokenUrl(creds.tenant), {
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      scope: MS_SCOPES,
    })
    return tokenSet(body, httpNow(deps))
  },

  async refreshToken(deps, creds, refreshToken) {
    const body = await postForm<MsTokenResponse>(deps, 'microsoft', msTokenUrl(creds.tenant), {
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      scope: MS_SCOPES,
    })
    return tokenSet(body, httpNow(deps))
  },

  async fetchEmail(deps, accessToken) {
    const res = await requestJson<{ mail?: string | null; userPrincipalName?: string | null }>(
      deps,
      'microsoft',
      `${GRAPH_API}/me?$select=mail,userPrincipalName`,
      { headers: bearer(accessToken) },
    )
    const email = res.body?.mail || res.body?.userPrincipalName
    return typeof email === 'string' && email ? email : null
  },

  async revokeToken() {
    // No per-token revoke in the v2 endpoints; nothing to do.
  },

  async listChanges(deps, input) {
    return listGraphChanges(deps, input)
  },

  async createEvent(deps, accessToken, calendarId, row, tz) {
    const res = await requestJson<GraphEvent>(deps, 'microsoft', eventsPath(calendarId), {
      method: 'POST',
      headers: bearer(accessToken, { 'content-type': 'application/json', prefer: PREFER_UTC }),
      body: JSON.stringify(toGraphEvent(row, tz)),
    })
    return writeResult(res.body, '')
  },

  async updateEvent(deps, accessToken, _calendarId, externalId, row, tz) {
    const res = await requestJson<GraphEvent>(deps, 'microsoft', `${GRAPH_API}/me/events/${encodeURIComponent(externalId)}`, {
      method: 'PATCH',
      headers: bearer(accessToken, { 'content-type': 'application/json', prefer: PREFER_UTC }),
      body: JSON.stringify(toGraphEvent(row, tz)),
    })
    return writeResult(res.body, externalId)
  },

  async deleteEvent(deps, accessToken, _calendarId, externalId) {
    await requestJson(deps, 'microsoft', `${GRAPH_API}/me/events/${encodeURIComponent(externalId)}`, {
      method: 'DELETE',
      headers: bearer(accessToken),
      okStatuses: [404, 410],
    })
  },
}

function initialDeltaUrl(input: ListChangesInput): string {
  const start = new Date(input.now.getTime() - LOOKBACK_DAYS * 86_400_000).toISOString()
  const end = new Date(input.now.getTime() + LOOKAHEAD_DAYS * 86_400_000).toISOString()
  const base = input.calendarId
    ? `${GRAPH_API}/me/calendars/${encodeURIComponent(input.calendarId)}/calendarView/delta`
    : `${GRAPH_API}/me/calendarView/delta`
  const params = new URLSearchParams({ startDateTime: start, endDateTime: end })
  return `${base}?${params.toString()}`
}

async function listGraphChanges(deps: HttpDeps, input: ListChangesInput): Promise<ListChangesResult> {
  const maxPages = input.maxPages ?? DEFAULT_MAX_PAGES
  const items: InboundEvent[] = []
  let url = input.cursor || initialDeltaUrl(input)
  for (let page = 0; page < maxPages; page++) {
    const res = await requestJson<GraphDeltaResponse>(deps, 'microsoft', url, {
      headers: bearer(input.accessToken, { prefer: `odata.maxpagesize=${PAGE_SIZE}, ${PREFER_UTC}` }),
      okStatuses: [410],
    })
    if (res.status === 410) {
      return { items: [], cursor: null, done: false, resetRequired: true }
    }
    for (const g of res.body?.value ?? []) {
      const mapped = fromGraphEvent(g, input.tz)
      if (mapped) items.push(mapped)
    }
    const next = res.body?.['@odata.nextLink']
    if (next) {
      url = next
      continue
    }
    return { items, cursor: res.body?.['@odata.deltaLink'] ?? input.cursor, done: true }
  }
  // Page cap hit mid-read: persist the nextLink so the next run resumes.
  return { items, cursor: url, done: false }
}
