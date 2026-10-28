// ============================================================
// Meta calls for connecting a channel: code → token, long-lived token, profile,
// pages, webhook subscription, refresh. All server side (they carry app
// secrets). Errors become `MessagingApiError` with status / code / subcode only
// (Meta's own text can quote ids, and some URLs here carry secrets: never log
// a URL or a response body).
// ============================================================

import { GRAPH_BASE, MessagingApiError } from '../graph'
import { SUBSCRIBED_FIELDS, type AppCredentials } from './config'
import type { MetaMessagingChannel } from '@/types'

const TIMEOUT_MS = 15_000

type Json = Record<string, unknown>

async function metaRequest(
  url: string,
  opts: { method?: 'GET' | 'POST' | 'DELETE'; form?: Record<string, string>; bearer?: string } = {},
): Promise<Json> {
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: {
      ...(opts.bearer ? { Authorization: `Bearer ${opts.bearer}` } : {}),
      ...(opts.form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(opts.form ? { body: new URLSearchParams(opts.form).toString() } : {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const body = (await res.json().catch(() => null)) as Json | null
  // Graph: { error: { code, error_subcode } }; Instagram code exchange: { code, error_type, error_message }.
  const graphErr = body && typeof body.error === 'object' && body.error ? (body.error as Json) : null
  const igErr = body && typeof body.error_message === 'string' ? body : null
  if (!res.ok || graphErr || igErr) {
    const code = Number(graphErr?.code ?? igErr?.code)
    const subcode = Number(graphErr?.error_subcode)
    throw new MessagingApiError(
      `Meta error (status ${res.status}, code ${Number.isFinite(code) ? code : 'n/a'})`,
      res.status,
      Number.isFinite(code) ? code : null,
      Number.isFinite(subcode) ? subcode : null,
    )
  }
  return body ?? {}
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

export interface LongLivedToken {
  token: string
  /** Seconds until it expires; null = does not expire (Page tokens). */
  expiresIn: number | null
}

function tokenOf(body: Json): LongLivedToken {
  const token = str(body.access_token)
  if (!token) throw new MessagingApiError('Meta returned no token', 502, null, null)
  const expires = Number(body.expires_in)
  return { token, expiresIn: Number.isFinite(expires) && expires > 0 ? expires : null }
}

// ---- Instagram (Instagram API with Instagram Login) -----------------------------

/** Authorization code → short-lived Instagram User token. */
export async function exchangeInstagramCode(
  creds: AppCredentials,
  code: string,
  redirectUri: string,
): Promise<{ token: string; userId: string | null }> {
  const body = await metaRequest('https://api.instagram.com/oauth/access_token', {
    method: 'POST',
    form: {
      client_id: creds.appId,
      client_secret: creds.appSecret,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code,
    },
  })
  // Documented as { data: [{ access_token, user_id, permissions }] }; the live API has also answered flat.
  const first = Array.isArray(body.data) ? ((body.data[0] ?? {}) as Json) : body
  const token = str(first.access_token)
  if (!token) throw new MessagingApiError('Meta returned no token', 502, null, null)
  return { token, userId: first.user_id != null ? String(first.user_id) : null }
}

/** Short-lived → long-lived (60 days). */
export async function toLongLivedInstagram(creds: AppCredentials, shortToken: string): Promise<LongLivedToken> {
  const q = new URLSearchParams({
    grant_type: 'ig_exchange_token',
    client_secret: creds.appSecret,
    access_token: shortToken,
  })
  return tokenOf(await metaRequest(`https://graph.instagram.com/access_token?${q}`))
}

/** Refresh a long-lived token (it must be at least 24 h old and not expired). */
export async function refreshInstagramToken(token: string): Promise<LongLivedToken> {
  const q = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: token })
  return tokenOf(await metaRequest(`https://graph.instagram.com/refresh_access_token?${q}`))
}

export interface ChannelProfile {
  /** The id Meta sends as `entry[].id` / `recipient.id` in webhooks. */
  externalId: string
  name: string | null
  pictureUrl: string | null
}

/**
 * Per Meta's docs `user_id` (not `id`, which is app-scoped) is the id received in webhook
 * notifications for the account. `fallbackUserId` is the one the code exchange returned.
 */
export async function fetchInstagramProfile(token: string, fallbackUserId: string | null): Promise<ChannelProfile> {
  const me = await metaRequest(`${GRAPH_BASE.instagram}/me?fields=user_id,username,name,profile_picture_url`, {
    bearer: token,
  })
  const externalId = str(me.user_id) ?? fallbackUserId
  if (!externalId) throw new MessagingApiError('Meta returned no account id', 502, null, null)
  const username = str(me.username)
  return {
    externalId,
    name: str(me.name) ?? (username ? `@${username}` : null),
    pictureUrl: str(me.profile_picture_url),
  }
}

// ---- Messenger (Facebook Login for Pages) ------------------------------------------

export async function exchangeFacebookCode(creds: AppCredentials, code: string, redirectUri: string): Promise<string> {
  const q = new URLSearchParams({
    client_id: creds.appId,
    client_secret: creds.appSecret,
    redirect_uri: redirectUri,
    code,
  })
  return tokenOf(await metaRequest(`${GRAPH_BASE.messenger}/oauth/access_token?${q}`)).token
}

/** User token → long-lived user token (the Page tokens derived from it do not expire). */
export async function toLongLivedFacebook(creds: AppCredentials, userToken: string): Promise<string> {
  const q = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: creds.appId,
    client_secret: creds.appSecret,
    fb_exchange_token: userToken,
  })
  return tokenOf(await metaRequest(`${GRAPH_BASE.messenger}/oauth/access_token?${q}`)).token
}

export interface FacebookPage {
  id: string
  name: string | null
  pictureUrl: string | null
  /** Page access token — server only. */
  token: string
}

export async function listFacebookPages(userToken: string): Promise<FacebookPage[]> {
  const body = await metaRequest(`${GRAPH_BASE.messenger}/me/accounts?fields=id,name,access_token,picture%7Burl%7D&limit=100`, {
    bearer: userToken,
  })
  const rows = Array.isArray(body.data) ? (body.data as Json[]) : []
  const pages: FacebookPage[] = []
  for (const r of rows) {
    const id = str(r.id)
    const token = str(r.access_token)
    if (!id || !token) continue
    const picture = r.picture as { data?: { url?: unknown } } | undefined
    pages.push({ id, name: str(r.name), pictureUrl: str(picture?.data?.url), token })
  }
  return pages
}

// ---- Webhook subscription ----------------------------------------------------------

/** Subscribe the app to the account's / Page's messages. Throws MessagingApiError. */
export async function subscribeWebhook(kind: MetaMessagingChannel, externalId: string, token: string): Promise<void> {
  const q = new URLSearchParams({ subscribed_fields: SUBSCRIBED_FIELDS[kind] })
  await metaRequest(`${GRAPH_BASE[kind]}/${encodeURIComponent(externalId)}/subscribed_apps?${q}`, {
    method: 'POST',
    bearer: token,
  })
}

/**
 * Is this token dead? True only for a real token error (190); a network failure or any other
 * error is "not proven dead", so a working connection is never taken from its owner.
 */
export async function tokenIsDead(kind: MetaMessagingChannel, token: string): Promise<boolean> {
  if (!token) return true
  try {
    await metaRequest(`${GRAPH_BASE[kind]}/me?fields=${kind === 'instagram' ? 'user_id' : 'id'}`, { bearer: token })
    return false
  } catch (err) {
    return err instanceof MessagingApiError && err.tokenInvalid
  }
}

/** Best effort (disconnect): never throws. */
export async function unsubscribeWebhook(kind: MetaMessagingChannel, externalId: string, token: string): Promise<boolean> {
  try {
    await metaRequest(`${GRAPH_BASE[kind]}/${encodeURIComponent(externalId)}/subscribed_apps`, {
      method: 'DELETE',
      bearer: token,
    })
    return true
  } catch (err) {
    console.warn('[meta-connect] unsubscribe failed:', err instanceof MessagingApiError ? `code ${err.code}` : 'network')
    return false
  }
}
