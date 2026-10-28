// ============================================================
// Route handlers for connecting Instagram / Messenger (part B), shared by
// /api/meta/messaging/{connect,callback}/[kind], /pages and /disconnect.
//
//   connect     admin → signed `state` (+ nonce cookie) → 302 to Meta's consent screen.
//   callback    verify state + nonce + same user/account → exchange the code (server side)
//               → profile → check nobody else owns the id → subscribe the webhook → save
//               the encrypted token → back to Settings with ?meta=connected or ?meta_error=.
//               Messenger with several Pages: the Pages (with their tokens, encrypted) wait
//               in `meta_connect_sessions` for 15 min and the admin picks one (POST /pages).
//   disconnect  unsubscribe (best effort) → delete the row; conversations stay.
//
// ?meta_error= codes, rendered by meta-messaging-panel.tsx: not_configured, module, forbidden,
// denied, state, exchange, provider, no_pages, owned, subscribe, save, unauthorized.
// ============================================================

import { NextResponse } from 'next/server'

import { oauthRedirectBase } from '@/lib/calendar/sync/config'
import { requireModule, requireRole, requireWritable, toErrorResponse, type AccountContext } from '@/lib/auth/account'
import { AUDIT_ACTIONS, logAudit } from '@/lib/audit'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import type { MetaMessagingChannel } from '@/types'

import { messagingModule } from '../channels'
import { MessagingApiError } from '../graph'
import { appCredentials, authorizeUrl, callbackUrl, SETTINGS_RETURN_PATH } from './config'
import {
  exchangeFacebookCode,
  exchangeInstagramCode,
  fetchInstagramProfile,
  listFacebookPages,
  subscribeWebhook,
  toLongLivedFacebook,
  toLongLivedInstagram,
  tokenIsDead,
  unsubscribeWebhook,
  type FacebookPage,
} from './oauth'
import { signConnectState, STATE_MAX_AGE_MS, verifyConnectState } from './state'
import {
  deleteConnection,
  findIncumbent,
  loadOwnConnection,
  OwnedByAnotherAccountError,
  saveConnection,
  type Incumbent,
} from './store'

export type ConnectErrorCode =
  | 'not_configured'
  | 'module'
  | 'forbidden'
  | 'denied'
  | 'state'
  | 'exchange'
  | 'provider'
  | 'no_pages'
  | 'owned'
  | 'subscribe'
  | 'save'
  | 'unauthorized'
  | 'read_only'
  | 'blocked'

export function isKind(v: unknown): v is MetaMessagingChannel {
  return v === 'instagram' || v === 'messenger'
}

const cookieName = (kind: MetaMessagingChannel) => `metamsg_${kind}_nonce`
const DAY_S = 86_400

function settingsRedirect(request: Request, query: Record<string, string>): NextResponse {
  const url = new URL(SETTINGS_RETURN_PATH, oauthRedirectBase(request.url) || 'http://localhost')
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  return NextResponse.redirect(url.toString(), { status: 302 })
}

function errorRedirect(request: Request, kind: MetaMessagingChannel, code: ConnectErrorCode): NextResponse {
  const res = settingsRedirect(request, { meta_error: code, kind })
  res.cookies.set(cookieName(kind), '', { maxAge: 0, path: '/' })
  return res
}

/** Admin of the account, writable account, channel module on. Throws the usual auth errors. */
async function adminContext(kind: MetaMessagingChannel): Promise<AccountContext> {
  const ctx = await requireRole('admin')
  await requireWritable(ctx)
  await requireModule(ctx, messagingModule(kind))
  return ctx
}

/** Auth failure → the error code for a redirect. */
function redirectCodeFor(err: unknown): ConnectErrorCode {
  const name = err instanceof Error ? err.name : ''
  if (name === 'ModuleNotIncludedError') return 'module'
  if (name === 'UnauthorizedError') return 'unauthorized'
  // requireWritable: trial ended / payment overdue (ReadOnlyError) or blocked (ForbiddenError account_blocked)
  if (name === 'ReadOnlyError') return 'read_only'
  if ((err as { code?: string }).code === 'account_blocked') return 'blocked'
  return 'forbidden'
}

// ------------------------------------------------------------
// connect
// ------------------------------------------------------------

