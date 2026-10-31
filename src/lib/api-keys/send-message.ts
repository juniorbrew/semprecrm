import type { SupabaseClient } from '@supabase/supabase-js'

import { engineSendText } from '@/lib/automations/meta-send'
import { MetaApiError } from '@/lib/whatsapp/meta-api'
import { GatewayNotConfiguredError, GatewayRequestError, GatewayUnreachableError } from '@/lib/whatsapp/qr-gateway'
import { accountHasModule, loadAccountEntitlements } from '@/lib/plans-server'
import { ACCOUNT_BLOCKED_MESSAGE, READ_ONLY_MESSAGES, readOnlyReason } from '@/lib/billing/read-only'
import {
  findOrCreateContact,
  findOrCreateConversation,
  listContactConversations,
  pickActiveConversation,
} from '@/lib/whatsapp/inbound'
import { isValidE164, sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils'
import { MESSAGING_LABEL, messagingModule } from '@/lib/meta-messaging/channels'
import { engineSendMessaging } from '@/lib/meta-messaging/engine-send'
import { isWithinMessagingWindow } from '@/lib/meta-messaging/manual-send'
import { MessagingSkipError, type MessagingSkipCode } from '@/lib/meta-messaging/skip'
import type { ConversationChannel, MetaMessagingChannel, WhatsAppChannel } from '@/types'

export const MAX_TEXT_LENGTH = 4096
const REFUSAL_STATUSES = new Set([400, 401, 403, 404, 422])

export class ApiSendError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    /** True when the message may already have left (idempotent replays must not re-send it). */
    public maybeSent = false,
  ) {
    super(message)
    this.name = 'ApiSendError'
  }
}

export interface ApiSendInput {
  accountId: string
  to: unknown
  text: unknown
  channel?: unknown
  /** Idempotency claim id: stored on the message row so a crashed send can be matched exactly. */
  claimId?: string
  /**
   * Called right before the provider request starts, with where the message will land.
   * Idempotent requests persist it so a crash mid-send can be resolved later.
   */
  onBeforeSend?: (info: { conversationId: string; contactId: string; channel: ConversationChannel }) => Promise<void>
}

export interface ApiSendResult {
  /** The SempreCRM message id; null only if the row could not be read back right after the send. */
  message_id: string | null
  conversation_id: string
  contact_id: string
  channel: ConversationChannel
  whatsapp_message_id: string
}

/** The account's owner (sender-of-record), after refusing read-only / blocked accounts BEFORE anything is created. */
async function guardAccount(db: SupabaseClient, accountId: string): Promise<string> {
  const { data: account } = await db.from('accounts').select('owner_user_id').eq('id', accountId).maybeSingle()
  const owner = account?.owner_user_id as string | undefined
  if (!owner) throw new ApiSendError(500, 'internal_error', 'Account not found.')
  const ent = await loadAccountEntitlements(db, accountId)
  const readOnly = readOnlyReason(ent)
  if (readOnly) throw new ApiSendError(402, 'read_only', READ_ONLY_MESSAGES[readOnly])
  if (!ent || ent.blocked) throw new ApiSendError(403, 'account_blocked', ACCOUNT_BLOCKED_MESSAGE)
  return owner
}

const MESSAGING_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/
const IDENTITY_COLUMN = { instagram: 'instagram_id', messenger: 'messenger_id' } as const
/** MessagingSkipError code → API status. Nothing was sent in any of these. */
const SKIP_STATUS: Record<MessagingSkipCode, number> = {
  window_closed: 409,
  module_off: 403,
  channel_not_connected: 422,
  channel_expired: 422,
  permission_denied: 422,
  template_unsupported: 422,
  text_too_long: 400,
  contact_identity_missing: 422,
}

/**
 * Instagram / Messenger through the public API: `to` is the customer's Instagram-scoped / Page-scoped
 * id (the `contact.instagram_id` / `messenger_id` the CRM already has) and the contact must have an
 * open conversation on that channel — Meta only lets a business answer, inside 24 h of the customer's
 * last message, so a new conversation can never be started from here.
 */
