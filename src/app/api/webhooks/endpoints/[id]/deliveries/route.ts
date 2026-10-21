import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { requireAdmin } from '@/lib/webhooks/admin-guard'
import { eventPublicId } from '@/lib/webhooks/events'

export const dynamic = 'force-dynamic'

const PAGE = 25

/** Delivery log of one endpoint, newest first. `?status=` filters, `?before=<iso>` pages. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin()
  if ('response' in gate) return gate.response
  const { id } = await params
  const url = new URL(request.url)
  const status = url.searchParams.get('status')
  const before = url.searchParams.get('before')

  let q = supabaseAdmin()
    .from('webhook_deliveries')
    .select(
      'id, event_id, status, attempts, next_attempt_at, last_status_code, last_error, last_attempt_at, delivered_at, resend_of, created_at, event:webhook_events(type)',
    )
    .eq('endpoint_id', id)
    .eq('account_id', gate.ctx.accountId)
    .order('created_at', { ascending: false })
    .limit(PAGE + 1)
  if (status === 'pending' || status === 'delivered' || status === 'failed') q = q.eq('status', status)
  if (before && !Number.isNaN(Date.parse(before))) q = q.lt('created_at', before)

  const { data, error } = await q
  if (error) return NextResponse.json({ error: 'Failed to load deliveries' }, { status: 500 })
  const rows = data ?? []
  const page = rows.slice(0, PAGE).map((d) => {
    const ev = d.event as { type?: string } | { type?: string }[] | null
    const type = Array.isArray(ev) ? ev[0]?.type : ev?.type
    const rest: Record<string, unknown> = { ...d }
    delete rest.event
    return { ...rest, event_type: type ?? null, event_public_id: eventPublicId(d.event_id as string) }
  })
  return NextResponse.json({ deliveries: page, has_more: rows.length > PAGE })
}
