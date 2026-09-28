// ============================================================
// Contact profile photos (migration 055).
//
// Only the QR channel can fill `contacts.avatar_url`: the gateway asks
// WhatsApp Web for the photo (`profilePictureUrl`), downloads it and
// stores a copy in the `contact-avatars` bucket (WhatsApp CDN URLs
// expire). The Meta Cloud API has no endpoint for a customer's profile
// photo, so official-channel contacts keep the initials fallback.
//
// When: after a QR inbound message (route `after()`), if the contact
// was never checked or was checked more than AVATAR_REFRESH_MS ago.
// `avatar_checked_at` is stamped with a conditional UPDATE before the
// lookup — an atomic claim, so a burst of messages from one customer
// triggers a single gateway call. Throttling against bans lives in the
// gateway (serial per account, spaced); a throttled / failed lookup
// re-arms the claim to retry after AVATAR_RETRY_MS instead of a week.
//
// No `next/*` imports; the Supabase client and the gateway call are
// injected so this is unit-testable.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

/** Re-check a photo after a week. */
export const AVATAR_REFRESH_MS = 7 * 24 * 60 * 60 * 1000
/** A lookup that could not run (throttled, offline, CDN error) retries after an hour. */
export const AVATAR_RETRY_MS = 60 * 60 * 1000

/** Storage bucket the gateway writes to (migration 055). */
export const CONTACT_AVATARS_BUCKET = 'contact-avatars'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Object path of a contact's stored photo — the same layout the gateway
 * writes (services/wa-gateway/src/media.ts `buildAvatarPath`).
 */
export function contactAvatarPath(accountId: string, contactId: string): string {
  return `account-${accountId}/${contactId.toLowerCase()}`
}

export type AvatarLookup =
  /** Stored copy's public URL. */
  | { kind: 'photo'; url: string }
  /** No photo visible to us (none set, or hidden by privacy settings). */
  | { kind: 'none' }
  /** Could not ask right now — throttled, session offline, network. */
  | { kind: 'unavailable'; reason: string }

export type AvatarRefreshOutcome = 'skipped' | 'photo' | 'none' | 'unavailable'

export type AvatarFetcher = (input: {
  accountId: string
  contactId: string
  phone: string
}) => Promise<AvatarLookup>

function stamp(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? null : t
}

/** Never checked, unreadable, or checked more than a week ago. */
export function isAvatarStale(checkedAt: string | null | undefined, now: number = Date.now()): boolean {
  const t = stamp(checkedAt)
  return t === null || now - t >= AVATAR_REFRESH_MS
}

/** True for URLs of copies we stored (safe to clear when the photo is gone). */
export function isStoredContactAvatar(url: string | null | undefined): boolean {
  return typeof url === 'string' && url.includes(`/${CONTACT_AVATARS_BUCKET}/`)
}

/**
 * The contact columns to write after a lookup.
 *   photo        → new URL, checked now
 *   none         → clear OUR stored copy (privacy / photo removed),
 *                  keep any URL someone set by other means; checked now
 *   unavailable  → checked "a week minus an hour ago", i.e. retry in 1 h
 */
export function avatarPatch(
  lookup: AvatarLookup,
  currentUrl: string | null | undefined,
  now: number = Date.now(),
): { avatar_url?: string | null; avatar_checked_at: string } {
  const checkedNow = new Date(now).toISOString()
  switch (lookup.kind) {
    case 'photo':
      return { avatar_url: lookup.url, avatar_checked_at: checkedNow }
    case 'none':
      return isStoredContactAvatar(currentUrl)
        ? { avatar_url: null, avatar_checked_at: checkedNow }
        : { avatar_checked_at: checkedNow }
    case 'unavailable':
      return {
        avatar_checked_at: new Date(now - AVATAR_REFRESH_MS + AVATAR_RETRY_MS).toISOString(),
      }
  }
}

type Db = Pick<SupabaseClient, 'from'> & Partial<Pick<SupabaseClient, 'storage'>>

/**
 * Claim → lookup → write. Returns what happened; never throws (a photo
 * must never break inbound processing).
 */
