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

import type { WhatsAppChannel } from '@/types'
import { sanitizePhoneForMeta, isValidE164 } from './phone-utils'
import { sendViaGateway, type GatewayMedia } from './qr-gateway'
import { mediaUrlForServer } from '@/lib/storage/media-url'
import { isUniqueViolation } from '@/lib/contacts/dedupe'
import { claimEchoedRow } from './phone-echo'

/** `official` for rows that predate migration 026 or can't be read. */
export async function conversationChannel(
  db: SupabaseClient,
  conversationId: string,
): Promise<WhatsAppChannel> {
  const { data, error } = await db
    .from('conversations')
    .select('channel')
    .eq('id', conversationId)
    .maybeSingle()
  if (error || !data) return 'official'
  return data.channel === 'qr' ? 'qr' : 'official'
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
   * `/supabase/storage/...`). The gateway fetches the bytes itself, so the
   * URL is absolutised (`mediaUrlForServer`) for the send only — the row
   * keeps the stored form.
   */
  media?: GatewayMedia
  /** What to persist on `messages.content_type`. */
  contentType: 'text' | 'template' | 'image' | 'video' | 'document' | 'audio'
  templateName?: string | null
  /** Conversation-list preview; defaults to `text`. */
  preview?: string
  /** Which engine sent it — drives the bubble's sender label (migration 059). */
  origin?: 'automation' | 'flow' | 'ai' | 'csat'
}

/**
 * Send through the gateway and persist a `sender_type='bot'` row on
 * the QR channel. Mirrors the persistence the Meta engine senders do.
 */
export async function engineSendViaQr(
  db: SupabaseClient,
  input: EngineQrSendInput,
): Promise<{ whatsapp_message_id: string }> {
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

  const { message_id } = await sendViaGateway({
    accountId: input.accountId,
    to,
    ...(input.text !== undefined ? { text: input.text } : {}),
    ...(input.media ? { media: { ...input.media, url: mediaUrlForServer(input.media.url) } } : {}),
  })

  const row = {
    conversation_id: input.conversationId,
    sender_type: 'bot',
    origin: input.origin ?? null,
    content_type: input.contentType,
    content_text: input.text ?? input.media?.caption ?? null,
    media_url: input.media?.url ?? null,
    template_name: input.templateName ?? null,
    message_id,
    status: 'sent',
    channel: 'qr',
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
