// ============================================================
// Automatic sends on Instagram / Messenger conversations (part C): automations,
// flows, AI replies, surveys, scheduled messages and the public API all end here
// through `automations/meta-send.ts` and `flows/meta-send.ts`.
//
// One function, one set of rules (the same pieces as the agent's manual reply):
//   - the customer's last message is less than 24 h old (there are no templates
//     and no message tags here), else SKIP;
//   - the plan includes the channel module and the connection is active, else SKIP;
//   - Instagram 1000 bytes / Messenger 2000 characters of text;
//   - the token is refused (190) → the connection is flagged expired and the send SKIPs;
//   - persist the outbound row (bot, or the human for a scheduled message) with the
//     engine's origin, like the WhatsApp engine paths.
//
// A SKIP is a `MessagingSkipError` with a stable `code` and a pt-BR message: callers
// record it as "not sent, and why" — nothing here is worth retrying. A transient
// Meta / network failure throws a plain Error (callers retry as for WhatsApp).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { isUniqueViolation } from '@/lib/contacts/dedupe'
import { accountHasModule } from '@/lib/plans-server'
import { assertAccountMediaUrl, storageUrlForPublic } from '@/lib/storage/media-url'
import { claimEchoedRow } from '@/lib/whatsapp/phone-echo'
import type { MetaMessagingChannel } from '@/types'

import { isMetaMessagingChannel, MESSAGING_LABEL, messagingModule } from './channels'
import { findConnectionForAccount, markConnectionExpired } from './connections'
import { sendMessagingMessage, type MessagingMediaKind } from './graph'
import { isWithinMessagingWindow, textTooLong } from './manual-send'
import { classifyMetaSendError, textLimitMessage, windowClosedMessage } from './send-core'
import { MessagingSkipError } from './skip'

export { MessagingSkipError, type MessagingSkipCode } from './skip'

export type EngineOrigin = 'automation' | 'flow' | 'ai' | 'csat' | 'api' | 'system'

export type EngineContent =
  | { kind: 'text'; text: string }
  | {
      kind: 'media'
      /** image | video | audio | document, as stored on `messages.content_type`. */
      mediaType: 'image' | 'video' | 'audio' | 'document'
      /** Stored URL (own account storage; anything else is refused). */
      url: string
      caption?: string | null
    }

export interface EngineMessagingSendInput {
  accountId: string
  conversationId: string
  contactId: string
  content: EngineContent
  /** Which engine sent it (the bubble's sender label); a scheduled human message has none. */
  origin?: EngineOrigin
  /** A human's scheduled message: stored as that agent's own reply, not a bot's. */
  agentId?: string
  /** Public API idempotency claim (migration 093). */
  apiRequestId?: string
  /** Conversation-list preview; defaults to the text. */
  preview?: string
  now?: number
}

const MEDIA_KIND: Record<string, MessagingMediaKind> = { image: 'image', video: 'video', audio: 'audio', document: 'file' }
const IDENTITY_COLUMN = { instagram: 'instagram_id', messenger: 'messenger_id' } as const

/** The skip for a template step: these channels have no templates. */
export function templateSkip(kind: MetaMessagingChannel): MessagingSkipError {
  return new MessagingSkipError('template_unsupported', `Modelos de mensagem não existem no ${MESSAGING_LABEL[kind]}.`)
}