export async function handleConnect(request: Request, kind: MetaMessagingChannel): Promise<NextResponse> {
  let ctx: AccountContext
  try {
    ctx = await adminContext(kind)
  } catch (err) {
    return errorRedirect(request, kind, redirectCodeFor(err))
  }
  const limit = checkRateLimit(`meta-connect:${ctx.userId}`, RATE_LIMITS.adminAction)
  if (!limit.success) return rateLimitResponse(limit)

  const creds = appCredentials(kind)
  if (!creds) return errorRedirect(request, kind, 'not_configured')

  const state = signConnectState({ userId: ctx.userId, accountId: ctx.accountId, kind })
  const nonce = verifyConnectState(state, { kind })!.nonce
  const redirectUri = callbackUrl(kind, request.url)

  const res = NextResponse.redirect(authorizeUrl(kind, { creds, redirectUri, state }), { status: 302 })
  res.cookies.set(cookieName(kind), nonce, {
    httpOnly: true,
    sameSite: 'lax',
    secure: redirectUri.startsWith('https://'),
    path: '/',
    maxAge: Math.floor(STATE_MAX_AGE_MS / 1000),
  })
  return res
}

// ------------------------------------------------------------
// finishing a connection (shared by the callback and the Page picker)
// ------------------------------------------------------------

interface Target {
  externalId: string
  name: string | null
  pictureUrl: string | null
  token: string
  expiresAt: Date | null
}

async function finishConnection(ctx: AccountContext, kind: MetaMessagingChannel, t: Target): Promise<ConnectErrorCode | null> {
  const admin = supabaseAdmin()

  // Somebody else holds this id? Only a dead connection can be taken over: its status is not
  // 'active', or its own token is refused by Meta (190). A working one is never stolen.
  let takeover: Incumbent | null = null
  try {
    const incumbent = await findIncumbent(admin, ctx.accountId, kind, t.externalId)
    if (incumbent) {
      const dead = incumbent.status !== 'active' || (await tokenIsDead(kind, incumbent.token))
      if (!dead) return 'owned'
      takeover = incumbent
    }
  } catch {
    return 'save'
  }

  // The account's current connection of this kind, to clean up if this one is a different id.
  const previous = await loadOwnConnection(admin, ctx.accountId, kind)

  try {
    await subscribeWebhook(kind, t.externalId, t.token)
  } catch (err) {
    console.error('[meta-connect] subscribe failed:', err instanceof MessagingApiError ? `code ${err.code}/${err.subcode}` : 'network')
    return 'subscribe'
  }

  try {
    if (takeover) await deleteConnection(admin, takeover.id, takeover.accountId)
    await saveConnection(admin, { accountId: ctx.accountId, kind, ...t })
  } catch (err) {
    const ownedNow =
      err instanceof OwnedByAnotherAccountError ||
      (await findIncumbent(admin, ctx.accountId, kind, t.externalId).then((i) => !!i, () => true))
    // The webhook subscription is per app + id: drop the one we just made, unless another account
    // now relies on it, or this is the account's own existing connection to the same id.
    if (!ownedNow && previous?.externalId !== t.externalId) await unsubscribeWebhook(kind, t.externalId, t.token)
    if (err instanceof OwnedByAnotherAccountError) return 'owned'
    console.error('[meta-connect] save failed:', err instanceof Error ? err.message : 'error')
    return 'save'
  }

  if (previous && previous.externalId !== t.externalId && previous.token) {
    await unsubscribeWebhook(kind, previous.externalId, previous.token)
  }
  if (takeover) {
    const metadata = { kind, external_id: t.externalId }
    await logAudit(admin, { accountId: ctx.accountId, actorUserId: ctx.userId, action: AUDIT_ACTIONS.META_CHANNEL_TAKEN_OVER, entityType: 'meta_channel', metadata })
    await logAudit(admin, { accountId: takeover.accountId, actorUserId: null, actorName: 'Sistema', action: AUDIT_ACTIONS.META_CHANNEL_LOST, entityType: 'meta_channel', metadata })
  }
  return null
}

// ------------------------------------------------------------
// callback
// ------------------------------------------------------------

