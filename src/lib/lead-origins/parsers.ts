// ============================================================
// Channel parsers: raw provider payload -> OriginTouch | null. Pure and total: wrong types,
// missing fields and giant strings give null or clamped text, never an exception.
//
// Field names, per the provider docs:
//  - WhatsApp Cloud API `messages[].referral` (Click-to-WhatsApp ads): source_url, source_id,
//    source_type ("ad" | "post"), headline, body, media_type, image_url, video_url, ctwa_clid.
//  - Baileys `contextInfo.externalAdReply` (title, body, sourceType, sourceId, sourceUrl,
//    ctwaClid, sourceApp) and `contextInfo.conversionSource`; the gateway forwards them as
//    `ad` (services/wa-gateway InboundAd), best effort.
//  - Instagram / Messenger `messaging[].referral`: source ("ADS" | "SHORTLINK" | ...), type,
//    ref, ad_id, ads_context_data { ad_title, photo_url, video_url, post_id, product_id }.
//  - Site: the page URL (utm_source / utm_medium / utm_campaign / utm_content / utm_term,
//    gclid, fbclid) and document.referrer (only its host is kept).
// ============================================================

import { cleanHost, clip, metaHostUrl, normalizeTouch, ORIGIN_LIMITS, safeHttpUrl } from './normalize'
import type { ClickIdType, OriginChannel, OriginKind, OriginTouch } from './types'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

const BLANK: Omit<OriginTouch, 'channel' | 'kind'> = {
  adId: null,
  sourceId: null,
  sourceUrl: null,
  headline: null,
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
  utmContent: null,
  utmTerm: null,
  referrerHost: null,
  clickIdType: null,
  clickId: null,
}

function build(channel: OriginChannel, kind: OriginKind, fields: Partial<OriginTouch>): OriginTouch | null {
  return normalizeTouch({ ...BLANK, ...fields, channel, kind })
}

const adKind = (t: unknown): OriginKind | null => {
  const s = typeof t === 'string' ? t.trim().toLowerCase() : ''
  return s === 'ad' ? 'ad' : s === 'post' ? 'post' : null
}

/** WhatsApp Cloud API `referral` of the message that opens a Click-to-WhatsApp conversation. */
export function parseWhatsAppReferral(referral: unknown): OriginTouch | null {
  if (!isObj(referral)) return null
  const kind = adKind(referral.source_type) ?? 'link'
  const sourceId = clip(referral.source_id, ORIGIN_LIMITS.sourceId)
  const ctwa = clip(referral.ctwa_clid, ORIGIN_LIMITS.clickId)
  return build('whatsapp', kind, {
    adId: kind === 'ad' ? sourceId : null,
    sourceId,
    sourceUrl: safeHttpUrl(referral.source_url),
    headline: clip(referral.headline, ORIGIN_LIMITS.headline),
    clickIdType: ctwa ? 'ctwa_clid' : null,
    clickId: ctwa,
  })
}

/** What Baileys calls the conversion source of a real Click-to-WhatsApp ad ("FB_Ads", "ads"); "broadcast" and the like are not. */
const AD_CONVERSION = /^(fb_)?ads?$/i

/**
 * The gateway's `ad` object (Baileys externalAdReply + conversionSource), QR channel. Everything in it is
 * written by the sender, so: the link is kept only when it points at a Meta host, and the click id is never
 * stored (the sender can put anything there and part B cannot trust it).
 */
export function parseBaileysAd(ad: unknown): OriginTouch | null {
  if (!isObj(ad)) return null
  const conversion = clip(ad.conversion_source, 120)
  const sourceUrl = metaHostUrl(ad.source_url)
  const kind = adKind(ad.source_type) ?? (conversion && AD_CONVERSION.test(conversion) ? 'ad' : null) ?? (sourceUrl ? 'link' : null)
  if (!kind) return null
  const sourceId = clip(ad.source_id, ORIGIN_LIMITS.sourceId)
  return build('whatsapp_qr', kind, {
    adId: kind === 'ad' ? sourceId : null,
    sourceId,
    sourceUrl,
    headline: clip(ad.title, ORIGIN_LIMITS.headline),
  })
}

