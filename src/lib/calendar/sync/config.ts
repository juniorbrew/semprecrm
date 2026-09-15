// ============================================================
// Calendar sync — provider configuration (env). Pure: every function
// takes the env as an argument so tests never touch process.env.
//
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET   Google Cloud OAuth client
//   MS_CLIENT_ID / MS_CLIENT_SECRET / MS_TENANT  Microsoft Entra app
//                                               (tenant default `common`)
//
// A provider is "configured" when both its id and secret are set;
// Settings → Agenda shows "Integração não configurada" otherwise and
// the connect route refuses to start the OAuth dance.
// ============================================================

import type { CalendarProvider } from '@/types'

export const CALENDAR_PROVIDERS: readonly CalendarProvider[] = ['google', 'microsoft'] as const

export function isCalendarProvider(value: unknown): value is CalendarProvider {
  return value === 'google' || value === 'microsoft'
}

/** Human labels — pass through `t()` in the UI. */
export const PROVIDER_LABELS: Record<CalendarProvider, string> = {
  google: 'Google Calendar',
  microsoft: 'Outlook',
}

export const DEFAULT_MS_TENANT = 'common'

export interface ProviderCredentials {
  clientId: string
  clientSecret: string
  /** Microsoft only — `common`, `organizations`, `consumers` or a tenant id. */
  tenant: string
}

type Env = Record<string, string | undefined>

function clean(v: string | undefined): string {
  return (v ?? '').trim()
}

/** The provider's OAuth credentials, or null when the env is incomplete. */
export function providerCredentials(
  provider: CalendarProvider,
  env: Env = process.env,
): ProviderCredentials | null {
  if (provider === 'google') {
    const clientId = clean(env.GOOGLE_CLIENT_ID)
    const clientSecret = clean(env.GOOGLE_CLIENT_SECRET)
    if (!clientId || !clientSecret) return null
    return { clientId, clientSecret, tenant: '' }
  }
  const clientId = clean(env.MS_CLIENT_ID)
  const clientSecret = clean(env.MS_CLIENT_SECRET)
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret, tenant: clean(env.MS_TENANT) || DEFAULT_MS_TENANT }
}

export function isProviderConfigured(provider: CalendarProvider, env: Env = process.env): boolean {
  return providerCredentials(provider, env) !== null
}

/** `{ google: boolean, microsoft: boolean }` — what Settings renders. */
export function configuredProviders(env: Env = process.env): Record<CalendarProvider, boolean> {
  return {
    google: isProviderConfigured('google', env),
    microsoft: isProviderConfigured('microsoft', env),
  }
}

export const CALLBACK_PATH: Record<CalendarProvider, string> = {
  google: '/api/integrations/google/callback',
  microsoft: '/api/integrations/microsoft/callback',
}

/**
 * Base URL the provider redirects back to. `NEXT_PUBLIC_SITE_URL` when
 * set — that is the URL registered in the Google / Entra console —
 * except when the request itself came through `localhost` /
 * `127.0.0.1`: Google only accepts `localhost` or a real domain as a
 * redirect (never a LAN IP), so a developer connects through
 * http://localhost:<port> and the callback must land on the same
 * origin. Falls back to the request origin when the env is unset.
 */
export function oauthRedirectBase(requestUrl: string, env: Env = process.env): string {
  const origin = safeOrigin(requestUrl)
  const site = clean(env.NEXT_PUBLIC_SITE_URL).replace(/\/+$/, '')
  if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return origin
  return site || origin
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

export function callbackUrl(provider: CalendarProvider, base: string): string {
  return `${base.replace(/\/+$/, '')}${CALLBACK_PATH[provider]}`
}

/** Where the OAuth routes send the browser back to. */
export const SETTINGS_RETURN_PATH = '/settings?tab=calendar'
