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
// Only for contacts the account already has a conversation with: the
// connected number is often also someone's personal WhatsApp, and a
// chat with a friend must never become a CRM contact. Anonymised
// (LGPD) contacts are skipped too.
//
// SLA: the `conversations_track_last_message` trigger (030/032,
// redefined in 059) counts the row as an agent reply — the customer is
// no longer waiting — UNLESS it landed within 15 s after the
// customer's latest message: that is the WhatsApp Business app's
// greeting / away message (or another bot on a linked device), not a
// human. `phoneEchoCountsAsReply` mirrors that rule here, and only a
// counted echo pauses the contact's active flow runs (a human took
// over, like an inbox send).
//
// Target: the contact's open / pending conversation, else the latest
// resolved one (left resolved).
//
// Unlike `ingestInboundMessage` it NEVER: creates a conversation, bumps unread_count, touches
// last_customer_message_at, reopens a resolved conversation, switches
// the channel, renames or creates contacts, runs flows / automations /
// opt-out / out-of-hours / auto-assign, flags a broadcast reply or
// sends a push.
//
// Duplicates: the gateway drops echoes of its own sends; here the
// lookup + the unique (conversation_id, message_id) index (059) make a
// redelivery a no-op. When the echo wins the race against the row of
// an inbox/engine send with the same id, `claimEchoedRow` lets that
// send take the row over instead of failing.
//
// Errors: a DB failure returns `{ ok: false }` (the routes answer 5xx
// and the gateway retries); "nothing to do" is `{ ok: true, skipped }`.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { isUniqueViolation } from '@/lib/contacts/dedupe'
import { normalizePhone, phonesMatch } from '@/lib/whatsapp/phone-utils'
import {
  lookupInternalIdByProviderId,
  toContentType,
  toIsoTimestamp,
  type InboundMessageInput,
} from '@/lib/whatsapp/inbound'

/** Keep in sync with public.phone_echo_counts_as_reply (migration 059). */
export const PHONE_ECHO_AUTO_REPLY_WINDOW_SECONDS = 15

/**
 * False when a phone echo is most likely an automatic greeting / away
 * message: sent at or up to 15 s after the customer's latest message.
 */
