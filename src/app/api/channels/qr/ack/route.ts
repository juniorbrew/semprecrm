import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { isMessageAckStatus, statusesBefore } from '@/lib/whatsapp/message-status-ladder'
import { isGatewayRequest } from '@/lib/whatsapp/qr-gateway'

/**
 * POST /api/channels/qr/ack  (gateway → app)
 *
 * Body: `{ account_id, message_id, status: sent|delivered|read }`.
 * Mirrors the delivery receipt onto `messages.status` for the row
 * with that provider id on the QR channel — forward-only: receipts
 * arrive out of order (the `sender` receipt from our own phone lands
 * after the contact's delivery receipt), so the update is filtered to
 * rows whose current status is below the incoming one.
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
  const status = body.status
  if (!accountId || !messageId || !isMessageAckStatus(status)) {
    return NextResponse.json(
      { error: 'account_id, message_id and a valid status are required' },
      { status: 400 },
    )
  }

  const { error } = await supabaseAdmin()
    .from('messages')
    .update({ status })
    .eq('message_id', messageId)
    .eq('channel', 'qr')
    .in('status', statusesBefore(status))

  if (error) {
    console.error('[channels/qr/ack] update failed:', error.message)
    return NextResponse.json({ error: 'Failed to update message status' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
