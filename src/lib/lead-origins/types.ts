// ============================================================
// Lead origins (migration 109) — shared types. Pure, safe for client bundles.
// ============================================================

export const ORIGIN_CHANNELS = ['whatsapp', 'whatsapp_qr', 'instagram', 'messenger', 'site_bot', 'webhook'] as const
export type OriginChannel = (typeof ORIGIN_CHANNELS)[number]

export const ORIGIN_KINDS = ['ad', 'post', 'link', 'campaign', 'referrer'] as const
export type OriginKind = (typeof ORIGIN_KINDS)[number]

export const CLICK_ID_TYPES = ['ctwa_clid', 'gclid', 'fbclid'] as const
export type ClickIdType = (typeof CLICK_ID_TYPES)[number]

/** What a channel parser returns: a touch not yet stored. Every field but channel/kind may be null. */
export interface OriginTouch {
  channel: OriginChannel
  kind: OriginKind
  adId: string | null
  sourceId: string | null
  sourceUrl: string | null
  headline: string | null
  utmSource: string | null
  utmMedium: string | null
  utmCampaign: string | null
  utmContent: string | null
  utmTerm: string | null
  referrerHost: string | null
  clickIdType: ClickIdType | null
  /** Server-side only (never selectable by the browser). */
  clickId: string | null
}

/** A stored touch as the browser reads it: no click_id. */
export interface LeadOrigin {
  id: string
  account_id: string
  contact_id: string
  conversation_id: string | null
  channel: OriginChannel
  kind: OriginKind
  ad_id: string | null
  source_id: string | null
  source_url: string | null
  headline: string | null
  utm_source: string | null
  utm_medium: string | null
  utm_campaign: string | null
  utm_content: string | null
  utm_term: string | null
  referrer_host: string | null
  click_id_type: ClickIdType | null
  occurred_at: string
  created_at: string
}

/** Columns the browser may select (click_id is not granted to authenticated). */
export const LEAD_ORIGIN_COLUMNS =
  'id, account_id, contact_id, conversation_id, channel, kind, ad_id, source_id, source_url, headline, utm_source, utm_medium, utm_campaign, utm_content, utm_term, referrer_host, click_id_type, occurred_at, created_at'

/** One row of origin_report(). */
export interface OriginReportRow {
  origin_type: 'ad' | 'campaign' | 'referrer' | 'direct'
  /** '' for the direct bucket. */
  channel: OriginChannel | ''
  name: string
  /** utm_source of a campaign, '' otherwise. */
  source: string
  customers: number
  deals_created: number
  deals_won: number
  won_value: number
  conversion_pct: number
  avg_ticket: number
}
