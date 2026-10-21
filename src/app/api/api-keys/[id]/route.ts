import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { requireAdmin } from '@/lib/webhooks/admin-guard'

export const dynamic = 'force-dynamic'

/** Revokes a key immediately (the row stays for the audit trail). */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin()
  if ('response' in gate) return gate.response
  const { id } = await params
  const { data, error } = await supabaseAdmin()
    .from('api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id)
    .eq('account_id', gate.ctx.accountId)
    .is('revoked_at', null)
    .select('id')
    .maybeSingle()
  if (error) return NextResponse.json({ error: 'Failed to revoke the API key' }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