export async function handleCallback(request: Request, kind: MetaMessagingChannel): Promise<NextResponse> {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const providerError = url.searchParams.get('error')

  let ctx: AccountContext
  try {
    ctx = await adminContext(kind)
  } catch (err) {
    return errorRedirect(request, kind, redirectCodeFor(err))
  }
  if (providerError) return errorRedirect(request, kind, providerError === 'access_denied' ? 'denied' : 'provider')

  const parsed = verifyConnectState(url.searchParams.get('state'), { kind })
  if (!parsed || parsed.userId !== ctx.userId || parsed.accountId !== ctx.accountId) {
    return errorRedirect(request, kind, 'state')
  }
  const cookie = request.headers.get('cookie')?.match(new RegExp(`(?:^|;\\s*)${cookieName(kind)}=([^;]+)`))?.[1]
  if (!cookie || cookie !== parsed.nonce) return errorRedirect(request, kind, 'state')
  // Meta appends "#_" to the code on Instagram redirects.
  const cleanCode = code?.replace(/#_$/, '')
  if (!cleanCode) return errorRedirect(request, kind, 'provider')

  const creds = appCredentials(kind)
  if (!creds) return errorRedirect(request, kind, 'not_configured')
  const redirectUri = callbackUrl(kind, request.url)

  const done = (): NextResponse => {
    const res = settingsRedirect(request, { meta: 'connected', kind })
    res.cookies.set(cookieName(kind), '', { maxAge: 0, path: '/' })
    return res
  }

  try {
    if (kind === 'instagram') {
      const short = await exchangeInstagramCode(creds, cleanCode, redirectUri)
      const long = await toLongLivedInstagram(creds, short.token)
      const profile = await fetchInstagramProfile(long.token, short.userId)
      const failure = await finishConnection(ctx, kind, {
        externalId: profile.externalId,
        name: profile.name,
        pictureUrl: profile.pictureUrl,
        token: long.token,
        expiresAt: new Date(Date.now() + (long.expiresIn ?? 60 * DAY_S) * 1000),
      })
      return failure ? errorRedirect(request, kind, failure) : done()
    }

    const userToken = await toLongLivedFacebook(creds, await exchangeFacebookCode(creds, cleanCode, redirectUri))
    const pages = await listFacebookPages(userToken)
    if (pages.length === 0) return errorRedirect(request, kind, 'no_pages')
    if (pages.length === 1) {
      const p = pages[0]
      const failure = await finishConnection(ctx, kind, {
        externalId: p.id,
        name: p.name,
        pictureUrl: p.pictureUrl,
        token: p.token,
        expiresAt: null,
      })
      return failure ? errorRedirect(request, kind, failure) : done()
    }
    // Several Pages: park them (tokens encrypted, server side) until the admin picks one.
    const admin = supabaseAdmin()
    await admin.from('meta_connect_sessions').delete().lt('expires_at', new Date().toISOString())
    const { data, error } = await admin
      .from('meta_connect_sessions')
      .insert({ account_id: ctx.accountId, user_id: ctx.userId, kind, pages: encrypt(JSON.stringify(pages)) })
      .select('id')
      .single()
    if (error || !data) return errorRedirect(request, kind, 'save')
    const res = settingsRedirect(request, { meta: 'pick', kind, session: data.id as string })
    res.cookies.set(cookieName(kind), '', { maxAge: 0, path: '/' })
    return res
  } catch (err) {
    console.error('[meta-connect] callback failed:', err instanceof MessagingApiError ? `status ${err.status} code ${err.code}` : 'error')
    return errorRedirect(request, kind, err instanceof MessagingApiError ? 'exchange' : 'provider')
  }
}

// ------------------------------------------------------------
// Page picker (Messenger, several Pages)
// ------------------------------------------------------------

async function loadSession(ctx: AccountContext, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  const { data } = await supabaseAdmin()
    .from('meta_connect_sessions')
    .select('id, account_id, user_id, kind, pages, expires_at')
    .eq('id', id)
    .maybeSingle()
  if (!data || data.account_id !== ctx.accountId || data.user_id !== ctx.userId) return null
  if (data.kind !== 'messenger' || Date.parse(data.expires_at as string) <= Date.now()) return null
  try {
    return { id: data.id as string, pages: JSON.parse(decrypt(data.pages as string)) as FacebookPage[] }
  } catch {
    return null
  }
}

/** GET ?session= → the Pages to choose from (never the tokens). */
export async function handleListPages(request: Request): Promise<NextResponse> {
  let ctx: AccountContext
  try {
    ctx = await adminContext('messenger')
  } catch (err) {
    return toErrorResponse(err)
  }
  const session = await loadSession(ctx, new URL(request.url).searchParams.get('session') ?? '')
  if (!session) return NextResponse.json({ error: 'A escolha expirou. Conecte de novo.', code: 'session_expired' }, { status: 410 })
  return NextResponse.json({ pages: session.pages.map((p) => ({ id: p.id, name: p.name, picture_url: p.pictureUrl })) })
}

/** POST { session, page_id } → connect that Page. */
export async function handlePickPage(request: Request): Promise<NextResponse> {
  let ctx: AccountContext
  try {
    ctx = await adminContext('messenger')
  } catch (err) {
    return toErrorResponse(err)
  }
  const limit = checkRateLimit(`meta-connect:${ctx.userId}`, RATE_LIMITS.adminAction)
  if (!limit.success) return rateLimitResponse(limit)

  const body = (await request.json().catch(() => null)) as { session?: unknown; page_id?: unknown } | null
  const session = await loadSession(ctx, typeof body?.session === 'string' ? body.session : '')
  if (!session) return NextResponse.json({ error: 'A escolha expirou. Conecte de novo.', code: 'session_expired' }, { status: 410 })
  const page = session.pages.find((p) => p.id === body?.page_id)
  if (!page) return NextResponse.json({ error: 'Página não encontrada.', code: 'page_not_found' }, { status: 400 })

  const failure = await finishConnection(ctx, 'messenger', {
    externalId: page.id,
    name: page.name,
    pictureUrl: page.pictureUrl,
    token: page.token,
    expiresAt: null,
  })
  if (failure) return NextResponse.json({ error: FAILURE_PT[failure], code: failure }, { status: failure === 'owned' ? 409 : 502 })
  // Single use: the parked tokens go away as soon as one Page is chosen.
  await supabaseAdmin().from('meta_connect_sessions').delete().eq('id', session.id)
  return NextResponse.json({ ok: true })
}

/** DELETE ?session= → the picker's Cancel: drops the caller's own parked Pages (user + account bound). */
export async function handleCancelSession(request: Request): Promise<NextResponse> {
  let ctx: AccountContext
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }
  const id = new URL(request.url).searchParams.get('session') ?? ''
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Sessão inválida.', code: 'invalid_session' }, { status: 400 })
  await supabaseAdmin().from('meta_connect_sessions').delete().eq('id', id).eq('account_id', ctx.accountId).eq('user_id', ctx.userId)
  return NextResponse.json({ ok: true })
}

