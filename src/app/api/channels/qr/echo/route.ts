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
 * push. Idempotent on `message_id`. Only for contacts that already have
 * a conversation (personal chats answer 200 `{ skipped }`). A DB
 * failure answers 503 so the gateway retries.
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
    // Transient (DB) failure: 5xx so the gateway's queue retries with
    // backoff. Invalid payloads are the only 4xx.
    return NextResponse.json({ ok: false, reason: result.reason }, { status: 503 })
  }
  return NextResponse.json({
    ok: true,
    duplicate: !!result.duplicate,
    ...(result.skipped ? { skipped: result.skipped } : {}),
    conversation_id: result.conversationId ?? null,
  })
}