export async function refreshContactAvatar(
  db: Db,
  input: { accountId: string; contactId: string; phone: string },
  fetchAvatar: AvatarFetcher,
  now: number = Date.now(),
): Promise<AvatarRefreshOutcome> {
  try {
    const staleBefore = new Date(now - AVATAR_REFRESH_MS).toISOString()
    // Atomic claim: only one caller flips a stale / never-checked row.
    // Anonymised contacts (LGPD) are never enriched again.
    const { data: claimed, error: claimError } = await db
      .from('contacts')
      .update({ avatar_checked_at: new Date(now).toISOString() })
      .eq('id', input.contactId)
      .eq('account_id', input.accountId)
      .is('anonymized_at', null)
      .or(`avatar_checked_at.is.null,avatar_checked_at.lt.${staleBefore}`)
      .select('id, avatar_url')
      .maybeSingle()
    if (claimError) {
      // Pre-055 schema (no column) → silently skip.
      if (!/42703|PGRST|does not exist|schema cache/i.test(`${claimError.code} ${claimError.message}`)) {
        console.error('[avatar] claim failed:', claimError.message)
      }
      return 'skipped'
    }
    if (!claimed) return 'skipped'

    let lookup: AvatarLookup
    try {
      lookup = await fetchAvatar(input)
    } catch (err) {
      lookup = { kind: 'unavailable', reason: err instanceof Error ? err.message : String(err) }
    }

    const patch = avatarPatch(lookup, (claimed as { avatar_url?: string | null }).avatar_url, now)
    // Guarded again: the contact may have been anonymised (LGPD) while
    // the gateway was fetching — never write a photo back onto it.
    const { data: written, error: writeError } = await db
      .from('contacts')
      .update(patch)
      .eq('id', input.contactId)
      .eq('account_id', input.accountId)
      .is('anonymized_at', null)
      .select('id')
    if (writeError) {
      console.error('[avatar] write failed:', writeError.message)
      return 'unavailable'
    }
    if (!written || (written as unknown[]).length === 0) {
      // Anonymised or deleted meanwhile: drop the copy the gateway just stored.
      if (lookup.kind === 'photo') {
        await removeContactAvatarObjects(db, input.accountId, [input.contactId])
      }
      return 'skipped'
    }
    return lookup.kind
  } catch (err) {
    console.error('[avatar] refresh threw:', err)
    return 'unavailable'
  }
}

/**
 * Remove stored photos (service-role client — the bucket has no member
 * write policy). Best effort: returns how many paths were sent, never
 * throws. Used by LGPD anonymisation, contact deletion and the refresh
 * race above.
 */
export async function removeContactAvatarObjects(
  admin: Partial<Pick<SupabaseClient, 'storage'>>,
  accountId: string,
  contactIds: readonly string[],
): Promise<number> {
  const paths = [...new Set(contactIds.filter((id) => UUID_RE.test(id)))].map((id) =>
    contactAvatarPath(accountId, id),
  )
  if (paths.length === 0 || !admin.storage) return 0
  try {
    const { error } = await admin.storage.from(CONTACT_AVATARS_BUCKET).remove(paths)
    if (error) {
      console.error('[avatar] remove failed:', error.message)
      return 0
    }
    return paths.length
  } catch (err) {
    console.error('[avatar] remove threw:', err)
    return 0
  }
}

/** Largest batch the purge route accepts (the contacts page deletes ≤ a page). */
export const AVATAR_PURGE_MAX_IDS = 500

/**
 * After contacts were deleted: remove the stored photos of the ids that
 * no longer exist in the caller's account. `userDb` is the caller's
 * RLS-scoped client (a contact still visible to them is kept), `admin`
 * the service role that can write the bucket. Paths are always under
 * the caller's own `account-<id>/` folder.
 */
export async function purgeDeletedContactAvatars(
  userDb: Pick<SupabaseClient, 'from'>,
  admin: Partial<Pick<SupabaseClient, 'storage'>>,
  accountId: string,
  contactIds: readonly string[],
): Promise<number> {
  const ids = [...new Set(contactIds.filter((id) => typeof id === 'string' && UUID_RE.test(id)))].slice(
    0,
    AVATAR_PURGE_MAX_IDS,
  )
  if (ids.length === 0) return 0
  const { data, error } = await userDb.from('contacts').select('id').in('id', ids)
  if (error) {
    console.error('[avatar] purge lookup failed:', error.message)
    return 0
  }
  const alive = new Set(((data ?? []) as { id: string }[]).map((r) => r.id.toLowerCase()))
  return removeContactAvatarObjects(
    admin,
    accountId,
    ids.filter((id) => !alive.has(id.toLowerCase())),
  )
}
