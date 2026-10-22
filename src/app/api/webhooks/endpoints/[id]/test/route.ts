import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { requireAdmin } from '@/lib/webhooks/admin-guard'
import { queueDelivery, runDispatch } from '@/lib/webhooks/dispatcher'
import { WEBHOOK_TEST_EVENT } from '@/lib/webhooks/events'

export const dynamic = 'force-dynamic'

/** Sends a signed `webhook.test` event to this endpoint right now and returns the result. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin()
  if ('response' in gate) return gate.response
  const { id } = await params
  const db = supabaseAdmin()

  const { data: endpoint } = await db
    .from('webhook_endpoints')
    .select('id, enabled')
    .eq('id', id)
    .eq('account_id', gate.ctx.accountId)
    .maybeSingle()
  if (!endpoint) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!endpoint.enabled) return NextResponse.json({ error: 'Enable the endpoint first' }, { status: 409 })

  const deliveryId = await queueDelivery(db, {
    accountId: gate.ctx.accountId,
    endpointId: id,
    eventType: WEBHOOK_TEST_EVENT,
    data: { message: 'This is a test event from SempreCRM.' },
  })
  await runDispatch({ db }, { deliveryId })

  const { data: delivery } = await db
    .from('webhook_deliveries')
    .select('id, status, attempts, last_status_code, last_error, last_attempt_at')
    .eq('id', deliveryId)
    .single()
  return NextResponse.json({ delivery })
}
