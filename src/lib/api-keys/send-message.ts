import type { SupabaseClient } from '@supabase/supabase-js'

import { engineSendText } from '@/lib/automations/meta-send'
import { accountHasModule } from '@/lib/plans-server'
import {
  findOrCreateContact,
  findOrCreateConversation,
  listContactConversations,
  pickActiveConversation,
} from '@/lib/whatsapp/inbound'
import { isValidE164, sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils'
import type { WhatsAppChannel } from '@/types'

export const MAX_TEXT_LENGTH = 4096

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
}

export interface ApiSendResult {
  message_id: string
  conversation_id: string
  contact_id: string
  channel: WhatsAppChannel
  whatsapp_message_id: string
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
      throw new ApiSendError(400, 'invalid_channel', '"channel" must be "official" or "qr".')
    }
    requested = input.channel
  }

  const { data: account } = await db.from('accounts').select('owner_user_id').eq('id', input.accountId).maybeSingle()
  const owner = account?.owner_user_id as string | undefined
  if (!owner) throw new ApiSendError(500, 'internal_error', 'Account not found.')

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

  let waId: string
  try {
    const sent = await engineSendText({
      accountId: input.accountId,
      userId: owner,
      conversationId: conv.conversation.id,
      contactId: outcome.contact.id,
      text: input.text,
      origin: 'api',
    })
    waId = sent.whatsapp_message_id
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[api-v1] send failed:', msg)
    // "sent to Meta / via gateway but DB insert failed": the customer got it.
    if (/but DB insert failed/i.test(msg)) {
      throw new ApiSendError(502, 'send_unconfirmed', 'The message was sent but could not be recorded. Do not resend it.', true)
    }
    if (/not configured/i.test(msg)) {
      throw new ApiSendError(422, 'channel_not_configured', 'WhatsApp is not connected on this channel.')
    }
    throw new ApiSendError(502, 'send_failed', 'The message could not be delivered to WhatsApp.')
  }

  const { data: row } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conv.conversation.id)
    .eq('message_id', waId)
    .maybeSingle()

  return {
    message_id: (row?.id as string | undefined) ?? '',
    conversation_id: conv.conversation.id,
    contact_id: outcome.contact.id,
    channel,
    whatsapp_message_id: waId,
  }
}