async function sendMessagingViaApi(
  db: SupabaseClient,
  input: ApiSendInput,
  kind: MetaMessagingChannel,
  text: string,
): Promise<ApiSendResult> {
  if (typeof input.to !== 'string' || !MESSAGING_ID_RE.test(input.to)) {
    throw new ApiSendError(400, 'invalid_recipient', `"to" must be the customer's ${MESSAGING_LABEL[kind]} id (contact.${IDENTITY_COLUMN[kind]}).`)
  }
  await guardAccount(db, input.accountId)
  if (!(await accountHasModule(db, input.accountId, messagingModule(kind)))) {
    throw new ApiSendError(403, 'module_not_included', `The ${MESSAGING_LABEL[kind]} channel is not available on this account plan.`)
  }
  const { data: contact } = await db
    .from('contacts')
    .select('id, opted_out_at, anonymized_at')
    .eq('account_id', input.accountId)
    .eq(IDENTITY_COLUMN[kind], input.to)
    .is('anonymized_at', null)
    .maybeSingle()
  if (!contact) throw new ApiSendError(404, 'contact_not_found', `No ${MESSAGING_LABEL[kind]} contact with this id. The customer has to write first.`)
  if (contact.opted_out_at) throw new ApiSendError(403, 'contact_opted_out', 'This contact asked not to receive messages.')

  const rows = await listContactConversations(db, input.accountId, contact.id as string)
  if (!rows) throw new ApiSendError(500, 'internal_error', 'Could not resolve the conversation.')
  const conversation = pickActiveConversation(rows)
  if (!conversation || conversation.channel !== kind) {
    throw new ApiSendError(409, 'no_open_conversation', `There is no open ${MESSAGING_LABEL[kind]} conversation with this contact. The customer has to write first.`)
  }
  if (!isWithinMessagingWindow(conversation.last_customer_message_at as string | null)) {
    throw new ApiSendError(409, 'window_closed', `The 24-hour ${MESSAGING_LABEL[kind]} window is closed: you can only reply within 24 hours of the customer's last message. Nothing was sent.`)
  }

  await input.onBeforeSend?.({ conversationId: conversation.id as string, contactId: contact.id as string, channel: kind })
  let mid: string
  try {
    mid = (
      await engineSendMessaging(db, {
        accountId: input.accountId,
        conversationId: conversation.id as string,
        contactId: contact.id as string,
        content: { kind: 'text', text },
        origin: 'api',
        apiRequestId: input.claimId,
      })
    ).whatsapp_message_id
  } catch (err) {
    if (err instanceof MessagingSkipError) {
      throw new ApiSendError(SKIP_STATUS[err.code], err.code, `${err.message} Nothing was sent.`)
    }
    console.error('[api-v1] messaging send failed:', err instanceof Error ? err.message : err)
    throw classifySendFailure(err)
  }
  const { data: row } = await db.from('messages').select('id').eq('conversation_id', conversation.id).eq('message_id', mid).maybeSingle()
  return {
    message_id: (row?.id as string | undefined) ?? null,
    conversation_id: conversation.id as string,
    contact_id: contact.id as string,
    channel: kind,
    whatsapp_message_id: mid,
  }
}

/**
 * Public API send: resolves (or creates) the contact and the live
 * conversation exactly like an inbound message would, then delegates to the
 * engine sender, the same path automations use, which handles official vs QR,
 * phone variants, persistence (origin 'api') and the conversation preview.
 */
export async function sendTextViaApi(db: SupabaseClient, input: ApiSendInput): Promise<ApiSendResult> {
  if (typeof input.text !== 'string' || input.text.trim().length === 0) {
    throw new ApiSendError(400, 'invalid_text', '"text" is required and must be a non-empty string.')
  }
  if (input.text.length > MAX_TEXT_LENGTH) {
    throw new ApiSendError(400, 'invalid_text', `"text" can have at most ${MAX_TEXT_LENGTH} characters.`)
  }
  if (input.channel === 'instagram' || input.channel === 'messenger') {
    return sendMessagingViaApi(db, input, input.channel, input.text)
  }
  if (typeof input.to !== 'string') {
    throw new ApiSendError(400, 'invalid_phone', '"to" is required: the phone in international format, e.g. 5511999990000.')
  }
  const phone = sanitizePhoneForMeta(input.to)
  if (!isValidE164(phone)) {
    throw new ApiSendError(400, 'invalid_phone', '"to" must be a valid phone in international format, e.g. 5511999990000.')
  }
  let requested: WhatsAppChannel | null = null
  if (input.channel !== undefined && input.channel !== null) {
    if (input.channel !== 'official' && input.channel !== 'qr') {
      throw new ApiSendError(400, 'invalid_channel', '"channel" must be "official", "qr", "instagram" or "messenger".')
    }
    requested = input.channel
  }

  const owner = await guardAccount(db, input.accountId)

  const outcome = await findOrCreateContact(db, input.accountId, owner, phone, '')
  if (!outcome) throw new ApiSendError(500, 'internal_error', 'Could not resolve the contact.')
  if (outcome.contact.opted_out_at) {
    throw new ApiSendError(403, 'contact_opted_out', 'This contact asked not to receive messages.')
  }

  const rows = await listContactConversations(db, input.accountId, outcome.contact.id)
  if (!rows) throw new ApiSendError(500, 'internal_error', 'Could not resolve the conversation.')
  const active = pickActiveConversation(rows)

  let channel: WhatsAppChannel
  if (active) {
    // The API sends by phone, over WhatsApp only: never into an Instagram / Messenger conversation.
    if (active.channel === 'instagram' || active.channel === 'messenger') {
      throw new ApiSendError(409, 'channel_conflict', `This contact has an open conversation on the "${active.channel}" channel, which the API cannot send on.`)
    }
    channel = active.channel === 'qr' ? 'qr' : 'official'
    if (requested && requested !== channel) {
      throw new ApiSendError(409, 'channel_conflict', `This contact has an open conversation on the "${channel}" channel.`)
    }
  } else if (requested) {
    channel = requested
  } else {
    const { data: cfg } = await db.from('whatsapp_config').select('id').eq('account_id', input.accountId).maybeSingle()
    channel = cfg ? 'official' : 'qr'
  }

  // Plan gate (also false for blocked accounts): the channel used must be part of the plan.
  if (!(await accountHasModule(db, input.accountId, channel === 'qr' ? 'channel_qr' : 'channel_official'))) {
    throw new ApiSendError(403, 'module_not_included', 'The WhatsApp channel used for this message is not available on this account plan.')
  }

  const conv = await findOrCreateConversation(db, input.accountId, owner, outcome.contact.id, channel, rows)
  if (!conv) throw new ApiSendError(500, 'internal_error', 'Could not open the conversation.')

  await input.onBeforeSend?.({ conversationId: conv.conversation.id, contactId: outcome.contact.id, channel })

  // From here on the provider may already have the message. Only errors that are KNOWN to
  // happen before anything left are "not sent" (retryable); everything else is "unknown".
  let waId: string
  try {
    const sent = await engineSendText({
      accountId: input.accountId,
      userId: owner,
      conversationId: conv.conversation.id,
      contactId: outcome.contact.id,
      text: input.text,
      origin: 'api',
      apiRequestId: input.claimId,
    })
    waId = sent.whatsapp_message_id
  } catch (err) {
    console.error('[api-v1] send failed:', err instanceof Error ? err.message : err)
    throw classifySendFailure(err)
  }

  const { data: row } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conv.conversation.id)
    .eq('message_id', waId)
    .maybeSingle()

  return {
    message_id: (row?.id as string | undefined) ?? null,
    conversation_id: conv.conversation.id,
    contact_id: outcome.contact.id,
    channel,
    whatsapp_message_id: waId,
  }
}

