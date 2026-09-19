// ============================================================
// Server side of push notifications (spec round 2 §5).
//
//   sendPushToUsers(admin, userIds, payload)
//     Loads every `push_subscriptions` row of the given users, sends
//     the payload through web-push (VAPID from env) and deletes the
//     rows whose endpoint answered 404 / 410 (browser unsubscribed or
//     the subscription expired). Never throws; returns counts.
//
// The module is server-only (web-push needs Node's crypto) and reads
// the VAPID keys lazily so importing it in a route without the env
// (tests, forks without push) is harmless — `isPushConfigured()` is
// false and every send is a silent no-op.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import webpush, { WebPushError, type PushSubscription as WebPushSubscription } from 'web-push'

import { mediaUrlForPublic } from '@/lib/storage/media-url'

export interface PushPayload {
  title: string
  body: string
  /** Absolute path the notification click opens (e.g. `/inbox?c=<id>`). */
  url: string
  /** Notifications with the same tag collapse into one. */
  tag?: string
  /** Icon URL; defaults to the app icon in sw.js. */
  icon?: string
}

export interface PushSubscriptionRow {
  id: string
  user_id: string
  endpoint: string
  p256dh: string
  auth: string
}

export interface SendPushResult {
  /** Recipients with at least one subscription. */
  users: number
  sent: number
  failed: number
  /** Subscriptions deleted because the endpoint is gone (404 / 410). */
  removed: number
  /** False when VAPID is not configured (nothing was attempted). */
  configured: boolean
}

const EMPTY: SendPushResult = { users: 0, sent: 0, failed: 0, removed: 0, configured: true }

/** Max characters of body we ship — notifications truncate anyway. */
export const PUSH_BODY_MAX = 160

let vapidReady = false

export interface VapidConfig {
  publicKey: string
  privateKey: string
  subject: string
}

export function readVapidConfig(env: NodeJS.ProcessEnv = process.env): VapidConfig | null {
  const publicKey = env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim()
  const privateKey = env.VAPID_PRIVATE_KEY?.trim()
  const subject = env.VAPID_SUBJECT?.trim()
  if (!publicKey || !privateKey || !subject) return null
  if (!/^(mailto:|https:\/\/)/.test(subject)) return null
  return { publicKey, privateKey, subject }
}

export function isPushConfigured(): boolean {
  return readVapidConfig() !== null
}

function ensureVapid(): boolean {
  if (vapidReady) return true
  const cfg = readVapidConfig()
  if (!cfg) return false
  webpush.setVapidDetails(cfg.subject, cfg.publicKey, cfg.privateKey)
  vapidReady = true
  return true
}

/** Clamp a free-text body to one notification line. */
export function truncateBody(text: string | null | undefined, max: number = PUSH_BODY_MAX): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  return t.slice(0, max - 1).trimEnd() + '…'
}

/** The JSON the service worker receives (see public/sw.js). */
export function buildPushMessage(payload: PushPayload): string {
  return JSON.stringify({
    title: payload.title,
    body: truncateBody(payload.body),
    // The service worker shows the icon outside any page, so a stored
    // origin-relative avatar/logo must be absolutised here.
    ...(payload.icon ? { icon: mediaUrlForPublic(payload.icon) } : {}),
    ...(payload.tag ? { tag: payload.tag } : {}),
    data: { url: payload.url },
  })
}

export function toWebPushSubscription(row: PushSubscriptionRow): WebPushSubscription {
  return { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }
}

/** 404 / 410 mean the subscription is gone for good. */
export function isGoneError(err: unknown): boolean {
  if (err instanceof WebPushError) return err.statusCode === 404 || err.statusCode === 410
  const code = (err as { statusCode?: unknown } | null)?.statusCode
  return code === 404 || code === 410
}

export async function sendPushToUsers(
  admin: SupabaseClient,
  userIds: readonly string[],
  payload: PushPayload,
  delivery?: {
    /** Durable receipts let a caller retry only unsuccessful subscriptions. */
    excludeSubscriptionIds: readonly string[]
    onDelivered: (subscriptionId: string) => Promise<void>
  },
): Promise<SendPushResult> {
  const ids = Array.from(new Set(userIds.filter(Boolean)))
  if (ids.length === 0) return { ...EMPTY }
  if (!ensureVapid()) return { ...EMPTY, configured: false }

  const { data, error } = await admin
    .from('push_subscriptions')
    .select('id, user_id, endpoint, p256dh, auth')
    .in('user_id', ids)
  if (error) {
    console.error('[push] failed to load subscriptions:', error.message)
    return { ...EMPTY, failed: 1 }
  }
  const excluded = new Set(delivery?.excludeSubscriptionIds ?? [])
  const rows = ((data ?? []) as PushSubscriptionRow[]).filter((row) => !excluded.has(row.id))
  if (rows.length === 0) return { ...EMPTY }

  const message = buildPushMessage(payload)
  const gone: string[] = []
  const ok: string[] = []
  let failed = 0

  await Promise.all(
    rows.map(async (row) => {
      try {
        await webpush.sendNotification(toWebPushSubscription(row), message, { TTL: 60 * 60, timeout: 10_000 })
        await delivery?.onDelivered(row.id)
        ok.push(row.id)
      } catch (err) {
        if (isGoneError(err)) {
          gone.push(row.id)
        } else {
          failed++
          const status = (err as { statusCode?: number } | null)?.statusCode
          console.error('[push] send failed:', status ?? '', err instanceof Error ? err.message : err)
        }
      }
    }),
  )

  if (gone.length > 0) {
    const { error: delErr } = await admin.from('push_subscriptions').delete().in('id', gone)
    if (delErr) console.error('[push] failed to prune dead subscriptions:', delErr.message)
  }
  if (ok.length > 0) {
    const { error: updErr } = await admin
      .from('push_subscriptions')
      .update({ last_used_at: new Date().toISOString() })
      .in('id', ok)
    if (updErr) console.error('[push] failed to stamp last_used_at:', updErr.message)
  }

  return {
    users: new Set(rows.map((r) => r.user_id)).size,
    sent: ok.length,
    failed,
    removed: gone.length,
    configured: true,
  }
}

/** Tests only — forget the cached VAPID setup. */
export function _resetVapidForTests(): void {
  vapidReady = false
}
