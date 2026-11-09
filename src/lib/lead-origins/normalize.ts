// ============================================================
// Touch normalizer: every text is clamped to the migration-109 CHECK limits, control characters
// are dropped and blanks become null. Pure. Anything outside the contract becomes null, never an
// error (a bad ad payload must not break message ingestion).
// ============================================================

import {
  CLICK_ID_TYPES,
  ORIGIN_CHANNELS,
  ORIGIN_KINDS,
  type ClickIdType,
  type OriginChannel,
  type OriginKind,
  type OriginTouch,
} from './types'

/** Same numbers as the lead_origins_text_len_check constraint. */
export const ORIGIN_LIMITS = {
  adId: 120,
  sourceId: 200,
  sourceUrl: 1000,
  headline: 300,
  utmShort: 120,
  utmLong: 200,
  host: 253,
  clickId: 600,
} as const

const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/gu

/** Text of a payload value: strings, finite numbers and bigints only; trimmed, no control chars, clamped. */
export function clip(value: unknown, max: number): string | null {
  let s: string
  if (typeof value === 'string') s = value
  else if (typeof value === 'number' && Number.isFinite(value)) s = String(value)
  else if (typeof value === 'bigint') s = value.toString()
  else return null
  s = s.replace(CONTROL, ' ').trim()
  if (!s) return null
  return s.length > max ? s.slice(0, max).trimEnd() : s
}

/** http(s) URL only (the value becomes a link in the app: never javascript: or data:). */
export function safeHttpUrl(value: unknown, max: number = ORIGIN_LIMITS.sourceUrl): string | null {
  const s = clip(value, 4000)
  if (!s) return null
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  } catch {
    return null
  }
  return s.length <= max ? s : null
}

const META_HOSTS = ['fb.me', 'fb.com', 'facebook.com', 'instagram.com', 'wa.me']

/** http(s) URL whose host is a Meta one (the sender of a QR message writes the link, so nothing else is kept). */
export function metaHostUrl(value: unknown, max: number = ORIGIN_LIMITS.sourceUrl): string | null {
  const url = safeHttpUrl(value, max)
  if (!url) return null
  const host = new URL(url).hostname.toLowerCase()
  return META_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) ? url : null
}

const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/

/** Lower-case hostname, no www., or null. */
export function cleanHost(value: unknown): string | null {
  const s = clip(value, ORIGIN_LIMITS.host + 10)
  if (!s) return null
  const host = s.toLowerCase().replace(/^www\./, '')
  return host.length <= ORIGIN_LIMITS.host && HOST.test(host) ? host : null
}

export type TouchInput = Partial<Record<keyof OriginTouch, unknown>>

/**
 * Validated, clamped touch, or null when the channel / kind is unknown or the touch carries
 * nothing that identifies where the customer came from.
 */
export function normalizeTouch(raw: TouchInput | null | undefined): OriginTouch | null {
  if (!raw || typeof raw !== 'object') return null
  const channel = ORIGIN_CHANNELS.includes(raw.channel as OriginChannel) ? (raw.channel as OriginChannel) : null
  const kind = ORIGIN_KINDS.includes(raw.kind as OriginKind) ? (raw.kind as OriginKind) : null
  if (!channel || !kind) return null

  const clickId = clip(raw.clickId, ORIGIN_LIMITS.clickId)
  const clickIdType = CLICK_ID_TYPES.includes(raw.clickIdType as ClickIdType) ? (raw.clickIdType as ClickIdType) : null
  const touch: OriginTouch = {
    channel,
    kind,
    adId: clip(raw.adId, ORIGIN_LIMITS.adId),
    sourceId: clip(raw.sourceId, ORIGIN_LIMITS.sourceId),
    sourceUrl: safeHttpUrl(raw.sourceUrl),
    headline: clip(raw.headline, ORIGIN_LIMITS.headline),
    utmSource: clip(raw.utmSource, ORIGIN_LIMITS.utmShort),
    utmMedium: clip(raw.utmMedium, ORIGIN_LIMITS.utmShort),
    utmCampaign: clip(raw.utmCampaign, ORIGIN_LIMITS.utmLong),
    utmContent: clip(raw.utmContent, ORIGIN_LIMITS.utmLong),
    utmTerm: clip(raw.utmTerm, ORIGIN_LIMITS.utmLong),
    referrerHost: cleanHost(raw.referrerHost),
    // The two travel together (DB check): a click id without a known type is dropped.
    clickIdType: clickId && clickIdType ? clickIdType : null,
    clickId: clickId && clickIdType ? clickId : null,
  }
  const identifies =
    touch.adId || touch.sourceId || touch.sourceUrl || touch.headline || touch.utmSource || touch.utmMedium ||
    touch.utmCampaign || touch.utmContent || touch.utmTerm || touch.referrerHost || touch.clickId
  return identifies ? touch : null
}
