import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { requireCapiAdmin, requireWritableCapiAdmin } from '@/lib/meta-capi/guard'
import { parseSettingsInput } from '@/lib/meta-capi/validate'
import { encrypt } from '@/lib/whatsapp/encryption'

export const dynamic = 'force-dynamic'

// token_enc is never selected for the response: the browser only learns token_last4.
const SETTINGS_PUBLIC = 'dataset_id, token_last4, test_event_code, send_lead, send_purchase, enabled, paused_reason, updated_at'
const EVENT_COLUMNS = 'id, deal_id, event_name, status, attempts, value, currency, last_error, occurred_at, sent_at, created_at'

export async function GET() {
  const gate = await requireCapiAdmin()
  if ('response' in gate) return gate.response
  const { accountId } = gate.ctx
  const db = supabaseAdmin()

  const [settings, events] = await Promise.all([
    db.from('meta_capi_settings').select(SETTINGS_PUBLIC).eq('account_id', accountId).maybeSingle(),
    db.from('meta_capi_events').select(EVENT_COLUMNS).eq('account_id', accountId).order('created_at', { ascending: false }).limit(50),
  ])
  if (settings.error || events.error) {
    return NextResponse.json({ error: 'Failed to load the Meta settings' }, { status: 500 })
  }
  const rows = (events.data ?? []) as { deal_id: string }[]
  const titles = new Map<string, string>()
  if (rows.length > 0) {
    const { data: deals } = await db
      .from('deals')
      .select('id, title')
      .eq('account_id', accountId)
      .in('id', [...new Set(rows.map((r) => r.deal_id))])
    for (const d of (deals ?? []) as { id: string; title: string }[]) titles.set(d.id, d.title)
  }
  return NextResponse.json(
    {
      settings: settings.data ?? null,
      events: rows.map((r) => ({ ...r, deal_title: titles.get(r.deal_id) ?? null })),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

export async function PUT(request: Request) {
  const gate = await requireWritableCapiAdmin()
  if ('response' in gate) return gate.response
  const { accountId, userId } = gate.ctx
  const db = supabaseAdmin()

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const { data: existing, error: loadError } = await db
    .from('meta_capi_settings')
    .select('dataset_id, token_last4')
    .eq('account_id', accountId)
    .maybeSingle()
  if (loadError) return NextResponse.json({ error: 'Failed to load the Meta settings' }, { status: 500 })

  const parsed = parseSettingsInput(body, {
    dataset_id: (existing?.dataset_id as string | null | undefined) ?? null,
    has_token: Boolean(existing?.token_last4),
  })
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const { token, ...rest } = parsed.patch

  const row: Record<string, unknown> = { account_id: accountId, updated_by: userId, ...rest }
  if (token) {
    row.token_enc = encrypt(token)
    row.token_last4 = token.slice(-4)
  }
  // Only a new key or a DIFFERENT dataset is the fix for a paused integration (saving the same values is not).
  const datasetChanged = rest.dataset_id !== undefined && rest.dataset_id !== ((existing?.dataset_id as string | null | undefined) ?? null)
  if (token || datasetChanged) row.paused_reason = null

  // update vs insert, never upsert: Postgres checks CHECK constraints on the INSERT tuple before ON CONFLICT,
  // so a partial upsert such as { enabled: true } fails "enabled requires dataset and token" (23514) even
  // when the existing row has both.
  const write = existing
    ? db.from('meta_capi_settings').update(row).eq('account_id', accountId)
    : db.from('meta_capi_settings').insert(row)
  const { data, error } = await write.select(SETTINGS_PUBLIC).single()
  if (error || !data) {
    console.error('[meta-capi] save failed:', error?.code ?? 'unknown')
    return NextResponse.json({ error: 'Failed to save the Meta settings' }, { status: 500 })
  }
  return NextResponse.json({ settings: data }, { headers: { 'Cache-Control': 'no-store' } })
}
