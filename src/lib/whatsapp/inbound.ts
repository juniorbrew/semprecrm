// ============================================================
// Shared inbound-message ingestion.
//
// One pipeline for every WhatsApp transport: the Meta webhook
// (`/api/whatsapp/webhook`) and the QR gateway (`/api/channels/qr/
// inbound`) both normalise their payload into `InboundMessageInput`
// and call `ingestInboundMessage`, which does
//
//   contact (dedupe / create) → conversation (upsert, unread,
//   last_message, channel) → messages row → flow runner →
//   automations → broadcast-reply flag
//
// Transport-specific work (Meta media URL verification, Baileys
// media download, reactions) stays in the caller. This module is
// deliberately free of `next/*` imports and takes the Supabase
// client as a parameter so it is unit-testable with a plain mock.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { parseAccountPreferences } from '@/lib/account-preferences'
import { isOptOutMessage, normalizeOptOutText } from '@/lib/whatsapp/opt-out'
import type { WhatsAppChannel } from '@/types'

/** Message kinds a transport may hand us. Anything else → text. */
export type InboundMessageType =
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | 'document'
  | 'sticker'
  | 'location'
  | 'interactive'
  | (string & {})

export interface InboundMessageInput {
  /** Tenancy — every row created downstream is stamped with this. */
  accountId: string
  channel: WhatsAppChannel
  /** Sender phone as the transport reports it (digits, "5511…"). */
  from: string
  /** WhatsApp profile name; falls back to the phone when empty. */
  pushName?: string | null
  /** Provider message id (Meta `wamid…` / Baileys key id). */
  messageId: string
  type: InboundMessageType
  /** Body text, caption, location summary or interactive title. */
  text?: string | null
  /** Already-resolved URL the inbox can render (proxy path or public). */
  mediaUrl?: string | null
  mimeType?: string | null
  /** Provider id of the message being swipe-replied to, if any. */
  quotedMessageId?: string | null
  /**
   * Epoch seconds (Meta / Baileys), epoch millis, an ISO string or a
   * Date. `undefined` → now.
   */
  timestamp?: number | string | Date | null
  /**
   * Official channel only — the stable id of the button / list row
   * the customer tapped. Drives the Flows engine.
   */
  interactiveReplyId?: string | null
  /**
   * Sender-of-record for NOT NULL `user_id` FKs on contacts /
   * conversations. The Meta webhook passes the config owner; the QR
   * route leaves it unset and we resolve the account owner.
   */
  userId?: string | null
}

export interface IngestResult {
  ok: boolean
  reason?: string
  contactId?: string
  conversationId?: string
  contactCreated?: boolean
  /** True when this message was a stop word and the contact was opted out. */
  optedOut?: boolean
}

// ------------------------------------------------------------
// Helpers shared with the webhook (reactions need the same
// contact / conversation resolution but never insert a message).
// ------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any

export interface ContactOutcome {
  contact: Row
  /** True when this call created the row — drives new_contact_created. */
  wasCreated: boolean
}