/** Instagram / Messenger `referral` (click-to-Direct / click-to-Messenger ads, m.me / ig.me links). */
export function parseMessagingReferral(referral: unknown, channel: 'instagram' | 'messenger'): OriginTouch | null {
  if (!isObj(referral)) return null
  const ctx = isObj(referral.ads_context_data) ? referral.ads_context_data : {}
  const adId = clip(referral.ad_id, ORIGIN_LIMITS.adId)
  const postId = clip(ctx.post_id, ORIGIN_LIMITS.sourceId)
  const ref = clip(referral.ref, ORIGIN_LIMITS.sourceId)
  const title = clip(ctx.ad_title, ORIGIN_LIMITS.headline)
  const source = typeof referral.source === 'string' ? referral.source.trim().toUpperCase() : ''
  const isAd = source === 'ADS' || !!adId || !!title
  if (isAd) {
    return build(channel, 'ad', { adId, sourceId: postId ?? ref, headline: title })
  }
  // m.me / ig.me link with ?ref=: the ref is the customer's own campaign key.
  return build(channel, 'link', { sourceId: ref ?? postId })
}

const CAMPAIGN_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const

/** Page URL without credentials, fragment and every parameter that is not a utm_* one (click ids stay out). */
function cleanPageUrl(u: URL): string | null {
  const keep = new URLSearchParams()
  for (const k of CAMPAIGN_PARAMS) {
    const v = u.searchParams.get(k)
    if (v) keep.set(k, v.slice(0, ORIGIN_LIMITS.utmLong))
  }
  const qs = keep.toString()
  return safeHttpUrl(`${u.origin}${u.pathname}${qs ? `?${qs}` : ''}`)
}

function parseHttpUrl(value: unknown): URL | null {
  const s = clip(value, 4000)
  if (!s) return null
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null
  } catch {
    return null
  }
}

/** Host of a referrer: a full URL, or the bare host[:port] robo.js sends (it never sends the path or query). */
function referrerHostOf(value: unknown): string | null {
  const url = parseHttpUrl(value)
  if (url) return cleanHost(url.hostname)
  const s = clip(value, 300)
  if (!s || !/^[a-z0-9.-]+(:\d{1,5})?$/i.test(s)) return null
  try {
    return cleanHost(new URL(`https://${s}`).hostname)
  } catch {
    return null
  }
}

/**
 * Site visitor (bot) or form: utm_* / gclid / fbclid from the page URL, the host of the referrer.
 * `extra` carries the same keys sent explicitly (webhook body) and wins over the URL. Null when
 * nothing identifies the visit: a direct visit stays "direct", nothing is recorded.
 */
export function parseUrlOrigin(
  pageUrl: unknown,
  referrer: unknown,
  channel: 'site_bot' | 'webhook',
  extra: Obj = {},
): OriginTouch | null {
  const page = parseHttpUrl(pageUrl)
  const param = (k: string) => clip(extra[k], ORIGIN_LIMITS.utmLong) ?? clip(page?.searchParams.get(k), ORIGIN_LIMITS.utmLong)
  const gclid = param('gclid')
  const fbclid = param('fbclid')
  const clickIdType: ClickIdType | null = gclid ? 'gclid' : fbclid ? 'fbclid' : null
  let referrerHost = referrerHostOf(referrer)
  if (referrerHost && page && referrerHost === cleanHost(page.hostname)) referrerHost = null // same-site navigation
  const utm = Object.fromEntries(CAMPAIGN_PARAMS.map((k) => [k, param(k)])) as Record<(typeof CAMPAIGN_PARAMS)[number], string | null>
  const hasCampaign = Object.values(utm).some(Boolean) || !!clickIdType
  if (!hasCampaign && !referrerHost) return null
  return build(channel, hasCampaign ? 'campaign' : 'referrer', {
    sourceUrl: page ? cleanPageUrl(page) : null,
    utmSource: utm.utm_source,
    utmMedium: utm.utm_medium,
    utmCampaign: utm.utm_campaign,
    utmContent: utm.utm_content,
    utmTerm: utm.utm_term,
    referrerHost,
    clickIdType,
    clickId: gclid ?? fbclid,
  })
}

/**
 * Webhook form body: utm_*, gclid, fbclid, page_url / referrer (or referer) when the form sends them.
 * `url` is NOT read: forms often send the lead's own website under that name.
 */
export function parseBodyOrigin(payload: unknown): OriginTouch | null {
  if (!isObj(payload)) return null
  return parseUrlOrigin(payload.page_url, payload.referrer ?? payload.referer, 'webhook', payload)
}
