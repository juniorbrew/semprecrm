import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { ingestPhoneEcho } from '@/lib/whatsapp/phone-echo'
import { isGatewayRequest } from '@/lib/whatsapp/qr-gateway'
import { parseQrMessageBody } from '@/lib/whatsapp/qr-inbound-body'

/**
 * POST /api/channels/qr/echo  (gateway → app)
 *
 * A message the account sent from the connected phone, WhatsApp Web or
 * another linked device. Same body as `/inbound`; `from` is the
 * CUSTOMER's phone (the conversation), `push_name` is empty.
 *
 * Stored as an outbound "Celular" row (lib/whatsapp/phone-echo) — never
 * as customer activity: no unread, no reopen, no flows / automations /
 * push. Idempotent on `message_id`.
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

  const result = await ingestPhoneEcho(
    {
      accountId: parsed.accountId,
      from: parsed.from,
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
    // 422 (not 5xx), same as /inbound: the gateway drops it instead of
    // retrying forever on a message we cannot place.
    return NextResponse.json({ ok: false, reason: result.reason }, { status: 422 })
  }
  return NextResponse.json({
    ok: true,
    duplicate: !!result.duplicate,
    conversation_id: result.conversationId,
  })
}
