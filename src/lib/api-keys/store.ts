import type { SupabaseClient } from '@supabase/supabase-js'

export const MAX_ACTIVE_KEYS = 20

/** Columns safe to return to the browser (never key_hash). */
export const KEY_COLUMNS =
  'id, name, note, key_prefix, key_last4, scopes, allowed_cidrs, created_at, last_used_at, last_used_ip, expires_at, revoked_at'

/** Keys that still authenticate: not revoked and not past their rotation grace period. */
export async function countActiveKeys(db: SupabaseClient, accountId: string, now = new Date()): Promise<number> {
  const { count } = await db
    .from('api_keys')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .is('revoked_at', null)
    .or(`expires_at.is.null,expires_at.gt.${now.toISOString()}`)
  return count ?? 0
}

/** Optional 0-200 char note. Null = none, undefined = invalid. */
export function normalizeNote(input: unknown): string | null | undefined {
  if (input === undefined || input === null) return null
  if (typeof input !== 'string') return undefined
  const n = input.trim()
  if (n.length > 200) return undefined
  return n === '' ? null : n
}
