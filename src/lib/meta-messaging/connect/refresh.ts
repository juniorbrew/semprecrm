// ============================================================
// Instagram token renewal (cron). A long-lived Instagram token lasts 60 days and
// can be refreshed once it is 24 h old. We refresh as soon as it is a week old
// (expires within 53 days), so a few missed ticks never matter. Messenger Page
// tokens do not expire and are never refreshed; a dead one (code 190) is flagged
// when a send or profile lookup meets it.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { decrypt, encrypt } from '@/lib/whatsapp/encryption'

import { MessagingApiError } from '../graph'
import { refreshInstagramToken } from './oauth'

const DAY_MS = 86_400_000
/** Refresh once the token is a week old: 60 days minus 7. */
export const REFRESH_WITHIN_DAYS = 53
const BATCH = 200

export interface RefreshRow {
  id: string
  status: string
  token_expires_at: string | null
}

/** Pure selection, for tests: active Instagram connections that are due. */
export function dueForRefresh(rows: readonly RefreshRow[], now: Date): { refresh: string[]; expired: string[] } {
  const refresh: string[] = []
  const expired: string[] = []
  for (const r of rows) {
    if (r.status !== 'active' || !r.token_expires_at) continue
    const at = Date.parse(r.token_expires_at)
    if (!Number.isFinite(at)) continue
    if (at <= now.getTime()) expired.push(r.id)
    else if (at <= now.getTime() + REFRESH_WITHIN_DAYS * DAY_MS) refresh.push(r.id)
  }
  return { refresh, expired }
}

export interface RefreshSummary {
  checked: number
  refreshed: number
  expired: number
  errors: number
}

export async function refreshInstagramTokens(
  db: SupabaseClient,
  opts: { now?: Date; refresh?: typeof refreshInstagramToken } = {},
): Promise<RefreshSummary> {
  const now = opts.now ?? new Date()
  const refresh = opts.refresh ?? refreshInstagramToken
  const summary: RefreshSummary = { checked: 0, refreshed: 0, expired: 0, errors: 0 }

  const { data, error } = await db
    .from('meta_messaging_channels')
    .select('id, status, token_expires_at, access_token')
    .eq('kind', 'instagram')
    .eq('status', 'active')
    .not('token_expires_at', 'is', null)
    .lte('token_expires_at', new Date(now.getTime() + REFRESH_WITHIN_DAYS * DAY_MS).toISOString())
    .order('token_expires_at', { ascending: true })
    .limit(BATCH)
  if (error) throw new Error(`token lookup failed: ${error.code ?? 'unknown'}`)

  const rows = (data ?? []) as (RefreshRow & { access_token: string })[]
  summary.checked = rows.length
  const due = dueForRefresh(rows, now)

  const markExpired = async (id: string) => {
    const { error: e } = await db.from('meta_messaging_channels').update({ status: 'expired' }).eq('id', id)
    if (e) summary.errors += 1
    else summary.expired += 1
  }
  for (const id of due.expired) await markExpired(id)

  const byId = new Map(rows.map((r) => [r.id, r]))
  for (const id of due.refresh) {
    const row = byId.get(id)!
    try {
      const fresh = await refresh(decrypt(row.access_token))
      const { error: e } = await db
        .from('meta_messaging_channels')
        .update({
          access_token: encrypt(fresh.token),
          token_expires_at: new Date(now.getTime() + (fresh.expiresIn ?? 60 * 86_400) * 1000).toISOString(),
        })
        .eq('id', id)
      if (e) summary.errors += 1
      else summary.refreshed += 1
    } catch (err) {
      // A refused token (revoked, expired, permission removed) cannot recover by itself: the
      // admin must reconnect. A network / 5xx failure is retried on the next tick.
      if (err instanceof MessagingApiError && (err.tokenInvalid || err.status === 400)) await markExpired(id)
      else summary.errors += 1
      console.warn('[meta-connect] token refresh failed:', err instanceof MessagingApiError ? `code ${err.code}` : 'error')
    }
  }
  return summary
}
