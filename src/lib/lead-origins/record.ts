// ============================================================
// recordTouch — server only (service-role client). Stores one touch and moves the contact's
// pointers (first only when empty, last always). Never throws and never logs personal data:
// recording an origin must not break or delay message ingestion.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { normalizeTouch } from './normalize'
import type { OriginTouch } from './types'

/** Same ad / source / campaign in the same conversation inside this window is the same touch. */
export const TOUCH_DEDUP_MS = 24 * 60 * 60 * 1000
/** Ingestion never waits longer than this for an origin. */
export const RECORD_TIMEOUT_MS = 3000

export interface RecordTouchInput {
  accountId: string
  contactId: string
  conversationId?: string | null
  touch: OriginTouch | null | undefined
  /** Defaults to now. */
  at?: Date
}

export interface RecordTouchResult {
  recorded: boolean
  originId?: string
}

/** What makes two touches "the same one" (channel + what identifies the ad / source / campaign). */
export function touchIdentity(t: {
  channel: string
  kind: string
  adId: string | null
  sourceId: string | null
  utmSource: string | null
  utmCampaign: string | null
  utmContent: string | null
  referrerHost: string | null
}): string {
  return [t.channel, t.kind, t.adId, t.sourceId, t.utmSource, t.utmCampaign, t.utmContent, t.referrerHost]
    .map((v) => v ?? '')
    .join('|')
}

interface RecentRow {
  channel: string
  kind: string
  ad_id: string | null
  source_id: string | null
  utm_source: string | null
  utm_campaign: string | null
  utm_content: string | null
  referrer_host: string | null
  conversation_id: string | null
}

/** True when `recent` already holds this touch for this conversation (null conversation matches null). */
export function isDuplicateTouch(touch: OriginTouch, conversationId: string | null, recent: RecentRow[]): boolean {
  const id = touchIdentity(touch)
  return recent.some(
    (r) =>
      (r.conversation_id ?? null) === conversationId &&
      touchIdentity({
        channel: r.channel,
        kind: r.kind,
        adId: r.ad_id,
        sourceId: r.source_id,
        utmSource: r.utm_source,
        utmCampaign: r.utm_campaign,
        utmContent: r.utm_content,
        referrerHost: r.referrer_host,
      }) === id,
  )
}

async function record(db: SupabaseClient, input: RecordTouchInput): Promise<RecordTouchResult> {
  const touch = normalizeTouch(input.touch)
  if (!touch) return { recorded: false }
  const at = input.at ?? new Date()
  const conversationId = input.conversationId ?? null

  const since = new Date(at.getTime() - TOUCH_DEDUP_MS).toISOString()
  const { data: recent, error: recentErr } = await db
    .from('lead_origins')
    .select('channel, kind, ad_id, source_id, utm_source, utm_campaign, utm_content, referrer_host, conversation_id')
    .eq('account_id', input.accountId)
    .eq('contact_id', input.contactId)
    .gte('occurred_at', since)
    .limit(50)
  if (recentErr) throw new Error(`recent lookup failed (${recentErr.code ?? 'error'})`)
  if (isDuplicateTouch(touch, conversationId, (recent ?? []) as RecentRow[])) return { recorded: false }

  const { data, error } = await db
    .from('lead_origins')
    .insert({
      account_id: input.accountId,
      contact_id: input.contactId,
      conversation_id: conversationId,
      channel: touch.channel,
      kind: touch.kind,
      ad_id: touch.adId,
      source_id: touch.sourceId,
      source_url: touch.sourceUrl,
      headline: touch.headline,
      utm_source: touch.utmSource,
      utm_medium: touch.utmMedium,
      utm_campaign: touch.utmCampaign,
      utm_content: touch.utmContent,
      utm_term: touch.utmTerm,
      referrer_host: touch.referrerHost,
      click_id_type: touch.clickIdType,
      click_id: touch.clickId,
      occurred_at: at.toISOString(),
    })
    .select('id')
    .single()
  if (error || !data) throw new Error(`insert failed (${error?.code ?? 'no row'})`)
  const originId = (data as { id: string }).id

  // First touch only when the contact has none; last touch always.
  const first = await db
    .from('contacts')
    .update({ first_origin_id: originId })
    .eq('id', input.contactId)
    .eq('account_id', input.accountId)
    .is('first_origin_id', null)
  if (first.error) throw new Error(`first pointer failed (${first.error.code ?? 'error'})`)
  const last = await db
    .from('contacts')
    .update({ last_origin_id: originId })
    .eq('id', input.contactId)
    .eq('account_id', input.accountId)
  if (last.error) throw new Error(`last pointer failed (${last.error.code ?? 'error'})`)
  return { recorded: true, originId }
}

/** Stores a touch; any failure (or a slow database) is logged without personal data and swallowed. */
export async function recordTouch(db: SupabaseClient, input: RecordTouchInput): Promise<RecordTouchResult> {
  if (!input.touch) return { recorded: false }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      record(db, input),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), RECORD_TIMEOUT_MS)
      }),
    ])
  } catch (err) {
    console.error('[lead-origins] record failed:', err instanceof Error ? err.message : 'unknown')
    return { recorded: false }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