export async function findOrCreateContact(
  db: SupabaseClient,
  accountId: string,
  ownerUserId: string,
  phone: string,
  name: string,
): Promise<ContactOutcome | null> {
  // Shared dedupe helper: SQL suffix pre-filter + strict phonesMatch
  // in JS, same rule as the contact form and CSV import (issue #212).
  const existingContact = await findExistingContact(db, accountId, phone)

  if (existingContact) {
    if (name && name !== existingContact.name) {
      await db
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
    }
    return { contact: existingContact, wasCreated: false }
  }

  const { data: newContact, error: createError } = await db
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race with a concurrent delivery — the unique index
    // (migration 022) rejected the duplicate; re-resolve instead of
    // dropping the message.
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(db, accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('[inbound] error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

export async function findOrCreateConversation(
  db: SupabaseClient,
  accountId: string,
  ownerUserId: string,
  contactId: string,
  channel: WhatsAppChannel,
): Promise<Row | null> {
  const { data: existing, error: findError } = await db
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .single()

  if (!findError && existing) return existing

  const { data: newConv, error: createError } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      contact_id: contactId,
      channel,
    })
    .select()
    .single()

  if (createError) {
    console.error('[inbound] error creating conversation:', createError)
    return null
  }

  return newConv
}

/**
 * Resolve a provider-side message id into our internal UUID, scoped to
 * one conversation. Null when we never stored the parent.
 */
export async function lookupInternalIdByProviderId(
  db: SupabaseClient,
  providerId: string,
  conversationId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from('messages')
    .select('id')
    .eq('message_id', providerId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) {
    console.error('[inbound] lookupInternalIdByProviderId failed:', error.message)
    return null
  }
  return data?.id ?? null
}

/**
 * The account owner's user id — sender-of-record for QR inbound rows.
 */
export async function resolveAccountOwner(
  db: SupabaseClient,
  accountId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from('accounts')
    .select('owner_user_id')
    .eq('id', accountId)
    .maybeSingle()
  if (error || !data?.owner_user_id) return null
  return data.owner_user_id as string
}

// The messages.content_type CHECK constraint (widened in migration 010)
// allows: text, image, document, audio, video, location, template,
// interactive. Anything else maps to the closest allowed value.
const ALLOWED_CONTENT_TYPES = new Set([
  'text',
  'image',
  'document',
  'audio',
  'video',
  'location',
  'template',
  'interactive',
])

export function toContentType(type: string): string {
  if (ALLOWED_CONTENT_TYPES.has(type)) return type
  if (type === 'sticker') return 'image' // stickers are images
  return 'text' // unknown → text fallback
}

export function toIsoTimestamp(value: InboundMessageInput['timestamp']): string {
  if (value === null || value === undefined || value === '') {
    return new Date().toISOString()
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? new Date().toISOString() : value.toISOString()
  }
  const asNumber = typeof value === 'number' ? value : Number(value)
  if (Number.isFinite(asNumber)) {
    // Epoch seconds (Meta, Baileys) vs millis — anything under 1e12 is
    // seconds until the year 33658.
    const ms = asNumber < 1e12 ? asNumber * 1000 : asNumber
    return new Date(ms).toISOString()
  }
  const parsed = new Date(value as string)
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString()
}

/**
 * The account's opt-out stop words (accounts.preferences, migration
 * 030). Defaults apply when the column is missing or malformed.
 */
export async function loadOptOutKeywords(
  db: SupabaseClient,
  accountId: string,
): Promise<string[]> {
  try {
    const { data, error } = await db
      .from('accounts')
      .select('preferences')
      .eq('id', accountId)
      .maybeSingle()
    if (error) return parseAccountPreferences(null).opt_out_keywords
    return parseAccountPreferences(data?.preferences).opt_out_keywords
  } catch {
    return parseAccountPreferences(null).opt_out_keywords
  }
}

/**
 * Opt-out (spec §5): when the whole message is one of the account's stop
 * words, stamp `contacts.opted_out_at` and log a `contact_opted_out`
 * pill on the conversation. A contact that is already opted out is left
 * as is (no duplicate pill). Returns whether the message was an opt-out.
 * Best-effort — never breaks the main flow.
 */
async function applyOptOutIfAny(
  db: SupabaseClient,
  accountId: string,
  contact: Row,
  conversationId: string,
  text: string | null,
): Promise<boolean> {
  if (!text) return false
  try {
    const keywords = await loadOptOutKeywords(db, accountId)
    if (!isOptOutMessage(text, keywords)) return false
    if (contact.opted_out_at) return true

    const now = new Date().toISOString()
    const { error: updErr } = await db
      .from('contacts')
      .update({ opted_out_at: now, updated_at: now })
      .eq('id', contact.id)
      .eq('account_id', accountId)
    if (updErr) {
      console.error('[inbound] opt-out update failed:', updErr)
      return true
    }
    contact.opted_out_at = now

    const { error: evErr } = await db.from('conversation_events').insert({
      account_id: accountId,
      conversation_id: conversationId,
      actor_user_id: null,
      event_type: 'contact_opted_out',
      payload: { keyword: normalizeOptOutText(text), source: 'inbound_message' },
    })
    if (evErr) console.error('[inbound] opt-out event insert failed:', evErr)
    return true
  } catch (err) {
    console.error('[inbound] applyOptOutIfAny failed:', err)
    return false
  }
}

/**
 * If the sender is on a still-unreplied broadcast_recipients row, flip
 * it to `replied` so the parent broadcast's reply count advances.
 * Best-effort — never breaks the main flow.
 */
async function flagBroadcastReplyIfAny(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
) {
  try {
    const { data: recs, error } = await db
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1)

    if (error || !recs || recs.length === 0) return

    const { error: updErr } = await db
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', recs[0].id)

    if (updErr) {
      console.error('[inbound] error marking broadcast recipient replied:', updErr)
    }
  } catch (err) {
    console.error('[inbound] flagBroadcastReplyIfAny failed:', err)
  }
}

/**
 * Ingest one inbound customer message. Idempotent on `messageId`: a
 * redelivery of a message we already stored is a no-op.
 */
