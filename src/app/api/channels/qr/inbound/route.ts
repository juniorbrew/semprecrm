import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { ingestInboundMessage } from '@/lib/whatsapp/inbound'
import { isGatewayRequest } from '@/lib/whatsapp/qr-gateway'

const INBOUND_TYPES = new Set([
  'text',
  'image',
  'audio',
  'video',
  'document',
  'sticker',
  'location',
])

interface InboundBody {
  account_id?: unknown
  message_id?: unknown
  from?: unknown
  push_name?: unknown
  timestamp?: unknown
  type?: unknown
  text?: unknown
  media?: { url?: unknown; mimetype?: unknown; filename?: unknown } | null
  quoted_message_id?: unknown
}

/**
 * POST /api/channels/qr/inbound  (gateway → app)
 *
 * Body: `{ account_id, message_id, from, push_name, timestamp, type,
 * text?, media?: { url, mimetype, filename? }, quoted_message_id? }`.
 * Media is already in the `chat-media` bucket — `media.url` is public.
 *
 * Runs the shared ingestion pipeline with `channel: 'qr'`.
 */
export async function POST(request: Request) {
  if (!isGatewayRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: InboundBody
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const accountId = typeof body.account_id === 'string' ? body.account_id : ''
  const messageId = typeof body.message_id === 'string' ? body.message_id : ''
  const from = typeof body.from === 'string' ? body.from : ''
  const type = typeof body.type === 'string' ? body.type : ''
  if (!accountId || !messageId || !from || !INBOUND_TYPES.has(type)) {
    return NextResponse.json(
      { error: 'account_id, message_id, from and a supported type are required' },
      { status: 400 },
    )
  }

  const media = body.media && typeof body.media === 'object' ? body.media : null
  const mediaUrl = typeof media?.url === 'string' ? media.url : null
  const mimeType = typeof media?.mimetype === 'string' ? media.mimetype : null
  const filename = typeof media?.filename === 'string' ? media.filename : null
  const text = typeof body.text === 'string' ? body.text : null

  const result = await ingestInboundMessage(
    {
      accountId,
      channel: 'qr',
      from,
      pushName: typeof body.push_name === 'string' ? body.push_name : null,
      messageId,
      type,
      // Documents without a caption show their filename, like the Meta path.
      text: text || (type === 'document' ? filename : null),
      mediaUrl,
      mimeType,
      quotedMessageId:
        typeof body.quoted_message_id === 'string' ? body.quoted_message_id : null,
      timestamp:
        typeof body.timestamp === 'number' || typeof body.timestamp === 'string'
          ? body.timestamp
          : null,
    },
    supabaseAdmin(),
  )

  if (!result.ok) {
    // 422 (not 5xx) so the gateway does not retry forever on a message
    // we cannot place (unknown account, no owner...).
    return NextResponse.json({ ok: false, reason: result.reason }, { status: 422 })
  }
  return NextResponse.json({
    ok: true,
    duplicate: result.reason === 'duplicate',
    conversation_id: result.conversationId,
  })
}