/**
 * Sorts a failure raised by the engine sender. Retryable ("not sent") only when the
 * failure is known to precede the provider accepting anything: our own validation, a
 * missing / disconnected channel, a gateway 4xx the gateway documents as pre-send, or
 * a Meta 4xx (a confirmed rejection). A timeout, socket reset, 5xx, unreadable 2xx or
 * a failure while recording the message may all happen AFTER the provider took the
 * message, so they are `send_unknown` / `send_unconfirmed` and flagged maybeSent.
 */
export function classifySendFailure(err: unknown): ApiSendError {
  const msg = err instanceof Error ? err.message : String(err)
  if (/but DB insert failed/i.test(msg)) {
    return new ApiSendError(502, 'send_unconfirmed', 'The message was sent but could not be recorded. Do not resend it.', true)
  }
  if (err instanceof GatewayNotConfiguredError || /^WhatsApp not configured/i.test(msg)) {
    return new ApiSendError(422, 'channel_not_configured', 'WhatsApp is not connected on this channel.')
  }
  if (err instanceof GatewayRequestError) {
    if (err.code === 'not_connected') {
      return new ApiSendError(422, 'channel_not_connected', 'The WhatsApp QR session is disconnected. Reconnect it in Settings.')
    }
    if (err.code === 'not_on_whatsapp') {
      return new ApiSendError(422, 'not_on_whatsapp', 'This number is not on WhatsApp.')
    }
    if (err.code === 'throttled') {
      // The gateway's anti-ban queue refuses BEFORE sending (see send-queue.ts): nothing left.
      return new ApiSendError(429, 'send_queue_full', 'The WhatsApp send queue for this number is full. Nothing was sent; retry in about a minute.')
    }
    if (err.code === 'invalid_request') {
      return new ApiSendError(422, 'send_rejected', 'The WhatsApp gateway rejected the request.')
    }
  }
  if (err instanceof GatewayUnreachableError && (err.status === 401 || err.status === 403)) {
    return new ApiSendError(502, 'send_failed', 'The message could not be delivered to WhatsApp.')
  }
  // Only the statuses Meta uses for a validated refusal count as "not sent"; 408, 429 and the
  // rest may be raised by a proxy or after partial processing, so they stay ambiguous.
  if (err instanceof MetaApiError && REFUSAL_STATUSES.has(err.httpStatus)) {
    return new ApiSendError(502, 'send_failed', 'WhatsApp refused the message. Nothing was sent.')
  }
  if (/^(contact not found|contact phone invalid|conversation not found)/i.test(msg)) {
    return new ApiSendError(500, 'internal_error', 'Could not prepare the message. Nothing was sent.')
  }
  return new ApiSendError(
    502,
    'send_unknown',
    'The outcome is unknown: the message may have been delivered. Check the conversation before sending it again.',
    true,
  )
}
