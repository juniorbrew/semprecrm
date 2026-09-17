// ============================================================
// Calendar sync — the adapter contract both providers implement.
// The engine only speaks this interface; `google.ts` and
// `microsoft.ts` fill it in.
// ============================================================

import type { CalendarProvider } from '@/types'

import type { ProviderCredentials } from './config'
import type { HttpDeps } from './http'
import type { InboundEvent, MirroredRow, ProviderWriteResult } from './mapping'

export interface TokenSet {
  access_token: string
  /** Null when the provider did not rotate it (keep the stored one). */
  refresh_token: string | null
  /** ISO. */
  expires_at: string
}

export interface ListChangesInput {
  accessToken: string
  /** Google `syncToken` / Graph `deltaLink`; null = full read. */
  cursor: string | null
  calendarId: string | null
  now: Date
  /** Account zone (all-day mapping). */
  tz: string
  /** Page cap per run — a huge calendar is drained over several ticks. */
  maxPages?: number
}

export interface ListChangesResult {
  items: InboundEvent[]
  /** Cursor to persist for the next run (null while a full read is not finished). */
  cursor: string | null
  /** False when `maxPages` stopped the read early. */
  done: boolean
  /** The stored cursor is no longer valid (Google 410 / Graph SyncStateNotFound) — retry without it. */
  resetRequired?: boolean
}

export interface ProviderAdapter {
  readonly provider: CalendarProvider
  authUrl(input: { creds: ProviderCredentials; redirectUri: string; state: string }): string
  exchangeCode(deps: HttpDeps, creds: ProviderCredentials, code: string, redirectUri: string): Promise<TokenSet>
  refreshToken(deps: HttpDeps, creds: ProviderCredentials, refreshToken: string): Promise<TokenSet>
  fetchEmail(deps: HttpDeps, accessToken: string): Promise<string | null>
  /** Best-effort; never throws. */
  revokeToken(deps: HttpDeps, creds: ProviderCredentials, tokens: { access: string | null; refresh: string | null }): Promise<void>
  listChanges(deps: HttpDeps, input: ListChangesInput): Promise<ListChangesResult>
  createEvent(deps: HttpDeps, accessToken: string, calendarId: string | null, row: MirroredRow, tz: string): Promise<ProviderWriteResult>
  updateEvent(
    deps: HttpDeps,
    accessToken: string,
    calendarId: string | null,
    externalId: string,
    row: MirroredRow,
    tz: string,
  ): Promise<ProviderWriteResult>
  /** 404 / 410 (already gone) is not an error. */
  deleteEvent(deps: HttpDeps, accessToken: string, calendarId: string | null, externalId: string): Promise<void>
}

/** How far back the initial full read goes. */
export const LOOKBACK_DAYS = 30
/** How far ahead the Graph delta window goes (Google tracks all future events). */
export const LOOKAHEAD_DAYS = 365
export const DEFAULT_MAX_PAGES = 20

export function expiresAtFrom(expiresIn: unknown, now: Date): string {
  const secs = typeof expiresIn === 'number' && Number.isFinite(expiresIn) ? expiresIn : Number(expiresIn)
  const ms = Number.isFinite(secs) && secs > 0 ? secs * 1000 : 3600_000
  return new Date(now.getTime() + ms).toISOString()
}
