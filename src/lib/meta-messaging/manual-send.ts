// ============================================================
// Manual (agent) reply on an Instagram / Messenger conversation.
//
// Called by POST /api/whatsapp/send once the caller, the conversation and the
// media URL are validated. Rules of these channels:
//   - only inside 24 h of the customer's last message, no templates;
//   - a media attachment carries no caption: the caption goes out as a second
//     text message;
//   - the token never leaves the server (service-role read, header on the call).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { isUniqueViolation } from '@/lib/contacts/dedupe'
import { claimEchoedRow } from '@/lib/whatsapp/phone-echo'
import { accountHasModule } from '@/lib/plans-server'
import { messagingModule } from './channels'
import { findConnectionForAccount, markConnectionExpired } from './connections'
import { sendMessagingMessage, type MessagingMediaKind } from './graph'
import { classifyMetaSendError, textLimitMessage, windowClosedMessage } from './send-core'
import type { MetaMessagingChannel } from '@/types'

/** Same window as the customer-service window on WhatsApp. */
export const MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000

export function isWithinMessagingWindow(lastCustomerMessageAt: string | null | undefined, now = Date.now()): boolean {
  const last = lastCustomerMessageAt ? Date.parse(lastCustomerMessageAt) : NaN
  return Number.isFinite(last) && now - last <= MESSAGING_WINDOW_MS
}

const MEDIA_KIND: Record<string, MessagingMediaKind> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  document: 'file',
}

/** Per Meta: Instagram counts 1000 bytes (UTF-8), Messenger 2000 characters. */
export function textTooLong(kind: MetaMessagingChannel, text: string | null | undefined): boolean {
  if (!text) return false
  return kind === 'instagram' ? Buffer.byteLength(text, 'utf8') > 1000 : [...text].length > 2000
}

const IDENTITY_COLUMN = { instagram: 'instagram_id', messenger: 'messenger_id' } as const
const LABEL = { instagram: 'Instagram', messenger: 'Messenger' } as const

export interface ManualSendInput {
  /** The agent's own (RLS) client — used to persist the message. */
  db: SupabaseClient
  /** Service-role client — reads the connection token. */
  admin: SupabaseClient
  accountId: string
  userId: string
  conversation: {
    id: string
    channel: MetaMessagingChannel
    last_customer_message_at?: string | null
    contact: Record<string, unknown> | null
  }
  messageType: string
  contentText: string | null
  /** Stored media URL (as persisted in `messages.media_url`). */
  mediaUrl: string | null
  /** Public URL Meta can fetch (rebuilt from the validated object path). */
  publicMediaUrl: string | null
  replyToMessageId: string | null
  now?: number
}

export interface ManualSendResult {
  status: number
  body: Record<string, unknown>
}

const fail = (status: number, error: string, code: string): ManualSendResult => ({ status, body: { error, code } })

export async function sendManualMessagingReply(input: ManualSendInput): Promise<ManualSendResult> {
  const { db, admin, accountId, userId, conversation } = input
  const kind = conversation.channel
  const label = LABEL[kind]

  if (input.messageType === 'template') {
    return fail(400, `Modelos de mensagem não existem no ${label}. Envie uma mensagem de texto.`, 'template_not_supported')
  }
  if (textTooLong(kind, input.contentText)) {
    return fail(400, textLimitMessage(kind), 'text_too_long')
  }
  const recipientId = conversation.contact?.[IDENTITY_COLUMN[kind]]
  if (typeof recipientId !== 'string' || !recipientId) {
    return fail(400, `Este contato não tem identificação do ${label}.`, 'contact_identity_missing')
  }
  if (!isWithinMessagingWindow(conversation.last_customer_message_at, input.now)) {
    return fail(409, windowClosedMessage(kind), 'window_closed')
  }
  if (!(await accountHasModule(admin, accountId, messagingModule(kind)))) {
    return fail(403, `Seu plano não inclui o canal ${label}. Fale com a equipe do SempreCRM para ativá-lo.`, 'module_not_included')
  }
  const conn = await findConnectionForAccount(admin, accountId, kind)
  if (!conn) return fail(400, `O ${label} não está conectado. Conecte o canal nas configurações.`, 'channel_not_connected')
  if (conn.status !== 'active') {
    return fail(400, `A conexão do ${label} expirou. Reconecte o canal nas configurações.`, 'channel_expired')
  }

  const target = { kind, businessId: conn.externalId, token: conn.token, recipientId }
  const mediaKind = MEDIA_KIND[input.messageType]
  const send = (payload: Parameters<typeof sendMessagingMessage>[1]) => sendMessagingMessage(target, payload)

  const persist = async (type: string, text: string | null, media: string | null, mid: string) => {
    const row = {
      conversation_id: conversation.id,
      sender_type: 'agent',
      sender_id: userId,
      content_type: type,
      content_text: text,
      media_url: media,
      message_id: mid,
      status: 'sent',
      channel: kind,
      reply_to_message_id: input.replyToMessageId,
    }
    const inserted = await db.from('messages').insert(row).select().single()
    let record = inserted.data
    // Meta echoes our own sends: if the echo landed first, take its row over.
    if (inserted.error && isUniqueViolation(inserted.error)) {
      record = await claimEchoedRow(db, conversation.id, mid, row)
    }
    if (!record) console.error('[meta-messaging] could not store the sent message:', inserted.error?.code ?? 'unknown')
    return record as { id: string } | null
  }

  let mainId: string
  let mainRecord: { id: string } | null
  let captionFailed = false
  try {
    if (mediaKind) {
      if (!input.publicMediaUrl) return fail(400, 'media_url is required for media messages', 'media_required')
      mainId = (await send({ mediaKind, url: input.publicMediaUrl })).messageId
      mainRecord = await persist(input.messageType, null, input.mediaUrl, mainId)
      if (input.contentText && input.messageType !== 'audio') {
        try {
          const caption = await send({ text: input.contentText })
          await persist('text', input.contentText, null, caption.messageId)
        } catch {
          captionFailed = true
          console.warn('[meta-messaging] caption send failed')
        }
      }
    } else {
      mainId = (await send({ text: input.contentText ?? '' })).messageId
      mainRecord = await persist('text', input.contentText, null, mainId)
    }
  } catch (err) {
    const failure = classifyMetaSendError(kind, err)
    if (failure.tokenInvalid) await markConnectionExpired(admin, conn.id)
    return fail(failure.status, failure.message, failure.code)
  }

  // Meta accepted it: never answer an error here (the agent would resend and the customer
  // would get it twice). Report success with a warning instead.
  if (!mainRecord) console.error('[meta-messaging] sent but not saved, mid', mainId)

  await db
    .from('conversations')
    .update({
      last_message_text: input.contentText || `[${input.messageType}]`,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)

  return {
    status: 200,
    body: {
      success: true,
      message_id: mainRecord?.id ?? null,
      ...(mainRecord ? {} : { warning: 'not_saved' }),
      whatsapp_message_id: mainId,
      channel: kind,
      ...(captionFailed ? { caption_failed: true } : {}),
    },
  }
}
