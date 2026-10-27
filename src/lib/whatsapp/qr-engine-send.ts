// ============================================================
// Engine-side QR sends (automations + flows).
//
// The two Meta senders (`automations/meta-send.ts`, `flows/meta-send.ts`)
// call `conversationChannel` first and, for a `qr` conversation, hand
// off here. The gateway only speaks text + media, so:
//   - templates      → the template body rendered as plain text
//   - buttons / list → body + a numbered option list
// which is what the spec asks for ("interativos não existem no QR:
// o fluxo/automação que os usar cai para texto simples").
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import type { ConversationChannel, WhatsAppChannel } from '@/types'
import { sanitizePhoneForMeta, isValidE164 } from './phone-utils'
import {
  BULK_MAX_WAIT_MS,
  GatewayRequestError,
  sendViaGateway,
  type GatewayMedia,
  type GatewaySendPriority,
} from './qr-gateway'
import { remainingBulkSendBudgetMs } from './send-budget'
import { accountMediaUrlForServer } from '@/lib/storage/media-url'
import { isUniqueViolation } from '@/lib/contacts/dedupe'
import { claimEchoedRow } from './phone-echo'

/** `official` for rows that predate migration 026 or can't be read. */
export async function conversationChannel(
  db: SupabaseClient,
  conversationId: string,
): Promise<ConversationChannel> {
  const { data, error } = await db
    .from('conversations')
    .select('channel')
    .eq('id', conversationId)
    .maybeSingle()
  if (error || !data) return 'official'
  const channel = data.channel
  return channel === 'qr' || channel === 'instagram' || channel === 'messenger' ? channel : 'official'
}

/**
 * Engine senders run on the service role, and the conversation id can
 * come from caller-supplied automation context — refuse to write into a
 * conversation that is not this account's AND this contact's.
 */
export async function assertConversationOwned(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  conversationId: string,
): Promise<void> {
  const { data, error } = await db
    .from('conversations')
    .select('id')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .maybeSingle()
  if (error || !data) throw new Error('conversation not found for this account/contact')
}

export interface InteractiveAsTextInput {
  bodyText: string
  options: string[]
  headerText?: string
  footerText?: string
}

/**
 * Render a button / list prompt as text the customer can answer by
 * typing the number. Header and footer keep their place.
 */
export function renderInteractiveAsText(input: InteractiveAsTextInput): string {
  const parts: string[] = []
  if (input.headerText?.trim()) parts.push(`*${input.headerText.trim()}*`)
  parts.push(input.bodyText)
  if (input.options.length > 0) {
    parts.push(input.options.map((label, i) => `${i + 1}. ${label}`).join('\n'))
  }
  if (input.footerText?.trim()) parts.push(`_${input.footerText.trim()}_`)
  return parts.join('\n\n')
}

/**
 * Substitute `{{1}}`, `{{2}}`… in a template body. Missing params are
 * left blank rather than leaking the placeholder to the customer.
 */
export function renderTemplateBody(body: string, params: string[] = []): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => {
    const idx = Number(n) - 1
    return params[idx] ?? ''
  })
}

export interface EngineQrSendInput {
  accountId: string
  conversationId: string
  contactId: string
  /** Plain text to deliver (already rendered). */
  text?: string
  /**
   * Media as stored in the DB (`url` may be origin-relative, e.g.
   * `/supabase/storage/...`). Only objects of this account's media storage
   * are accepted (`accountMediaUrlForServer` throws `MediaUrlNaoPermitida`,
   * status 400, before the gateway is called); the URL is rebuilt on the
   * internal storage route for the send only — the row keeps the stored form.
   */
  media?: GatewayMedia
  /** What to persist on `messages.content_type`. */
  contentType: 'text' | 'template' | 'image' | 'video' | 'document' | 'audio'
  templateName?: string | null
  /** Conversation-list preview; defaults to `text`. */
  preview?: string
  /** Which engine sent it — drives the bubble's sender label (migration 059). */
  origin?: 'automation' | 'flow' | 'ai' | 'csat' | 'api'
  /** Public API idempotency claim (migration 093): lets a crashed send be matched to its message. */
  apiRequestId?: string
  /**
   * `bulk` (default): automations, AI replies, surveys — the gateway paces
   * them and a full queue answers `throttled`, which the caller parks and
   * retries. `interactive`: flows, whose steps run inside the inbound
   * request (no resume mechanism, and the gateway's 15 s callback timeout):
   * they leave at once, exactly as before the queue existed.
   */
  priority?: GatewaySendPriority
  /** A human's scheduled message (092): stored as that agent's own reply, not a bot's. */
  agentId?: string
}

