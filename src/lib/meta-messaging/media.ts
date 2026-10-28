// ============================================================
// Received media: Meta's CDN links expire, so each attachment is copied
// into the `chat-media` bucket (account-scoped, under `meta/`) on arrival.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { STORAGE_PUBLIC_PATH } from '@/lib/storage/media-url'
import { CONTACT_AVATARS_BUCKET, contactAvatarPath } from '@/lib/whatsapp/contact-avatar'

const BUCKET = 'chat-media'
const MAX_BYTES = 16 * 1024 * 1024
const TIMEOUT_MS = 20_000
// Only Meta's own CDNs: the URL comes from a signed webhook, but never fetch an arbitrary host.
const ALLOWED_HOST = /(^|\.)(fbcdn\.net|cdninstagram\.com|fbsbx\.com|facebook\.com|instagram\.com)$/i

// Extensions for the types we copy. Only types the chat-media bucket accepts (migration 023)
// are listed, so the check is in code, not just the bucket's allowlist.
const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
  'audio/aac': 'aac', 'audio/ogg': 'ogg', 'application/pdf': 'pdf',
}

// contact-avatars (migration 055): 1 MB, jpeg / png / webp.
const AVATAR_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const AVATAR_MAX_BYTES = 1024 * 1024

export function isAllowedMetaMediaUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' && !u.username && !u.password && ALLOWED_HOST.test(u.hostname)
  } catch {
    return false
  }
}

/** Public URL as stored in the DB: origin-relative (`/supabase/...`) or absolute, like the browser uploads. */
function storedUrl(bucket: string, path: string): string {
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim().replace(/\/+$/, '')
  return `${base}${STORAGE_PUBLIC_PATH}${bucket}/${path}`
}

/** Download with a hard byte cap, aborting mid-stream (content-length may be absent or a lie). */
async function download(
  sourceUrl: string,
  maxBytes: number,
  allowed: (mime: string) => boolean,
): Promise<{ bytes: Buffer; mimeType: string } | null> {
  if (!isAllowedMetaMediaUrl(sourceUrl)) {
    console.warn('[meta-messaging] media host not allowed, skipped')
    return null
  }
  const res = await fetch(sourceUrl, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' })
  if (!res.ok || !res.body) return null
  const mimeType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (!allowed(mimeType)) {
    void res.body.cancel()
    return null
  }
  if (Number(res.headers.get('content-length') ?? 0) > maxBytes) {
    void res.body.cancel()
    return null
  }
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return total === 0 ? null : { bytes: Buffer.concat(chunks), mimeType }
}

export interface CopiedMedia {
  url: string
  mimeType: string
}

/**
 * Download `sourceUrl` into the account's `chat-media` folder. Null when the link is
 * not ours to fetch, too big, of a type we do not store, or the copy fails — the
 * caller then keeps the message without the file instead of dropping it.
 */
export async function copyMessagingMedia(
  db: SupabaseClient,
  accountId: string,
  sourceUrl: string,
  nameHint: string,
): Promise<CopiedMedia | null> {
  try {
    const got = await download(sourceUrl, MAX_BYTES, (m) => m in EXT)
    if (!got) return null
    const safe = nameHint.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40) || 'media'
    const path = `account-${accountId}/meta/${Date.now()}-${safe}.${EXT[got.mimeType]}`
    const { error } = await db.storage.from(BUCKET).upload(path, got.bytes, { contentType: got.mimeType, upsert: false })
    if (error) {
      console.error('[meta-messaging] media upload failed:', error.message)
      return null
    }
    return { url: storedUrl(BUCKET, path), mimeType: got.mimeType }
  } catch (err) {
    console.warn('[meta-messaging] media copy failed:', err instanceof Error ? err.name : 'error')
    return null
  }
}

/**
 * Profile photo → `contact-avatars/account-<id>/<contact-id>` (upsert), the layout of the QR
 * channel (migration 055): anonymise / delete already clean it and no external id is in the path.
 * Call after the contact row exists. Returns the URL to store in `contacts.avatar_url`.
 */
export async function storeMessagingAvatar(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  sourceUrl: string,
): Promise<string | null> {
  try {
    const got = await download(sourceUrl, AVATAR_MAX_BYTES, (m) => AVATAR_TYPES.has(m))
    if (!got) return null
    const path = contactAvatarPath(accountId, contactId)
    const { error } = await db.storage
      .from(CONTACT_AVATARS_BUCKET)
      .upload(path, got.bytes, { contentType: got.mimeType, upsert: true, cacheControl: '3600' })
    if (error) {
      console.error('[meta-messaging] avatar upload failed:', error.message)
      return null
    }
    return `${storedUrl(CONTACT_AVATARS_BUCKET, path)}?v=${Date.now()}`
  } catch (err) {
    console.warn('[meta-messaging] avatar copy failed:', err instanceof Error ? err.name : 'error')
    return null
  }
}
