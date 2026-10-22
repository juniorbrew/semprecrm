import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { applyCustomerReaction } from '@/lib/whatsapp/phone-echo'
import { isGatewayRequest } from '@/lib/whatsapp/qr-gateway'

/**
 * POST /api/channels/qr/reaction  (gateway → app)
 *
 * Body: `{ account_id, message_id, from, emoji, timestamp }` — the
 * customer `from` reacted with `emoji` ("" = removed) to the message
 * `message_id`. A message we never stored answers 200 `{ found: false }`
 * so the gateway does not retry.
 */
export async function POST(request: Request) {
  if (!isGatewayRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const accountId = typeof body.account_id === 'string' ? body.account_id : ''
  const messageId = typeof body.message_id === 'string' ? body.message_id : ''
  const from = typeof body.from === 'string' ? body.from : ''
  const emoji = typeof body.emoji === 'string' ? body.emoji : null
  if (!accountId || !messageId || !from || emoji === null || emoji.length > 32) {
    return NextResponse.json(
      { error: 'account_id, message_id, from and emoji are required' },
      { status: 400 },
    )
  }

  const result = await applyCustomerReaction({ accountId, messageId, from, emoji }, supabaseAdmin())
  if (!result.ok) {
    return NextResponse.json({ error: 'Failed to store reaction' }, { status: 503 })
  }
  return NextResponse.json({ ok: true, found: result.found })
}
