// ============================================================
// recordTouch — server only (service-role client). One rpc call to record_lead_origin (migration
// 109): lock, 24h dedup, 50-per-day cap, insert and pointers happen in ONE statement, so a slow or
// killed request never leaves a touch without its pointers. Never throws and never logs personal
// data: recording an origin must not break or delay message ingestion.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { normalizeTouch } from './normalize'
import type { OriginTouch } from './types'

/** Ingestion never waits longer than this for an origin. */
export const RECORD_TIMEOUT_MS = 3000

export interface RecordTouchInput {
  accountId: string
  contactId: string
  conversationId?: string | null
  touch: OriginTouch | null | undefined
  /** Defaults to now. */
  at?: Date
  /**
   * May this touch become the contact's FIRST touch (when it has none)? Messaging channels: yes (default).
   * Site bot / forms: only when this same submission created the contact, so a stranger who types a known
   * number cannot claim the first touch of an existing customer.
   */
  allowFirst?: boolean
}

export interface RecordTouchResult {
  recorded: boolean
  originId?: string
}

async function record(db: SupabaseClient, input: RecordTouchInput): Promise<RecordTouchResult> {
  const touch = normalizeTouch(input.touch)
  if (!touch) return { recorded: false }
  const { data, error } = await db.rpc('record_lead_origin', {
    p_account_id: input.accountId,
    p_contact_id: input.contactId,
    p_conversation_id: input.conversationId ?? null,
    p_channel: touch.channel,
    p_kind: touch.kind,
    p_ad_id: touch.adId,
    p_source_id: touch.sourceId,
    p_source_url: touch.sourceUrl,
    p_headline: touch.headline,
    p_utm_source: touch.utmSource,
    p_utm_medium: touch.utmMedium,
    p_utm_campaign: touch.utmCampaign,
    p_utm_content: touch.utmContent,
    p_utm_term: touch.utmTerm,
    p_referrer_host: touch.referrerHost,
    p_click_id_type: touch.clickIdType,
    p_click_id: touch.clickId,
    p_occurred_at: (input.at ?? new Date()).toISOString(),
    p_allow_first: input.allowFirst ?? true,
  })
  if (error) throw new Error(`record_lead_origin failed (${error.code ?? 'error'})`)
  // NULL: a repeat inside 24h, or the 50-a-day cap: nothing was written.
  return typeof data === 'string' ? { recorded: true, originId: data } : { recorded: false }
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
    // Only our own messages (error code, timeout) are logged: whatever else was thrown may carry payload text.
    const ours = err instanceof Error && (err.message === 'timeout' || err.message.startsWith('record_lead_origin failed'))
    console.error('[lead-origins] record failed:', ours ? (err as Error).message : 'unexpected error')
    return { recorded: false }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