/**
 * Send through the gateway and persist a `sender_type='bot'` row on
 * the QR channel. Mirrors the persistence the Meta engine senders do.
 */
export async function engineSendViaQr(
  db: SupabaseClient,
  input: EngineQrSendInput,
): Promise<{ whatsapp_message_id: string }> {
  const media = input.media
    ? { ...input.media, url: accountMediaUrlForServer(input.media.url, input.accountId) }
    : undefined

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', input.contactId)
    .eq('account_id', input.accountId)
    .maybeSingle()
  if (contactErr || !contact?.phone) {
    throw new Error('contact not found for this account')
  }

  const to = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(to)) {
    throw new Error(`contact phone invalid: ${contact.phone}`)
  }
  await assertConversationOwned(db, input.accountId, input.contactId, input.conversationId)

  const priority = input.priority ?? 'bulk'
  let maxWaitMs = BULK_MAX_WAIT_MS
  if (priority === 'bulk') {
    // Inside a cron tick the budget bounds the whole handler; when it is
    // spent the send is refused as `throttled` without calling the gateway.
    const left = remainingBulkSendBudgetMs()
    if (left !== null) {
      if (left < 1_000) {
        throw new GatewayRequestError('Orçamento de envio do ciclo esgotado; tente no próximo.', 429, 'throttled')
      }
      maxWaitMs = Math.min(maxWaitMs, left)
    }
  }
  const { message_id } = await sendViaGateway({
    accountId: input.accountId,
    to,
    priority,
    ...(priority === 'bulk' ? { maxWaitMs } : {}),
    ...(input.text !== undefined ? { text: input.text } : {}),
    ...(media ? { media } : {}),
  })

  const row = {
    conversation_id: input.conversationId,
    sender_type: input.agentId ? 'agent' : 'bot',
    ...(input.agentId ? { sender_id: input.agentId } : {}),
    origin: input.origin ?? null,
    content_type: input.contentType,
    content_text: input.text ?? input.media?.caption ?? null,
    media_url: input.media?.url ?? null,
    template_name: input.templateName ?? null,
    message_id,
    status: 'sent',
    channel: 'qr',
    ...(input.apiRequestId ? { api_request_id: input.apiRequestId } : {}),
  }
  const { error: msgErr } = await db.from('messages').insert(row)
  // The phone echo of this very id got stored first (should not happen:
  // the gateway drops echoes of its own sends) — take that row over.
  const claimed =
    msgErr && isUniqueViolation(msgErr)
      ? await claimEchoedRow(db, input.conversationId, message_id, row)
      : null
  if (msgErr && !claimed) {
    throw new Error(`sent via gateway but DB insert failed: ${msgErr.message}`)
  }

  // Survey bubbles go out on closed conversations: no list reorder, no preview.
  if (input.origin === 'csat') return { whatsapp_message_id: message_id }

  await db
    .from('conversations')
    .update({
      last_message_text: input.preview ?? input.text ?? `[${input.contentType}]`,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.conversationId)
    .eq('account_id', input.accountId)

  return { whatsapp_message_id: message_id }
}

/**
 * Load a template body so an automation's `send_template` step can
 * degrade to text on the QR channel. Null when the row is missing.
 */
export async function loadTemplateBody(
  db: SupabaseClient,
  accountId: string,
  templateName: string,
  language?: string,
): Promise<string | null> {
  let q = db
    .from('message_templates')
    .select('body_text')
    .eq('account_id', accountId)
    .eq('name', templateName)
  if (language) q = q.eq('language', language)
  const { data, error } = await q.limit(1).maybeSingle()
  if (error || !data?.body_text) return null
  return data.body_text as string
}

/** Extension → MIME for engine media sends (flows `send_media`). */
export function mimeFromUrl(kind: string, url: string, filename?: string): string {
  const name = (filename || url.split('?')[0] || '').toLowerCase()
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
  const table: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    mp4: 'video/mp4',
    '3gp': 'video/3gpp',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    opus: 'audio/ogg',
    m4a: 'audio/mp4',
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    csv: 'text/csv',
    txt: 'text/plain',
  }
  if (ext && table[ext]) return table[ext]
  if (kind === 'image') return 'image/jpeg'
  if (kind === 'video') return 'video/mp4'
  if (kind === 'audio') return 'audio/ogg'
  return 'application/octet-stream'
}
