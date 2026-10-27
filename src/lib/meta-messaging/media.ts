// ============================================================
// Received media: Meta's CDN links expire, so each attachment is copied
// into the `chat-media` bucket (account-scoped, under `meta/`) on arrival.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { STORAGE_PUBLIC_PATH } from '@/lib/storage/media-url'

const BUCKET = 'chat-media'
const MAX_BYTES = 16 * 1024 * 1024
const TIMEOUT_MS = 20_000
// Only Meta's own CDNs: the URL comes from a signed webhook, but never fetch an arbitrary host.
const ALLOWED_HOST = /(^|\.)(fbcdn\.net|cdninstagram\.com|fbsbx\.com|facebook\.com|instagram\.com)$/i

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
  'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'application/pdf': 'pdf',
}

export function isAllowedMetaMediaUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' && !u.username && !u.password && ALLOWED_HOST.test(u.hostname)
  } catch {
    return false
  }
}

/** Public URL as stored in the DB: origin-relative (`/supabase/...`) or absolute, like the browser uploads. */
function storedUrl(path: string): string {
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim().replace(/\/+$/, '')
  return `${base}${STORAGE_PUBLIC_PATH}${BUCKET}/${path}`
}

export interface CopiedMedia {
  url: string
  mimeType: string
}

/**
 * Download `sourceUrl` and store it for `accountId`. Null when the link is not
 * ours to fetch, too big, or the download/upload fails — the caller then keeps
 * the message without the file instead of dropping it.
 */
export async function copyMessagingMedia(
  db: SupabaseClient,
  accountId: string,
  sourceUrl: string,
  nameHint: string,
): Promise<CopiedMedia | null> {
  if (!isAllowedMetaMediaUrl(sourceUrl)) {
    console.warn('[meta-messaging] media host not allowed, skipped')
    return null
  }
  try {
    const res = await fetch(sourceUrl, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' })
    if (!res.ok) return null
    if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) return null
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length === 0 || bytes.length > MAX_BYTES) return null
    const mimeType = (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim()
    const safe = nameHint.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40) || 'media'
    const path = `account-${accountId}/meta/${Date.now()}-${safe}.${EXT[mimeType] ?? 'bin'}`
    const { error } = await db.storage.from(BUCKET).upload(path, bytes, { contentType: mimeType, upsert: false })
    if (error) {
      console.error('[meta-messaging] media upload failed:', error.message)
      return null
    }
    return { url: storedUrl(path), mimeType }
  } catch (err) {
    console.warn('[meta-messaging] media copy failed:', err instanceof Error ? err.message : err)
    return null
  }
}