export async function ingestInboundMessage(
  input: InboundMessageInput,
  db: SupabaseClient = supabaseAdmin(),
): Promise<IngestResult> {
  const { accountId, channel } = input

  const ownerUserId = input.userId || (await resolveAccountOwner(db, accountId))
  if (!ownerUserId) {
    console.error('[inbound] no owner user for account', accountId)
    return { ok: false, reason: 'account_owner_not_found' }
  }

  const senderPhone = normalizePhone(input.from)
  const contactName = (input.pushName ?? '').trim()

  const contactOutcome = await findOrCreateContact(
    db,
    accountId,
    ownerUserId,
    senderPhone,
    contactName,
  )
  if (!contactOutcome) return { ok: false, reason: 'contact_failed' }
  const contact = contactOutcome.contact

  const conversation = await findOrCreateConversation(
    db,
    accountId,
    ownerUserId,
    contact.id,
    channel,
  )
  if (!conversation) {
    return { ok: false, reason: 'conversation_failed', contactId: contact.id }
  }

  // Dedupe redeliveries (gateway retries, Meta replays) by provider id.
  if (input.messageId) {
    const existingId = await lookupInternalIdByProviderId(
      db,
      input.messageId,
      conversation.id,
    )
    if (existingId) {
      return {
        ok: true,
        reason: 'duplicate',
        contactId: contact.id,
        conversationId: conversation.id,
        contactCreated: contactOutcome.wasCreated,
      }
    }
  }

  // Swipe-reply context. A missing parent is fine — NULL, no quote.
  let replyToInternalId: string | null = null
  if (input.quotedMessageId) {
    replyToInternalId = await lookupInternalIdByProviderId(
      db,
      input.quotedMessageId,
      conversation.id,
    )
    if (!replyToInternalId) {
      console.warn('[inbound] reply context parent not found:', input.quotedMessageId)
    }
  }

  const contentType = toContentType(input.type)
  const contentText = input.text || null
  const mediaUrl = input.mediaUrl || null
  const interactiveReplyId =
    contentType === 'interactive' ? (input.interactiveReplyId ?? null) : null

  // First-ever customer message? Decided BEFORE the insert so the count
  // is accurate. Covers contacts added by hand / CSV that never wrote.
  const { count: priorCustomerMsgCount } = await db
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  const { error: msgError } = await db.from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'customer',
    content_type: contentType,
    content_text: contentText,
    media_url: mediaUrl,
    message_id: input.messageId,
    status: 'delivered',
    channel,
    created_at: toIsoTimestamp(input.timestamp),
    reply_to_message_id: replyToInternalId,
    interactive_reply_id: interactiveReplyId,
  })

  if (msgError) {
    console.error('[inbound] error inserting message:', msgError)
    return {
      ok: false,
      reason: 'message_insert_failed',
      contactId: contact.id,
      conversationId: conversation.id,
    }
  }

  // Conversation bookkeeping. `channel` follows the customer's latest
  // inbound transport so an agent reply goes back the way it came.
  const { error: convError } = await db
    .from('conversations')
    .update({
      last_message_text: contentText || `[${input.type}]`,
      last_message_at: new Date().toISOString(),
      unread_count: (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
      channel,
    })
    .eq('id', conversation.id)

  if (convError) {
    console.error('[inbound] error updating conversation:', convError)
  }

  await flagBroadcastReplyIfAny(db, accountId, contact.id)

  // "PARAR" / "SAIR" — mark the contact and tell the automations so
  // send steps are skipped for this message.
  const optedOut = await applyOptOutIfAny(
    db,
    accountId,
    contact,
    conversation.id,
    contentText,
  )

  // Flow runner first — when it consumes the message, the content-level
  // automation triggers are suppressed (the customer is navigating a
  // bot menu, not sending a trigger word). Relationship-level triggers
  // still fire. The runner never throws.
  const inboundText = contentText ?? ''
  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: ownerUserId,
    contactId: contact.id,
    conversationId: conversation.id,
    message: interactiveReplyId
      ? {
          kind: 'interactive_reply',
          reply_id: interactiveReplyId,
          reply_title: inboundText,
          meta_message_id: input.messageId,
        }
      : {
          kind: 'text',
          text: inboundText,
          meta_message_id: input.messageId,
        },
    isFirstInboundMessage,
  })

  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
  )[] = []
  if (!flowResult.consumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
  }
  if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')

  // Fire-and-forget: a slow automation must not block the transport's
  // 200 OK.
  for (const triggerType of automationTriggers) {
    runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contact.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
        ...(optedOut ? { vars: { opted_out: true } } : {}),
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }

  return {
    ok: true,
    contactId: contact.id,
    conversationId: conversation.id,
    contactCreated: contactOutcome.wasCreated,
    optedOut,
  }
}