export async function engineSendMessaging(
  db: SupabaseClient,
  input: EngineMessagingSendInput,
): Promise<{ whatsapp_message_id: string }> {
  // Account + contact scoped, like assertConversationOwned: a conversation id from caller-supplied
  // context must belong to this account AND this contact.
  const { data: conv, error: convErr } = await db
    .from('conversations')
    .select('id, channel, last_customer_message_at, contact:contacts(instagram_id, messenger_id, anonymized_at)')
    .eq('id', input.conversationId)
    .eq('account_id', input.accountId)
    .eq('contact_id', input.contactId)
    .maybeSingle()
  if (convErr || !conv) throw new Error('conversation not found for this account/contact')
  const kind = conv.channel
  if (!isMetaMessagingChannel(kind)) throw new Error('not an Instagram / Messenger conversation')
  const label = MESSAGING_LABEL[kind]

  const contactRel = conv.contact as unknown
  const contact = (Array.isArray(contactRel) ? contactRel[0] : contactRel) as
    | { instagram_id?: string | null; messenger_id?: string | null; anonymized_at?: string | null }
    | null
  const recipientId = contact?.[IDENTITY_COLUMN[kind]]
  if (!recipientId || contact?.anonymized_at) {
    throw new MessagingSkipError('contact_identity_missing', `Este contato não tem identificação do ${label}.`)
  }

  const text = input.content.kind === 'text' ? input.content.text : (input.content.caption ?? '')
  if (textTooLong(kind, text)) throw new MessagingSkipError('text_too_long', textLimitMessage(kind))
  if (!isWithinMessagingWindow(conv.last_customer_message_at as string | null, input.now)) {
    throw new MessagingSkipError('window_closed', windowClosedMessage(kind))
  }
  if (!(await accountHasModule(db, input.accountId, messagingModule(kind)))) {
    throw new MessagingSkipError('module_off', `O plano da conta não inclui o canal ${label}.`)
  }
  const conn = await findConnectionForAccount(db, input.accountId, kind)
  if (!conn) throw new MessagingSkipError('channel_not_connected', `O ${label} não está conectado.`)
  if (conn.status !== 'active') {
    throw new MessagingSkipError('channel_expired', `A conexão do ${label} expirou. Reconecte o canal nas configurações.`)
  }

  let publicMediaUrl = ''
  if (input.content.kind === 'media') {
    // Same rule as the QR / manual paths: only this account's own storage, rebuilt from the object path.
    publicMediaUrl = storageUrlForPublic(assertAccountMediaUrl(input.content.url, input.accountId))
  }

  const target = { kind, businessId: conn.externalId, token: conn.token, recipientId }
  const sentRows: { type: string; text: string | null; media: string | null; mid: string }[] = []
  try {
    if (input.content.kind === 'media') {
      const sent = await sendMessagingMessage(target, { mediaKind: MEDIA_KIND[input.content.mediaType], url: publicMediaUrl })
      sentRows.push({ type: input.content.mediaType, text: null, media: input.content.url, mid: sent.messageId })
      // An attachment carries no caption here: it goes out as a second text message.
      if (input.content.caption && input.content.mediaType !== 'audio') {
        try {
          const cap = await sendMessagingMessage(target, { text: input.content.caption })
          sentRows.push({ type: 'text', text: input.content.caption, media: null, mid: cap.messageId })
        } catch {
          console.warn('[meta-messaging] caption send failed')
        }
      }
    } else {
      const sent = await sendMessagingMessage(target, { text: input.content.text })
      sentRows.push({ type: 'text', text: input.content.text, media: null, mid: sent.messageId })
    }
  } catch (err) {
    const failure = classifyMetaSendError(kind, err)
    if (failure.tokenInvalid) await markConnectionExpired(db, conn.id)
    if (failure.code === 'send_failed') throw new Error(failure.message)
    throw new MessagingSkipError(failure.code, failure.message)
  }

  for (const [i, r] of sentRows.entries()) {
    const row = {
      conversation_id: input.conversationId,
      sender_type: input.agentId ? 'agent' : 'bot',
      ...(input.agentId ? { sender_id: input.agentId } : {}),
      origin: input.origin ?? null,
      content_type: r.type,
      content_text: r.text,
      media_url: r.media,
      message_id: r.mid,
      status: 'sent',
      channel: kind,
      ...(i === 0 && input.apiRequestId ? { api_request_id: input.apiRequestId } : {}),
    }
    const { error } = await db.from('messages').insert(row)
    // Meta echoes our own sends: if the echo got stored first, take that row over.
    const claimed = error && isUniqueViolation(error) ? await claimEchoedRow(db, input.conversationId, r.mid, row) : null
    // Message already accepted by Meta: callers must not retry (same marker as the WhatsApp paths).
    if (error && !claimed) throw new Error(`sent to Meta but DB insert failed: ${error.code ?? 'unknown'}`)
  }

  // Survey bubbles go out on closed conversations: no list reorder, no preview.
  if (input.origin !== 'csat') {
    await db
      .from('conversations')
      .update({
        last_message_text: input.preview ?? (input.content.kind === 'text' ? input.content.text : `[${input.content.mediaType}]`),
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', input.conversationId)
      .eq('account_id', input.accountId)
  }
  return { whatsapp_message_id: sentRows[0].mid }
}