const FAILURE_PT: Partial<Record<ConnectErrorCode, string>> = {
  owned: 'Esta conta já está conectada a outra empresa no SempreCRM.',
  subscribe: 'Não foi possível ativar o recebimento de mensagens na Meta. Tente novamente.',
  save: 'Não foi possível salvar a conexão. Tente novamente.',
}

// ------------------------------------------------------------
// disconnect
// ------------------------------------------------------------

export async function handleDisconnect(request: Request): Promise<NextResponse> {
  let ctx: AccountContext
  try {
    // Admin only: cutting a channel off only deletes the caller's own row, so a read-only /
    // past-due account must still be able to do it.
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }
  const limit = checkRateLimit(`meta-connect:${ctx.userId}`, RATE_LIMITS.adminAction)
  if (!limit.success) return rateLimitResponse(limit)

  const body = (await request.json().catch(() => null)) as { kind?: unknown } | null
  if (!isKind(body?.kind)) return NextResponse.json({ error: 'Canal inválido.', code: 'invalid_kind' }, { status: 400 })
  const kind = body.kind
  // No module check: an account whose plan lost the channel must still be able to cut it off.
  const admin = supabaseAdmin()
  const conn = await loadOwnConnection(admin, ctx.accountId, kind)
  if (!conn) return NextResponse.json({ error: 'Canal não conectado.', code: 'not_connected' }, { status: 404 })

  if (conn.token) await unsubscribeWebhook(kind, conn.externalId, conn.token)
  try {
    await deleteConnection(admin, conn.id, ctx.accountId)
  } catch {
    return NextResponse.json({ error: 'Não foi possível desconectar. Tente novamente.', code: 'save' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}

// ------------------------------------------------------------
// status (what the Settings cards render)
// ------------------------------------------------------------

export async function handleStatus(): Promise<NextResponse> {
  let ctx: AccountContext
  try {
    ctx = await requireRole('viewer')
  } catch (err) {
    return toErrorResponse(err)
  }
  const { data } = await supabaseAdmin()
    .from('meta_messaging_channels')
    .select('kind, name, picture_url, status, token_expires_at, connected_at')
    .eq('account_id', ctx.accountId)
  const rows = (data ?? []) as { kind: MetaMessagingChannel }[]
  const out = {} as Record<MetaMessagingChannel, unknown>
  for (const kind of ['instagram', 'messenger'] as const) {
    out[kind] = { configured: !!appCredentials(kind), connection: rows.find((r) => r.kind === kind) ?? null }
  }
  return NextResponse.json(out)
}
