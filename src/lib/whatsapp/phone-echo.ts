// ============================================================
// QR channel: messages we sent from the phone, and messages deleted
// for everyone. Inbox package 1 — migration 059.
//
// Phone echo — the connected phone, WhatsApp Web or another linked
// device sent a message (Baileys `fromMe`, not one of the gateway's own
// sends). It is stored as an outbound row:
//
//   sender_type 'agent', sender_id NULL, origin 'phone', status 'sent'
//
// The `conversations_track_last_message` trigger (030/032) treats it as
// an agent reply: `last_agent_message_at` advances, so Radar / the
// queue stop showing the customer as waiting, and an unanswered
// conversation gets its first response (by NULL = not an inbox user).
//
// Unlike `ingestInboundMessage` it NEVER: bumps unread_count, touches
// last_customer_message_at, reopens a resolved conversation, runs
// flows / automations / opt-out / out-of-hours / auto-assign, flags a
// broadcast reply or sends a push. It does pause active flow runs for
// the contact, exactly like an agent send from the inbox — a human
// took over.
//
// Duplicates: the gateway drops echoes of its own sends; here the
// lookup + the unique (conversation_id, message_id) index (059) make a
// redelivery a no-op. When the echo wins the race against the row of
// an inbox/engine send with the same id, `claimEchoedRow` lets that
// send take the row over instead of failing.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import {
  findOrCreateContact,
  findOrCreateConversation,
  lookupInternalIdByProviderId,
  resolveAccountOwner,
  toContentType,
  toIsoTimestamp,
  type InboundMessageInput,
} from '@/lib/whatsapp/inbound'

export interface PhoneEchoResult {
  ok: boolean
  reason?: string
  duplicate?: boolean
  contactId?: string
  conversationId?: string
}

export type PhoneEchoInput = Omit<
  InboundMessageInput,
  'channel' | 'interactiveReplyId' | 'pushName' | 'userId'
>

async function pauseActiveFlowRuns(db: SupabaseClient, accountId: string, contactId: string) {
  try {
    const { error } = await db
      .from('flow_runs')
      .update({
        status: 'paused_by_agent',
        ended_at: new Date().toISOString(),
        end_reason: 'agent_replied',
      })
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .eq('status', 'active')
    if (error) console.error('[phone-echo] pause flow runs failed:', error.message)
  } catch (err) {
    console.error('[phone-echo] pause flow runs threw:', err)
  }
}

/** Store one message sent from the phone. Idempotent on `messageId`. */
export async function ingestPhoneEcho(
  input: PhoneEchoInput,
  db: SupabaseClient,
): Promise<PhoneEchoResult> {
  const { accountId } = input
  const ownerUserId = await resolveAccountOwner(db, accountId)
  if (!ownerUserId) return { ok: false, reason: 'account_owner_not_found' }

  const phone = normalizePhone(input.from)
  // Empty name: an echo must never rename the contact (Baileys' pushName
  // on a fromMe message is OUR profile name). A new contact is named
  // after its phone, as the manual "new conversation" flow does.
  const contactOutcome = await findOrCreateContact(db, accountId, ownerUserId, phone, '')
  if (!contactOutcome) return { ok: false, reason: 'contact_failed' }
  const contact = contactOutcome.contact

  const conversation = await findOrCreateConversation(db, accountId, ownerUserId, contact.id, 'qr')
  if (!conversation) return { ok: false, reason: 'conversation_failed', contactId: contact.id }

  const base = { contactId: contact.id as string, conversationId: conversation.id as string }

  if (await lookupInternalIdByProviderId(db, input.messageId, conversation.id)) {
    return { ok: true, duplicate: true, ...base }
  }

  let replyTo: string | null = null
  if (input.quotedMessageId) {
    replyTo = await lookupInternalIdByProviderId(db, input.quotedMessageId, conversation.id)
  }

  const contentText = input.text || null
  const createdAt = toIsoTimestamp(input.timestamp)
  const { error: msgError } = await db.from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'agent',
    sender_id: null,
    origin: 'phone',
    content_type: toContentType(input.type),
    content_text: contentText,
    media_url: input.mediaUrl || null,
    message_id: input.messageId,
    status: 'sent',
    channel: 'qr',
    created_at: createdAt,
    reply_to_message_id: replyTo,
  })
  if (msgError) {
    // Lost the race with a concurrent delivery of the same id.
    if (isUniqueViolation(msgError)) return { ok: true, duplicate: true, ...base }
    console.error('[phone-echo] insert failed:', msgError)
    return { ok: false, reason: 'message_insert_failed', ...base }
  }

  // Preview only — no unread, no reopen, no channel switch.
  const now = new Date().toISOString()
  const { error: convError } = await db
    .from('conversations')
    .update({
      last_message_text: contentText || `[${input.type}]`,
      last_message_at: now,
      updated_at: now,
    })
    .eq('id', conversation.id)
    .eq('account_id', accountId)
  if (convError) console.error('[phone-echo] conversation update failed:', convError)

  await pauseActiveFlowRuns(db, accountId, contact.id)

  return { ok: true, ...base }
}

/**
 * An inbox / engine send hit the unique index because the phone echo of
 * the same WhatsApp id was stored first. Take that row over with the
 * send's real attribution. Returns the row, or null when there is no
 * echo row to claim (then the conflict is a genuine error).
 */
export async function claimEchoedRow(
  db: SupabaseClient,
  conversationId: string,
  messageId: string,
  patch: Record<string, unknown>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any | null> {
  const { data, error } = await db
    .from('messages')
    .update({ ...patch, origin: patch.origin ?? null })
    .eq('conversation_id', conversationId)
    .eq('message_id', messageId)
    .eq('origin', 'phone')
    .select()
    .maybeSingle()
  if (error) {
    console.error('[phone-echo] claimEchoedRow failed:', error.message)
    return null
  }
  return data ?? null
}

export interface RevokeInput {
  accountId: string
  /** Provider id of the message that was deleted. */
  messageId: string
  /** The customer's phone (the conversation). */
  from: string
  revokedBy: 'customer' | 'phone'
  timestamp?: number | string | null
}

export interface RevokeResult {
  ok: boolean
  /** False when we never stored that message (or it was already marked). */
  found: boolean
}

/**
 * "Delete for everyone": stamp revoked_at / revoked_by on the stored
 * row. The row and its content are kept — agents still read it, struck
 * through. Scoped to the account through contact → conversation.
 */
export async function markMessageRevoked(
  input: RevokeInput,
  db: SupabaseClient,
): Promise<RevokeResult> {
  const contact = await findExistingContact(db, input.accountId, normalizePhone(input.from))
  if (!contact) return { ok: true, found: false }

  const { data: conversation } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', input.accountId)
    .eq('contact_id', contact.id)
    .maybeSingle()
  if (!conversation) return { ok: true, found: false }

  const { data, error } = await db
    .from('messages')
    .update({
      revoked_at: toIsoTimestamp(input.timestamp ?? null),
      revoked_by: input.revokedBy,
    })
    .eq('conversation_id', conversation.id)
    .eq('message_id', input.messageId)
    .is('revoked_at', null)
    .select('id')
  if (error) {
    console.error('[revoke] update failed:', error.message)
    return { ok: false, found: false }
  }
  return { ok: true, found: Array.isArray(data) && data.length > 0 }
}
