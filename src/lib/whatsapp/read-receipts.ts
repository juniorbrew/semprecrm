// ============================================================
// Read receipts (blue ✓✓). When an agent has the conversation open, the
// customer's messages are confirmed as read on WhatsApp — through the QR
// gateway or the official Meta API, whichever channel the conversation
// is on. `conversations.read_receipt_at` (migration 049) remembers the
// newest message already confirmed, so repeated opens only send what is
// new.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { decrypt } from './encryption'
import { markMessageRead } from './meta-api'
import { isGatewayConfigured, markReadViaGateway } from './qr-gateway'

/** Newest customer messages considered per call. */
const MAX_MESSAGES = 100

export class ConversationNotFoundError extends Error {
  constructor() {
    super('conversation not found')
    this.name = 'ConversationNotFoundError'
  }
}

export interface ReadReceiptResult {
  /** Messages confirmed as read in this call. */
  sent: number
  /** Why nothing was sent, when nothing was. */
  skipped?: 'nothing_new' | 'gateway_not_configured' | 'official_not_configured' | 'no_phone'
}

export async function sendReadReceipts(
  db: SupabaseClient,
  input: { accountId: string; conversationId: string },
): Promise<ReadReceiptResult> {
  const { data: conv, error: convErr } = await db
    .from('conversations')
    .select('id, channel, contact_id, read_receipt_at')
    .eq('id', input.conversationId)
    .eq('account_id', input.accountId)
    .maybeSingle()
  if (convErr) throw new Error(`conversation lookup failed: ${convErr.message}`)
  if (!conv) throw new ConversationNotFoundError()
  const conversation = conv as {
    id: string
    channel: string | null
    contact_id: string
    read_receipt_at: string | null
  }

  let query = db
    .from('messages')
    .select('message_id, created_at')
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
    .not('message_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(MAX_MESSAGES)
  if (conversation.read_receipt_at) query = query.gt('created_at', conversation.read_receipt_at)
  const { data: rows, error: msgErr } = await query
  if (msgErr) throw new Error(`messages lookup failed: ${msgErr.message}`)
  const unread = (rows ?? []) as { message_id: string; created_at: string }[]
  if (unread.length === 0) return { sent: 0, skipped: 'nothing_new' }

  const newest = unread[0]

  if (conversation.channel === 'qr') {
    if (!isGatewayConfigured()) return { sent: 0, skipped: 'gateway_not_configured' }
    const { data: contact } = await db
      .from('contacts')
      .select('phone')
      .eq('id', conversation.contact_id)
      .eq('account_id', input.accountId)
      .maybeSingle()
    const phone = String((contact as { phone?: string | null } | null)?.phone ?? '').replace(/\D/g, '')
    if (!phone) return { sent: 0, skipped: 'no_phone' }
    await markReadViaGateway({
      accountId: input.accountId,
      to: phone,
      // oldest first, like the customer sent them
      messageIds: unread.map((m) => m.message_id).reverse(),
    })
  } else {
    const { data: config } = await db
      .from('whatsapp_config')
      .select('phone_number_id, access_token')
      .eq('account_id', input.accountId)
      .maybeSingle()
    const cfg = config as { phone_number_id?: string; access_token?: string } | null
    if (!cfg?.phone_number_id || !cfg.access_token) return { sent: 0, skipped: 'official_not_configured' }
    // Marking the newest one marks everything before it as read.
    await markMessageRead({
      phoneNumberId: cfg.phone_number_id,
      accessToken: decrypt(cfg.access_token),
      messageId: newest.message_id,
    })
  }

  const { error: updErr } = await db
    .from('conversations')
    .update({ read_receipt_at: newest.created_at })
    .eq('id', conversation.id)
    .eq('account_id', input.accountId)
  if (updErr) console.error('[read-receipts] could not store read_receipt_at:', updErr.message)

  return { sent: unread.length }
}
