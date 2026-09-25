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
import { cancelWaitsOnCustomerReply, runAutomationsForTrigger } from '@/lib/automations/engine'
import { drainAutomationEvents } from '@/lib/automations/event-queue'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { parseAccountPreferences } from '@/lib/account-preferences'
import { isOptOutMessage, normalizeOptOutText } from '@/lib/whatsapp/opt-out'
import { isWithinBusinessHours, startOfLocalDay } from '@/lib/business-hours'
import { pickRoundRobinAssignee } from '@/lib/assignment/round-robin'
import { engineSendText } from '@/lib/automations/meta-send'
import { notifyInboundMessage } from '@/lib/push/notify'
import { isPushConfigured } from '@/lib/push/send'
import type { AccountPreferences, WhatsAppChannel } from '@/types'

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
  /** Round-robin auto-assign (spec round 2 §2): who got the conversation, if anyone. */
  autoAssignedTo?: string | null
  /** Out-of-hours auto-reply outcome, when the feature is on and we are closed. */
  outOfHoursReply?: 'sent' | 'skipped' | 'failed'
  /** True when the customer's message reopened a resolved conversation. */
  reopened?: boolean
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
 * The account's parsed preferences (accounts.preferences, migration
 * 030). Defaults apply when the column is missing or malformed.
 */
export async function loadAccountPreferences(
  db: SupabaseClient,
  accountId: string,
): Promise<AccountPreferences> {
  try {
    const { data, error } = await db
      .from('accounts')
      .select('preferences')
      .eq('id', accountId)
      .maybeSingle()
    if (error) return parseAccountPreferences(null)
    return parseAccountPreferences(data?.preferences)
  } catch {
    return parseAccountPreferences(null)
  }
}

/** The account's opt-out stop words. */
export async function loadOptOutKeywords(
  db: SupabaseClient,
  accountId: string,
): Promise<string[]> {
  return (await loadAccountPreferences(db, accountId)).opt_out_keywords
}

/**
 * Auto-assign (spec round 2 §2): when the account has
 * `auto_assign_enabled` and the conversation receives its first customer
 * message without an owner, round-robin it to an available agent and
 * log the `assigned` pill. Nobody available → stays unassigned (Radar).
 * Best-effort — never breaks the main flow.
 */
async function autoAssignIfEnabled(
  db: SupabaseClient,
  accountId: string,
  conversation: Row,
  prefs: AccountPreferences,
  isFirstInboundMessage: boolean,
): Promise<string | null> {
  if (!prefs.auto_assign_enabled) return null
  if (!isFirstInboundMessage || conversation.assigned_agent_id) return null
  try {
    const assignee = await pickRoundRobinAssignee(db, accountId)
    if (!assignee) return null
    const { error: updErr } = await db
      .from('conversations')
      .update({ assigned_agent_id: assignee, updated_at: new Date().toISOString() })
      .eq('id', conversation.id)
      .eq('account_id', accountId)
    if (updErr) {
      console.error('[inbound] auto-assign update failed:', updErr)
      return null
    }
    conversation.assigned_agent_id = assignee
    const { error: evErr } = await db.from('conversation_events').insert({
      account_id: accountId,
      conversation_id: conversation.id,
      actor_user_id: null,
      event_type: 'assigned',
      payload: { assignee_user_id: assignee, source: 'auto_assign' },
    })
    if (evErr) console.error('[inbound] auto-assign event insert failed:', evErr)
    return assignee
  } catch (err) {
    console.error('[inbound] autoAssignIfEnabled failed:', err)
    return null
  }
}

/** Meta refuses free-form text outside the 24 h customer-service window. */
function isOutsideMetaWindowError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /131047|131026|re-?engagement|24[ -]?h/i.test(msg)
}

/**
 * Out-of-hours auto-reply (spec round 2 §2): when enabled and we are
 * outside business hours, send `out_of_hours_message` through the
 * conversation's channel at most once per local business day. On the
 * official channel a send outside the 24 h window is impossible —
 * record it as skipped so we do not retry on every message. Best-effort.
 */
