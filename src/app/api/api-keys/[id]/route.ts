import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { parseCidrList } from '@/lib/api-keys/cidr'
import { keyState } from '@/lib/api-keys/keys'
import { KEY_COLUMNS, normalizeNote } from '@/lib/api-keys/store'
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

/**
 * Edits the label of a key: name, note and (optionally) the IP allowlist, with the same
 * validation as creation. Permissions are not editable (rotate to change what a key can do).
 * Revoked keys are read-only.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin()
  if ('response' in gate) return gate.response
  const { id } = await params

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid request' }, { status: 400 })

  const patch: Record<string, unknown> = {}
  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (name.length < 1 || name.length > 80) {
      return NextResponse.json({ error: 'Enter a name of up to 80 characters' }, { status: 400 })
    }
    patch.name = name
  }
  if (body.note !== undefined) {
    const note = normalizeNote(body.note)
    if (note === undefined) return NextResponse.json({ error: 'The note can have up to 200 characters' }, { status: 400 })
    patch.note = note
  }
  if (body.allowed_cidrs !== undefined) {
    const cidrs = parseCidrList(body.allowed_cidrs)
    if (!cidrs) {
      return NextResponse.json({ error: 'Enter valid IP addresses or CIDR ranges (up to 10)' }, { status: 400 })
    }
    patch.allowed_cidrs = cidrs.length > 0 ? cidrs : null
  }
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })

  const db = supabaseAdmin()
  const { data: current } = await db
    .from('api_keys')
    .select('revoked_at, expires_at')
    .eq('id', id)
    .eq('account_id', gate.ctx.accountId)
    .maybeSingle()
  if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (keyState(current, new Date()) === 'revoked') {
    return NextResponse.json({ error: 'This API key is no longer active' }, { status: 409 })
  }

  const { data, error } = await db
    .from('api_keys')
    .update(patch)
    .eq('id', id)
    .eq('account_id', gate.ctx.accountId)
    .select(KEY_COLUMNS)
    .maybeSingle()
  if (error) return NextResponse.json({ error: 'Failed to update the API key' }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ key: { ...data, state: keyState(data, new Date()) } })
}
