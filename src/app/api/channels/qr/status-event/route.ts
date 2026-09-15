import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { isGatewayRequest, isSessionStatus } from '@/lib/whatsapp/qr-gateway'
import { upsertQrSession } from '@/lib/whatsapp/qr-session'

/**
 * POST /api/channels/qr/status-event  (gateway → app)
 *
 * Body: `{ account_id, status, phone?, name?, error? }` on every
 * session change. Authenticated only by `x-gateway-secret`; writes
 * with the service role.
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
  if (!accountId || !isSessionStatus(body.status)) {
    return NextResponse.json(
      { error: 'account_id and a valid status are required' },
      { status: 400 },
    )
  }

  const session = await upsertQrSession(supabaseAdmin(), accountId, {
    status: body.status,
    phone_number: typeof body.phone === 'string' ? body.phone : null,
    display_name: typeof body.name === 'string' ? body.name : null,
    last_error: typeof body.error === 'string' && body.error ? body.error : null,
  })

  if (!session) {
    return NextResponse.json({ error: 'Failed to store session status' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
