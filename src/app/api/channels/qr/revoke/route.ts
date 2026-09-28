import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { markMessageRevoked } from '@/lib/whatsapp/phone-echo'
import { isGatewayRequest } from '@/lib/whatsapp/qr-gateway'

/**
 * POST /api/channels/qr/revoke  (gateway → app)
 *
 * Body: `{ account_id, message_id, from, revoked_by: customer|phone,
 * timestamp }` — `message_id` is the id of the DELETED message, `from`
 * the customer's phone. Marks the stored row (revoked_at / revoked_by,
 * migration 059); the row and its content are never deleted. A message
 * we never stored answers 200 `{ found: false }` so the gateway does
 * not retry.
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
  const revokedBy = body.revoked_by
  if (!accountId || !messageId || !from || (revokedBy !== 'customer' && revokedBy !== 'phone')) {
    return NextResponse.json(
      { error: 'account_id, message_id, from and revoked_by are required' },
      { status: 400 },
    )
  }

  const result = await markMessageRevoked(
    {
      accountId,
      messageId,
      from,
      revokedBy,
      timestamp:
        typeof body.timestamp === 'number' || typeof body.timestamp === 'string'
          ? body.timestamp
          : null,
    },
    supabaseAdmin(),
  )
  if (!result.ok) {
    return NextResponse.json({ error: 'Failed to mark message as deleted' }, { status: 503 })
  }
  return NextResponse.json({ ok: true, found: result.found })
}
