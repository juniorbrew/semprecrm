// read-only: allowed (settings: webhook endpoint management stays available, owner decision)
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { encrypt } from '@/lib/whatsapp/encryption'
import { requireAdmin } from '@/lib/webhooks/admin-guard'
import { validateEndpointUrl } from '@/lib/webhooks/endpoint-url'
import { ENDPOINT_COLUMNS } from '@/lib/webhooks/columns'
import { MAX_ENDPOINTS } from '@/lib/webhooks/limits'
import { normalizeEvents } from '@/lib/webhooks/events'
import { generateWebhookSecret } from '@/lib/webhooks/signing'

export const dynamic = 'force-dynamic'


export async function GET() {
  const gate = await requireAdmin()
  if ('response' in gate) return gate.response
  const { data, error } = await supabaseAdmin()
    .from('webhook_endpoints')
    .select(ENDPOINT_COLUMNS)
    .eq('account_id', gate.ctx.accountId)
    .order('created_at', { ascending: false })
  if (error) return NextResponse.json({ error: 'Failed to load webhook endpoints' }, { status: 500 })
  return NextResponse.json({ endpoints: data ?? [] })
}

export async function POST(request: Request) {
  const gate = await requireAdmin()
  if ('response' in gate) return gate.response
  const { ctx } = gate

  const body = (await request.json().catch(() => null)) as
    | { url?: unknown; description?: unknown; events?: unknown }
    | null
  const url = await validateEndpointUrl(body?.url)
  if (!url.ok) return NextResponse.json({ error: url.error }, { status: 400 })
  const events = normalizeEvents(body?.events)
  if (!events) return NextResponse.json({ error: 'Pick at least one event' }, { status: 400 })
  const description =
    typeof body?.description === 'string' && body.description.trim() ? body.description.trim().slice(0, 200) : null

  const db = supabaseAdmin()
  const { count } = await db
    .from('webhook_endpoints')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', ctx.accountId)
  if ((count ?? 0) >= MAX_ENDPOINTS) {
    return NextResponse.json({ error: 'Endpoint limit reached. Delete one first' }, { status: 409 })
  }

  const secret = generateWebhookSecret()
  const { data, error } = await db
    .from('webhook_endpoints')
    .insert({
      account_id: ctx.accountId,
      url: url.url,
      description,
      events,
      secret_enc: encrypt(secret),
      created_by: ctx.userId,
    })
    .select(ENDPOINT_COLUMNS)
    .single()
  if (error || !data) {
    console.error('[webhooks] create endpoint failed:', error?.message)
    return NextResponse.json({ error: 'Failed to create the endpoint' }, { status: 500 })
  }
  return NextResponse.json({ endpoint: data, secret }, { status: 201, headers: { 'Cache-Control': 'no-store' } })
}
