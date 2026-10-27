// ============================================================
// Echo: a message the BUSINESS sent from the Instagram / Facebook app (or
// through our own send call — Meta echoes those too). Stored as an outbound
// row, like the phone echo on the QR channel:
//
//   sender_type 'agent', sender_id NULL, origin 'phone', status 'sent'
//
// Never creates a contact or a conversation, never touches unread counters
// or reopens anything. A redelivery (same mid) is a no-op; when our own send
// route stored the row first this finds it, when the echo wins the race the
// send route takes the row over with `claimEchoedRow`.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { isUniqueViolation } from '@/lib/contacts/dedupe'
import { findStoredMessage, previewText } from '@/lib/whatsapp/inbound'
import type { MetaMessagingChannel } from '@/types'

export interface MessagingEchoInput {
  accountId: string
  kind: MetaMessagingChannel
  customerId: string
  messageId: string
  contentType: string
  text: string | null
  mediaUrl: string | null
  /** Epoch millis. */
  timestamp: number
  quotedMessageId?: string | null
}

export interface MessagingEchoResult {
  ok: boolean
  skipped?: 'unknown_contact' | 'no_conversation'
  duplicate?: boolean
  conversationId?: string
}

const IDENTITY_COLUMN = { instagram: 'instagram_id', messenger: 'messenger_id' } as const

export async function ingestMessagingEcho(
  db: SupabaseClient,
  input: MessagingEchoInput,
): Promise<MessagingEchoResult> {
  const { accountId } = input
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, anonymized_at')
    .eq('account_id', accountId)
    .eq(IDENTITY_COLUMN[input.kind], input.customerId)
    .maybeSingle()
  if (contactErr) {
    console.error('[meta-messaging] echo contact lookup failed:', contactErr.code ?? 'unknown')
    return { ok: false }
  }
  if (!contact || contact.anonymized_at) return { ok: true, skipped: 'unknown_contact' }

  const { data: conversations, error: convErr } = await db
    .from('conversations')
    .select('id, status')
    .eq('account_id', accountId)
    .eq('contact_id', contact.id)
    .order('created_at', { ascending: false })
  if (convErr) {
    console.error('[meta-messaging] echo conversation lookup failed:', convErr.message)
    return { ok: false }
  }
  const rows = (conversations ?? []) as { id: string; status: string }[]
  if (rows.length === 0) return { ok: true, skipped: 'no_conversation' }
  // The live conversation, else the latest resolved one (left resolved).
  const conversation = rows.find((c) => c.status !== 'closed') ?? rows[0]
  const ids = rows.map((c) => c.id)

  if (await findStoredMessage(db, input.messageId, ids)) {
    return { ok: true, duplicate: true, conversationId: conversation.id }
  }
  const replyTo = input.quotedMessageId
    ? ((await findStoredMessage(db, input.quotedMessageId, ids))?.id ?? null)
    : null

  const createdAt = new Date(input.timestamp).toISOString()
  const { error: msgError } = await db.from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'agent',
    sender_id: null,
    origin: 'phone',
    content_type: input.contentType,
    content_text: input.text,
    media_url: input.mediaUrl,
    message_id: input.messageId,
    status: 'sent',
    channel: input.kind,
    created_at: createdAt,
    reply_to_message_id: replyTo,
  })
  if (msgError) {
    if (isUniqueViolation(msgError)) return { ok: true, duplicate: true, conversationId: conversation.id }
    console.error('[meta-messaging] echo insert failed:', msgError.code ?? 'unknown')
    return { ok: false, conversationId: conversation.id }
  }

  // Preview only, and never backwards: a late redelivery must not replace a newer preview.
  const { error: updateError } = await db
    .from('conversations')
    .update({
      last_message_text: previewText(input.text, input.contentType),
      last_message_at: createdAt,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)
    .eq('account_id', accountId)
    .or(`last_message_at.is.null,last_message_at.lte."${createdAt}"`)
  if (updateError) console.error('[meta-messaging] echo conversation update failed:', updateError.message)

  return { ok: true, conversationId: conversation.id }
}