async function replyOutOfHoursIfNeeded(
  db: SupabaseClient,
  accountId: string,
  ownerUserId: string,
  contactId: string,
  conversation: Row,
  prefs: AccountPreferences,
  now: Date,
): Promise<IngestResult['outOfHoursReply'] | undefined> {
  if (!prefs.out_of_hours_enabled) return undefined
  if (isWithinBusinessHours(prefs, now)) return undefined
  const dayStart = startOfLocalDay(now, prefs.business_hours.timezone)
  const lastReplied = conversation.out_of_hours_replied_at
    ? new Date(conversation.out_of_hours_replied_at)
    : null
  if (lastReplied && !Number.isNaN(lastReplied.getTime()) && lastReplied >= dayStart) {
    return undefined
  }

  const stamp = async () => {
    const { error } = await db
      .from('conversations')
      .update({ out_of_hours_replied_at: now.toISOString() })
      .eq('id', conversation.id)
      .eq('account_id', accountId)
    if (error) console.error('[inbound] out_of_hours_replied_at update failed:', error)
    conversation.out_of_hours_replied_at = now.toISOString()
  }

  try {
    await engineSendText({
      accountId,
      userId: ownerUserId,
      conversationId: conversation.id,
      contactId,
      text: prefs.out_of_hours_message,
    })
    await stamp()
    return 'sent'
  } catch (err) {
    if (isOutsideMetaWindowError(err)) {
      console.warn('[inbound] out-of-hours reply skipped (outside Meta window):', conversation.id)
      await stamp()
      return 'skipped'
    }
    console.error('[inbound] out-of-hours reply failed:', err)
    return 'failed'
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
  // A customer writing into a resolved conversation reopens it (same
  // thread, same owner) so it comes back to the open inbox.
  const reopening = conversation.status === 'closed'
  const { error: convError } = await db
    .from('conversations')
    .update({
      last_message_text: contentText || `[${input.type}]`,
      last_message_at: new Date().toISOString(),
      unread_count: (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
      channel,
      ...(reopening ? { status: 'open' } : {}),
    })
    .eq('id', conversation.id)

  if (convError) {
    console.error('[inbound] error updating conversation:', convError)
  }
  const reopened = reopening && !convError
  if (reopened) {
    const { error: evErr } = await db.from('conversation_events').insert({
      account_id: accountId,
      conversation_id: conversation.id,
      actor_user_id: null,
      event_type: 'status_changed',
      payload: { status: 'open', previous_status: 'closed', source: 'customer_message' },
    })
    if (evErr) console.error('[inbound] reopen event insert failed:', evErr)
  }

  // The customer answered: follow-ups parked with "cancel if the
  // customer replies" stop here (migration 048), before this message
  // can schedule new ones.
  await cancelWaitsOnCustomerReply(conversation.id)

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

  // Availability features (spec round 2 §2): round-robin the first
  // customer message of an ownerless conversation, and answer outside
  // business hours. Both read the same preferences row.
  const prefs = await loadAccountPreferences(db, accountId)
  const autoAssignedTo = await autoAssignIfEnabled(
    db,
    accountId,
    conversation,
    prefs,
    isFirstInboundMessage,
  )
  const outOfHoursReply = optedOut
    ? undefined
    : await replyOutOfHoursIfNeeded(
        db,
        accountId,
        ownerUserId,
        contact.id,
        conversation,
        prefs,
        new Date(),
      )

  // Browser push (spec round 2 §5a): the assignee, or every available
  // agent+ when unassigned; whoever has the thread open is skipped.
  // Fire-and-forget — never delays the transport's 200 OK.
  if (isPushConfigured()) {
    void notifyInboundMessage(db, {
      accountId,
      conversationId: conversation.id,
      assigneeUserId: (conversation.assigned_agent_id as string | null) ?? null,
      contactName: (contact.name as string | null) || senderPhone,
      preview: contentText || `[${input.type}]`,
    })
  }

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
  // Auto-assign and reopen were written to `conversations` above; the
  // table trigger queued conversation_assigned / conversation_reopened
  // (migration 048). Drain this account now instead of waiting for the
  // cron minute. Fire-and-forget like the dispatches above.
  if (autoAssignedTo || reopened) {
    drainAutomationEvents({ accountId }).catch((err) =>
      console.error('[automations] event drain failed:', err),
    )
  }

  return {
    ok: true,
    contactId: contact.id,
    conversationId: conversation.id,
    contactCreated: contactOutcome.wasCreated,
    optedOut,
    ...(autoAssignedTo ? { autoAssignedTo } : {}),
    ...(outOfHoursReply ? { outOfHoursReply } : {}),
    ...(reopened ? { reopened } : {}),
  }
}
