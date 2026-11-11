import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { requireWritableCapiAdmin } from '@/lib/meta-capi/guard'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** "Tentar de novo": a failed event goes back to the queue with a fresh 5-attempt, 24 h window. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireWritableCapiAdmin()
  if ('response' in gate) return gate.response
  const { id } = await params
  if (!UUID.test(id)) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  const { data, error } = await supabaseAdmin()
    .from('meta_capi_events')
    .update({
      status: 'pending',
      attempts: 0,
      last_error: null,
      claimed_until: null,
      next_attempt_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
    })
    .eq('id', id)
    .eq('account_id', gate.ctx.accountId)
    .eq('status', 'failed')
    .select('id')
  if (error) return NextResponse.json({ error: 'Failed to retry the event' }, { status: 500 })
  if (!data || data.length === 0) return NextResponse.json({ error: 'Only a failed event can be retried' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