export function phoneEchoCountsAsReply(
  createdAt: string,
  lastCustomerAt: string | null | undefined,
): boolean {
  if (!lastCustomerAt) return true
  const sent = new Date(createdAt).getTime()
  const customer = new Date(lastCustomerAt).getTime()
  if (!Number.isFinite(sent) || !Number.isFinite(customer)) return true
  return sent < customer || sent > customer + PHONE_ECHO_AUTO_REPLY_WINDOW_SECONDS * 1000
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any

type ContactLookup =
  | { kind: 'found'; contactId: string; conversations: Row[] }
  | { kind: 'skip'; reason: 'unknown_contact' | 'anonymized_contact' | 'no_conversation' }
  | { kind: 'error' }

/**
 * The account's contact for `phone` and its conversations (newest
 * first). Unlike `findExistingContact` this surfaces DB errors, so a
 * transient failure is retried instead of silently dropping the event.
 */
async function findContactConversations(
  db: SupabaseClient,
  accountId: string,
  phone: string,
): Promise<ContactLookup> {
  const normalized = normalizePhone(phone)
  if (!normalized) return { kind: 'skip', reason: 'unknown_contact' }
  const suffix = normalized.length >= 8 ? normalized.slice(-8) : normalized

  const { data: contacts, error: contactErr } = await db
    .from('contacts')
    .select('id, phone, anonymized_at')
    .eq('account_id', accountId)
    .like('phone', `%${suffix}`)
  if (contactErr) {
    console.error('[phone-echo] contact lookup failed:', contactErr.message)
    return { kind: 'error' }
  }
  const candidates = (contacts ?? []) as Row[]
  const contact =
    candidates.find((c) => normalizePhone(c.phone) === normalized) ??
    candidates.find((c) => phonesMatch(c.phone, normalized))
  if (!contact) return { kind: 'skip', reason: 'unknown_contact' }
  if (contact.anonymized_at) return { kind: 'skip', reason: 'anonymized_contact' }

  const { data: conversations, error: convErr } = await db
    .from('conversations')
    .select('id, status, last_customer_message_at, last_message_at')
    .eq('account_id', accountId)
    .eq('contact_id', contact.id)
    .order('last_message_at', { ascending: false, nullsFirst: false })
  if (convErr) {
    console.error('[phone-echo] conversation lookup failed:', convErr.message)
    return { kind: 'error' }
  }
  if (!conversations || conversations.length === 0) {
    return { kind: 'skip', reason: 'no_conversation' }
  }
  return { kind: 'found', contactId: contact.id as string, conversations: conversations as Row[] }
}

export interface PhoneEchoResult {
  /** False only on a DB failure — the caller should retry. */
  ok: boolean
  reason?: string
  /** Nothing stored on purpose (personal chat, anonymised contact…). */
  skipped?: string
  duplicate?: boolean
  /** Whether the echo counted as a human reply (SLA + flow pause). */
  countsAsReply?: boolean
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
  const lookup = await findContactConversations(db, accountId, input.from)
  if (lookup.kind === 'error') return { ok: false, reason: 'lookup_failed' }
  if (lookup.kind === 'skip') return { ok: true, skipped: lookup.reason }

  // The live (open / pending) conversation when there is one, else the
  // latest resolved one — an echo never creates or reopens a
  // conversation (migration 060: a resolved conversation is final).
  const conversation =
    lookup.conversations.find((c) => c.status !== 'closed') ?? lookup.conversations[0]
  const conversationIds = lookup.conversations.map((c) => c.id as string)
  const base = { contactId: lookup.contactId, conversationId: conversation.id as string }

  const { data: existing, error: dupErr } = await db
    .from('messages')
    .select('id')
    .eq('message_id', input.messageId)
    .in('conversation_id', conversationIds)
  if (dupErr) {
    console.error('[phone-echo] duplicate lookup failed:', dupErr.message)
    return { ok: false, reason: 'lookup_failed', ...base }
  }
  if (existing && existing.length > 0) return { ok: true, duplicate: true, ...base }

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

  // Preview only — no unread, no reopen, no channel switch — and never
  // backwards: a late redelivery of an old echo must not replace a
  // newer preview.
  const { error: convError } = await db
    .from('conversations')
    .update({
      last_message_text: contentText || `[${input.type}]`,
      last_message_at: createdAt,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)
    .eq('account_id', accountId)
    .or(`last_message_at.is.null,last_message_at.lte."${createdAt}"`)
  if (convError) console.error('[phone-echo] conversation update failed:', convError)

  // Same rule as the trigger: a greeting / away message is not a human.
  const countsAsReply = phoneEchoCountsAsReply(createdAt, conversation.last_customer_message_at)
  if (countsAsReply) await pauseActiveFlowRuns(db, accountId, lookup.contactId)

  return { ok: true, countsAsReply, ...base }
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
): Promise<Row | null> {
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
  /** False only on a DB failure — the caller should retry. */
  ok: boolean
  /** False when we never stored that message (or it was already marked). */
  found: boolean
}

/**
 * "Delete for everyone": stamp revoked_at / revoked_by on the stored
 * row. The row and its content are kept — agents still read it, struck
 * through. Scoped to the account's conversations with that contact and
 * to the author: the customer can only revoke customer rows, our phone
 * only outbound rows.
 */
export async function markMessageRevoked(
  input: RevokeInput,
  db: SupabaseClient,
): Promise<RevokeResult> {
  const lookup = await findContactConversations(db, input.accountId, input.from)
  if (lookup.kind === 'error') return { ok: false, found: false }
  if (lookup.kind === 'skip') return { ok: true, found: false }

  let query = db
    .from('messages')
    .update({
      revoked_at: toIsoTimestamp(input.timestamp ?? null),
      revoked_by: input.revokedBy,
    })
    .eq('message_id', input.messageId)
    .in(
      'conversation_id',
      lookup.conversations.map((c) => c.id as string),
    )
    .is('revoked_at', null)
  query =
    input.revokedBy === 'customer'
      ? query.eq('sender_type', 'customer')
      : query.neq('sender_type', 'customer')

  const { data, error } = await query.select('id')
  if (error) {
    console.error('[revoke] update failed:', error.message)
    return { ok: false, found: false }
  }
  return { ok: true, found: Array.isArray(data) && data.length > 0 }
}
