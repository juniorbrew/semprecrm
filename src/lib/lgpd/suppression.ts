// ============================================================
// Opt-out suppression list (migration 077). When an opted-out contact
// is anonymised its phone is gone, so "this number asked us to stop"
// would be lost and a later message / import would recreate the
// number as a fresh, reachable contact. Instead we keep a per-account
// HMAC of the number in `contact_suppressions` (service role only):
//
//   key  = HMAC-SHA256(ENCRYPTION_KEY, "contact-suppression:v1")
//   hash = HMAC-SHA256(key, "<account_id>:<canonical digits>")
//
// The phone itself is never stored, and the hash is useless without the
// server secret or across accounts. Canonical digits fold the Brazilian
// variants the dedupe treats as equal (with / without the 55 country
// code, with / without the mobile 9th digit): 55 + DDD + last 8 digits.
//
// Checked by: findOrCreateContact (inbound), the CSV import
// (POST /api/contacts/suppressions) and the broadcast sender.
// ============================================================

import { createHmac } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

export const SUPPRESSIONS_TABLE = 'contact_suppressions'

/** Digits, Brazilian variants folded (see header). '' when no digits. */
export function canonicalSuppressionPhone(phone: string | null | undefined): string {
  let d = (phone ?? '').replace(/\D/g, '')
  if (d.length === 10 || d.length === 11) d = `55${d}`
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) d = d.slice(0, 4) + d.slice(-8)
  return d
}

function suppressionKey(secret: string | undefined): Buffer {
  const hex = (secret ?? '').trim()
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error('ENCRYPTION_KEY must be 64 hex chars to hash the suppression list')
  }
  return createHmac('sha256', Buffer.from(hex, 'hex')).update('contact-suppression:v1').digest()
}

/** Hex HMAC for `phone` in `accountId`, or null when the phone has no digits. */
export function suppressionHash(
  accountId: string,
  phone: string | null | undefined,
  secret: string | undefined = process.env.ENCRYPTION_KEY,
): string | null {
  const canonical = canonicalSuppressionPhone(phone)
  if (!canonical) return null
  return createHmac('sha256', suppressionKey(secret)).update(`${accountId}:${canonical}`).digest('hex')
}

/** Store the number as suppressed. Throws on a DB / key failure. */
export async function recordSuppression(
  db: SupabaseClient,
  accountId: string,
  phone: string | null | undefined,
  secret?: string,
): Promise<boolean> {
  const hash = suppressionHash(accountId, phone, secret)
  if (!hash) return false
  const { error } = await db
    .from(SUPPRESSIONS_TABLE)
    .upsert({ account_id: accountId, phone_hash: hash }, { onConflict: 'account_id,phone_hash', ignoreDuplicates: true })
  if (error) throw new Error(`suppression write failed: ${error.message}`)
  return true
}

/**
 * The subset of `phones` (as given) that are on the account's suppression
 * list. Throws on a DB / key failure so each caller picks fail-open or
 * fail-closed explicitly.
 */
export async function findSuppressedPhones(
  db: SupabaseClient,
  accountId: string,
  phones: string[],
  secret?: string,
): Promise<Set<string>> {
  const byHash = new Map<string, string[]>()
  for (const p of phones) {
    const h = suppressionHash(accountId, p, secret)
    if (h) byHash.set(h, [...(byHash.get(h) ?? []), p])
  }
  const hashes = [...byHash.keys()]
  const out = new Set<string>()
  for (let i = 0; i < hashes.length; i += 200) {
    const { data, error } = await db
      .from(SUPPRESSIONS_TABLE)
      .select('phone_hash')
      .eq('account_id', accountId)
      .in('phone_hash', hashes.slice(i, i + 200))
    if (error) throw new Error(`suppression lookup failed: ${error.message}`)
    for (const r of (data ?? []) as { phone_hash: string }[]) {
      for (const p of byHash.get(r.phone_hash) ?? []) out.add(p)
    }
  }
  return out
}
