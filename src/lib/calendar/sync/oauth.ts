// ============================================================
// Calendar sync — the OAuth route handlers, shared by
// /api/integrations/{google,microsoft}/{connect,callback,disconnect}.
//
//   connect     session user → signed `state` (+ nonce cookie) →
//               302 to the provider's consent screen.
//   callback    verify state + nonce + same user → exchange the code →
//               account email → upsert the connection (tokens
//               encrypted) → initial sync → back to Settings → Agenda
//               with `?connected=<provider>` or `?error=<code>`.
//   disconnect  revoke (best-effort) → delete the connection, drop the
//               rows imported from it and detach the mirrored ones.
//
// Error codes on the redirect (`?error=`), rendered by
// calendar-settings.tsx: not_configured, module, denied, state,
// exchange, provider.
// ============================================================

import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { getCurrentAccount, requireModule, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import type { CalendarProvider } from '@/types'

import { callbackUrl, oauthRedirectBase, providerCredentials, SETTINGS_RETURN_PATH } from './config'
import { ADAPTERS, syncConnection } from './engine'
import { defaultHttpDeps } from './http'
import { signState, verifyState, STATE_MAX_AGE_MS } from './state'
import { createSyncStore, deleteConnectionAndDetach, loadConnection, upsertConnection } from './store'

export type OAuthErrorCode = 'not_configured' | 'module' | 'denied' | 'state' | 'exchange' | 'provider' | 'unauthorized'

function cookieName(provider: CalendarProvider): string {
  return `calsync_${provider}_nonce`
}

function settingsRedirect(request: Request, query: Record<string, string>): NextResponse {
  const base = oauthRedirectBase(request.url)
  const url = new URL(SETTINGS_RETURN_PATH, base || 'http://localhost')
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  return NextResponse.redirect(url.toString(), { status: 302 })
}

function errorRedirect(request: Request, provider: CalendarProvider, code: OAuthErrorCode): NextResponse {
  const res = settingsRedirect(request, { error: code, provider })
  res.cookies.set(cookieName(provider), '', { maxAge: 0, path: '/' })
  return res
}

// ------------------------------------------------------------
// connect
// ------------------------------------------------------------

export async function handleConnect(request: Request, provider: CalendarProvider): Promise<NextResponse> {
  let ctx
  try {
    ctx = await getCurrentAccount()
  } catch (err) {
    return toErrorResponse(err)
  }
  const limit = checkRateLimit(`calendar:oauth:${ctx.userId}`, RATE_LIMITS.adminAction)
  if (!limit.success) return rateLimitResponse(limit)

  try {
    await requireModule(ctx, 'calendar')
  } catch {
    return errorRedirect(request, provider, 'module')
  }

  const creds = providerCredentials(provider)
  if (!creds) return errorRedirect(request, provider, 'not_configured')

  const state = signState({ userId: ctx.userId, provider })
  const nonce = verifyState(state, { provider })!.nonce
  const redirectUri = callbackUrl(provider, oauthRedirectBase(request.url))
  const target = ADAPTERS[provider].authUrl({ creds, redirectUri, state })

  const res = NextResponse.redirect(target, { status: 302 })
  res.cookies.set(cookieName(provider), nonce, {
    httpOnly: true,
    sameSite: 'lax',
    secure: redirectUri.startsWith('https://'),
    path: '/',
    maxAge: Math.floor(STATE_MAX_AGE_MS / 1000),
  })
  return res
}

// ------------------------------------------------------------
// callback
// ------------------------------------------------------------

export async function handleCallback(request: Request, provider: CalendarProvider): Promise<NextResponse> {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const providerError = url.searchParams.get('error')

  let ctx
  try {
    ctx = await getCurrentAccount()
  } catch {
    return errorRedirect(request, provider, 'unauthorized')
  }

  if (providerError) {
    return errorRedirect(request, provider, providerError === 'access_denied' ? 'denied' : 'provider')
  }

  const parsed = verifyState(state, { provider })
  if (!parsed || parsed.userId !== ctx.userId) return errorRedirect(request, provider, 'state')
  const nonceCookie = request.headers.get('cookie')?.match(new RegExp(`(?:^|;\\s*)${cookieName(provider)}=([^;]+)`))?.[1]
  if (!nonceCookie || nonceCookie !== parsed.nonce) return errorRedirect(request, provider, 'state')
  if (!code) return errorRedirect(request, provider, 'provider')

  const creds = providerCredentials(provider)
  if (!creds) return errorRedirect(request, provider, 'not_configured')

  const adapter = ADAPTERS[provider]
  const http = defaultHttpDeps()
  const redirectUri = callbackUrl(provider, oauthRedirectBase(request.url))

  let tokens
  try {
    tokens = await adapter.exchangeCode(http, creds, code, redirectUri)
  } catch (err) {
    console.error(`[calendar oauth] ${provider} code exchange failed:`, err)
    return errorRedirect(request, provider, 'exchange')
  }

  let email: string | null = null
  try {
    email = await adapter.fetchEmail(http, tokens.access_token)
  } catch (err) {
    console.error(`[calendar oauth] ${provider} profile lookup failed:`, err)
  }

  const admin = supabaseAdmin()
  let conn
  try {
    conn = await upsertConnection(admin, {
      account_id: ctx.accountId,
      user_id: ctx.userId,
      provider,
      email,
      external_calendar_id: provider === 'google' ? 'primary' : null,
      access_token_enc: encrypt(tokens.access_token),
      refresh_token_enc: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
      token_expires_at: tokens.expires_at,
    })
  } catch (err) {
    console.error(`[calendar oauth] ${provider} could not save the connection:`, err)
    return errorRedirect(request, provider, 'provider')
  }

  // Initial sync — best-effort; the cron picks up whatever is left.
  try {
    await syncConnection(conn, { store: createSyncStore(admin), http })
  } catch (err) {
    console.error(`[calendar oauth] ${provider} initial sync failed:`, err)
  }

  const res = settingsRedirect(request, { connected: provider })
  res.cookies.set(cookieName(provider), '', { maxAge: 0, path: '/' })
  return res
}

// ------------------------------------------------------------
// disconnect
// ------------------------------------------------------------

export async function handleDisconnect(provider: CalendarProvider): Promise<NextResponse> {
  try {
    const ctx = await getCurrentAccount()
    const limit = checkRateLimit(`calendar:oauth:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const admin = supabaseAdmin()
    const conn = await loadConnection(admin, ctx.userId, provider)
    if (!conn) return NextResponse.json({ error: 'Not connected' }, { status: 404 })

    const creds = providerCredentials(provider)
    if (creds) {
      const safe = (v: string | null) => {
        try {
          return v ? decrypt(v) : null
        } catch {
          return null
        }
      }
      await ADAPTERS[provider].revokeToken(defaultHttpDeps(), creds, {
        access: safe(conn.access_token_enc),
        refresh: safe(conn.refresh_token_enc),
      })
    }

    await deleteConnectionAndDetach(admin, conn)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
