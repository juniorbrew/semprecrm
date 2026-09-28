// Body of the gateway's `/api/channels/qr/inbound` and `/echo` posts
// (services/wa-gateway InboundPayload). Shared so both routes validate
// the same way.

const QR_MESSAGE_TYPES = new Set([
  'text',
  'image',
  'audio',
  'video',
  'document',
  'sticker',
  'location',
])

export interface QrMessageBody {
  accountId: string
  messageId: string
  from: string
  pushName: string | null
  type: string
  text: string | null
  mediaUrl: string | null
  mimeType: string | null
  quotedMessageId: string | null
  timestamp: number | string | null
}

/** Null when a required field is missing or the type is unsupported. */
export function parseQrMessageBody(body: unknown): QrMessageBody | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const accountId = str(b.account_id)
  const messageId = str(b.message_id)
  const from = str(b.from)
  const type = str(b.type)
  if (!accountId || !messageId || !from || !QR_MESSAGE_TYPES.has(type)) return null

  const media =
    b.media && typeof b.media === 'object' ? (b.media as Record<string, unknown>) : null
  const filename = typeof media?.filename === 'string' ? media.filename : null
  const text = typeof b.text === 'string' ? b.text : null
  return {
    accountId,
    messageId,
    from,
    pushName: typeof b.push_name === 'string' ? b.push_name : null,
    type,
    // Documents without a caption show their filename, like the Meta path.
    text: text || (type === 'document' ? filename : null),
    mediaUrl: typeof media?.url === 'string' ? media.url : null,
    mimeType: typeof media?.mimetype === 'string' ? media.mimetype : null,
    quotedMessageId: typeof b.quoted_message_id === 'string' ? b.quoted_message_id : null,
    timestamp:
      typeof b.timestamp === 'number' || typeof b.timestamp === 'string' ? b.timestamp : null,
  }
}
