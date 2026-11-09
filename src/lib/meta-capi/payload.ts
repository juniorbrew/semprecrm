// Pure builders of the Meta Conversions API events (server only: node:crypto). No I/O, no clock.
// Field names checked against the official docs on 2026-11-09:
//   business messaging  https://developers.facebook.com/docs/marketing-api/conversions-api/business-messaging
//   server event params https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/server-event
//   fbc format          https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/fbp-and-fbc
// Never built into an event: name, message text, notes, custom fields, IP.
import { createHash } from 'node:crypto'

/** The one place the Graph API version lives (v27.0 is current in the docs). */
export const META_GRAPH_VERSION = 'v27.0'
export const META_PARTNER_AGENT = 'SempreCRM'

export type CapiKind = 'lead' | 'purchase'

/** What the claim RPC (migration 110) returns for one leased event. */
export interface ClaimedEvent {
  id: string
  account_id: string
  deal_id: string
  event_name: CapiKind
  event_id: string
  attempts: number
  occurred_at: string
  value: number | string | null
  currency: string | null
  dataset_id: string
  token_enc: string
  test_event_code: string | null
  contact_id: string | null
  contact_phone: string | null
  contact_email: string | null
  contact_instagram_id: string | null
  contact_messenger_id: string | null
  contact_anonymized: boolean | null
  origin_channel: string | null
  origin_kind: string | null
  origin_click_id_type: string | null
  origin_click_id: string | null
  origin_occurred_at: string | null
  waba_id: string | null
  channel_external_id: string | null
}

export interface CapiOrigin {
  channel: string | null
  kind: string | null
  click_id_type: string | null
}

/** Same rule as the SQL trigger (meta_capi_enqueue): only a touch Meta can recognise. */
export function isMetaEligibleOrigin(o: CapiOrigin): boolean {
  if (o.channel === 'whatsapp') return o.click_id_type === 'ctwa_clid'
  if (o.channel === 'instagram' || o.channel === 'messenger') return o.kind === 'ad'
  if (o.channel === 'site_bot' || o.channel === 'webhook') return o.click_id_type === 'fbclid'
  return false
}

export const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

/** Digits with country code. A bare 10/11-digit Brazilian number gets 55 (the product's market). */
export function normalizePhone(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '')
  if (digits.length < 8) return null
  return digits.length === 10 || digits.length === 11 ? `55${digits}` : digits
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  const e = (raw ?? '').trim().toLowerCase()
  return e.includes('@') ? e : null
}

/** `fb.1.<ms>.<fbclid>`: subdomain index 1 and the time the fbclid was first observed (the touch). */
export function buildFbc(fbclid: string, observedAt: string | Date): string {
  return `fb.1.${new Date(observedAt).getTime()}.${fbclid}`
}

export type BuildResult = { ok: true; event: Record<string, unknown> } | { ok: false; reason: string }

const MESSAGING_CHANNELS = new Set(['whatsapp', 'instagram', 'messenger'])

/** Builds one Meta event from a claimed row, or says why it can never be sent (the row is then cancelled). */
export function buildCapiEvent(row: ClaimedEvent): BuildResult {
  if (!row.contact_id) return { ok: false, reason: 'O cliente foi apagado' }
  if (row.contact_anonymized) return { ok: false, reason: 'O cliente foi anonimizado' }
  const origin: CapiOrigin = { channel: row.origin_channel, kind: row.origin_kind, click_id_type: row.origin_click_id_type }
  if (!row.origin_channel || !isMetaEligibleOrigin(origin)) return { ok: false, reason: 'O negócio não veio de anúncio da Meta' }

  const eventTime = Math.floor(new Date(row.occurred_at).getTime() / 1000)
  if (!Number.isFinite(eventTime)) return { ok: false, reason: 'Data do evento inválida' }
  const messaging = MESSAGING_CHANNELS.has(row.origin_channel)

  const base: Record<string, unknown> = {
    event_name: messaging ? (row.event_name === 'lead' ? 'LeadSubmitted' : 'Purchase') : row.event_name === 'lead' ? 'Lead' : 'Purchase',
    event_time: eventTime,
    event_id: row.event_id,
  }
  if (row.event_name === 'purchase') {
    const value = Number(row.value ?? 0)
    base.custom_data = { value: Number.isFinite(value) ? value : 0, currency: row.currency ?? 'BRL' }
  }

  if (messaging) {
    base.action_source = 'business_messaging'
    base.messaging_channel = row.origin_channel
    if (row.origin_channel === 'whatsapp') {
      if (!row.origin_click_id || !row.waba_id) return { ok: false, reason: 'Falta o código do anúncio ou a conta do WhatsApp' }
      base.user_data = { whatsapp_business_account_id: row.waba_id, ctwa_clid: row.origin_click_id }
    } else if (row.origin_channel === 'messenger') {
      if (!row.channel_external_id || !row.contact_messenger_id) return { ok: false, reason: 'Falta a página ou o usuário do Messenger' }
      base.user_data = { page_id: row.channel_external_id, page_scoped_user_id: row.contact_messenger_id }
    } else {
      if (!row.channel_external_id || !row.contact_instagram_id) return { ok: false, reason: 'Falta a conta ou o usuário do Instagram' }
      base.user_data = { instagram_business_account_id: row.channel_external_id, ig_sid: row.contact_instagram_id }
    }
    return { ok: true, event: base }
  }

  // site_bot / webhook with fbclid: a CRM event, matched by fbc + hashed phone / e-mail.
  if (!row.origin_click_id || !row.origin_occurred_at) return { ok: false, reason: 'Falta o código do clique (fbclid)' }
  const phone = normalizePhone(row.contact_phone)
  const email = normalizeEmail(row.contact_email)
  const user_data: Record<string, unknown> = { fbc: buildFbc(row.origin_click_id, row.origin_occurred_at) }
  if (phone) user_data.ph = [sha256(phone)]
  if (email) user_data.em = [sha256(email)]
  base.action_source = 'system_generated'
  base.user_data = user_data
  return { ok: true, event: base }
}

/** The request body: `test_event_code` sits next to `data`. */
export function buildRequestBody(events: Record<string, unknown>[], testEventCode?: string | null): Record<string, unknown> {
  const body: Record<string, unknown> = { data: events, partner_agent: META_PARTNER_AGENT }
  if (testEventCode) body.test_event_code = testEventCode
  return body
}

/** A synthetic event for the "Enviar evento de teste" button. The route requires a test_event_code so real data stays clean. */
export function buildTestEvent(now: Date): Record<string, unknown> {
  const t = now.getTime()
  return {
    event_name: 'Lead',
    event_time: Math.floor(t / 1000),
    event_id: `sempre-test-${t}`,
    action_source: 'system_generated',
    user_data: { fbc: buildFbc('sempre-teste', now), em: [sha256('teste@example.com')] },
  }
}
