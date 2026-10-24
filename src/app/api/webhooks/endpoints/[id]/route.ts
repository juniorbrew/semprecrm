// read-only: allowed (settings: webhook endpoint management stays available, owner decision)
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { requireAdmin } from '@/lib/webhooks/admin-guard'
import { validateEndpointUrl } from '@/lib/webhooks/endpoint-url'
import { ENDPOINT_COLUMNS } from '@/lib/webhooks/columns'
import { normalizeEvents } from '@/lib/webhooks/events'


export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

export async function PATCH(request: Request, { params }: Ctx) {
  const gate = await requireAdmin()
  if ('response' in gate) return gate.response
  const { id } = await params

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (body.url !== undefined) {
    const url = await validateEndpointUrl(body.url)
    if (!url.ok) return NextResponse.json({ error: url.error }, { status: 400 })
    patch.url = url.url
  }
  if (body.events !== undefined) {
    const events = normalizeEvents(body.events)
    if (!events) return NextResponse.json({ error: 'Pick at least one event' }, { status: 400 })
    patch.events = events
  }
  if (body.description !== undefined) {
    patch.description =
      typeof body.description === 'string' && body.description.trim() ? body.description.trim().slice(0, 200) : null
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    patch.enabled = body.enabled
    // Turning it back on starts a clean health record.
    if (body.enabled) Object.assign(patch, { disabled_reason: null, failing_since: null })
    else patch.disabled_reason = 'manual'
  }

  const { data, error } = await supabaseAdmin()
    .from('webhook_endpoints')
    .update(patch)
    .eq('id', id)
    .eq('account_id', gate.ctx.accountId)
    .select(ENDPOINT_COLUMNS)
    .maybeSingle()
  if (error) return NextResponse.json({ error: 'Failed to update the endpoint' }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ endpoint: data })
}

export async function DELETE(_request: Request, { params }: Ctx) {
  const gate = await requireAdmin()
  if ('response' in gate) return gate.response
  const { id } = await params
  const { data, error } = await supabaseAdmin()
    .from('webhook_endpoints')
    .delete()
    .eq('id', id)
    .eq('account_id', gate.ctx.accountId)
    .select('id')
    .maybeSingle()
  if (error) return NextResponse.json({ error: 'Failed to delete the endpoint' }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
