import { NextResponse, after } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { ingestInboundMessage } from '@/lib/whatsapp/inbound'
import { fetchContactAvatarViaGateway, isGatewayRequest } from '@/lib/whatsapp/qr-gateway'
import { refreshContactAvatar } from '@/lib/whatsapp/contact-avatar'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { parseQrMessageBody } from '@/lib/whatsapp/qr-inbound-body'
import { kickAutoReplies } from '@/lib/ai/auto-reply-runtime'

/**
 * POST /api/channels/qr/inbound  (gateway → app)
 *
 * Body: `{ account_id, message_id, from, push_name, timestamp, type,
 * text?, media?: { url, mimetype, filename? }, quoted_message_id? }`.
 * Media is already in the `chat-media` bucket — `media.url` is public.
 *
 * Runs the shared ingestion pipeline with `channel: 'qr'`. After the
 * response, fills the contact's profile photo when it was never
 * checked or is older than a week (lib/whatsapp/contact-avatar).
 */
export async function POST(request: Request) {
  if (!isGatewayRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = parseQrMessageBody(body)
  if (!parsed) {
    return NextResponse.json(
      { error: 'account_id, message_id, from and a supported type are required' },
      { status: 400 },
    )
  }
  const { accountId, from } = parsed

  const result = await ingestInboundMessage(
    {
      accountId,
      channel: 'qr',
      from,
      pushName: parsed.pushName,
      messageId: parsed.messageId,
      type: parsed.type,
      text: parsed.text,
      mediaUrl: parsed.mediaUrl,
      mimeType: parsed.mimeType,
      quotedMessageId: parsed.quotedMessageId,
      timestamp: parsed.timestamp,
    },
    supabaseAdmin(),
  )

  if (!result.ok) {
    // 422 (not 5xx) so the gateway does not retry forever on a message
    // we cannot place (unknown account, no owner...).
    return NextResponse.json({ ok: false, reason: result.reason }, { status: 422 })
  }

  // Profile photo, off the response path: the gateway answers only after
  // its per-account queue reaches this lookup. The claim inside
  // `refreshContactAvatar` makes redeliveries / bursts a no-op.
  const contactId = result.contactId
  if (contactId && result.reason !== 'duplicate') {
    after(() =>
      refreshContactAvatar(
        supabaseAdmin(),
        { accountId, contactId, phone: normalizePhone(from) },
        fetchContactAvatarViaGateway,
      ).then(() => undefined),
    )
  }
  // Automatic reply: drain once the debounce window has passed (the
  // cron catches anything this misses).
  if (result.aiReplyQueued) after(kickAutoReplies)
  return NextResponse.json({
    ok: true,
    duplicate: result.reason === 'duplicate',
    conversation_id: result.conversationId,
  })
}
