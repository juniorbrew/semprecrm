import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { requireAdmin } from '@/lib/webhooks/admin-guard'
import { buildEventBody, queueDelivery, runDispatch } from '@/lib/webhooks/dispatcher'
import { eventPublicId } from '@/lib/webhooks/events'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/** One delivery: the payload we send and every attempt with its HTTP result. */
export async function GET(_request: Request, { params }: Ctx) {
  const gate = await requireAdmin()
  if ('response' in gate) return gate.response
  const { id } = await params
  const db = supabaseAdmin()

  const { data: delivery } = await db
    .from('webhook_deliveries')
    .select('id, event_id, account_id, endpoint_id, status, attempts, next_attempt_at, last_status_code, last_error, created_at')
    .eq('id', id)
    .eq('account_id', gate.ctx.accountId)
    .maybeSingle()
  if (!delivery) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const [{ data: event }, { data: attempts }] = await Promise.all([
    db.from('webhook_events').select('id, type, data, created_at, account_id').eq('id', delivery.event_id).single(),
    db
      .from('webhook_delivery_attempts')
      .select('attempt_no, started_at, duration_ms, status_code, error, response_snippet')
      .eq('delivery_id', id)
      .order('attempt_no'),
  ])
  const payload = event
    ? JSON.parse(
        buildEventBody({
          event_id: event.id,
          event_type: event.type,
          event_data: event.data,
          event_created_at: event.created_at,
          account_id: event.account_id,
        }),
      )
    : null
  return NextResponse.json({
    delivery: { ...delivery, event_public_id: eventPublicId(delivery.event_id) },
    payload,
    attempts: attempts ?? [],
  })
}

/** Manual resend: a fresh delivery of the same event (same event id) to the same endpoint, attempted now. */
export async function POST(_request: Request, { params }: Ctx) {
  const gate = await requireAdmin()
  if ('response' in gate) return gate.response
  const { id } = await params
  const db = supabaseAdmin()

  const { data: source } = await db
    .from('webhook_deliveries')
    .select('event_id, endpoint_id')
    .eq('id', id)
    .eq('account_id', gate.ctx.accountId)
    .maybeSingle()
  if (!source) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const deliveryId = await queueDelivery(db, {
    accountId: gate.ctx.accountId,
    endpointId: source.endpoint_id,
    eventId: source.event_id,
    eventType: '',
    resendOf: id,
  })
  await runDispatch({ db }, { deliveryId })

  const { data: delivery } = await db
    .from('webhook_deliveries')
    .select('id, status, attempts, last_status_code, last_error, last_attempt_at')
    .eq('id', deliveryId)
    .single()
  return NextResponse.json({ delivery })
}
