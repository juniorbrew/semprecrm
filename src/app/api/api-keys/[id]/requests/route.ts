import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { requireAdmin } from '@/lib/webhooks/admin-guard'

export const dynamic = 'force-dynamic'

/** The last 50 authenticated requests made with this key (time, route, status, IP). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin()
  if ('response' in gate) return gate.response
  const { id } = await params
  const { data, error } = await supabaseAdmin()
    .from('api_request_log')
    .select('at, method, route, status, ip')
    .eq('key_id', id)
    .eq('account_id', gate.ctx.accountId)
    .order('at', { ascending: false })
    .limit(50)
  if (error) return NextResponse.json({ error: 'Failed to load the request log' }, { status: 500 })
  return NextResponse.json({ requests: data ?? [] })
}
