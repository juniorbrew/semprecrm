import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { DEFAULT_GRACE_HOURS, MAX_GRACE_HOURS, generateApiKey, keyState } from '@/lib/api-keys/keys'
import { requireAdmin } from '@/lib/webhooks/admin-guard'

export const dynamic = 'force-dynamic'

/**
 * Rotation: issues a new key with the same name and permissions and lets
 * the old one keep working for `grace_hours` (default 24, 0 = revoke now),
 * so integrations can switch without downtime. The new plaintext is shown once.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin()
  if ('response' in gate) return gate.response
  const { ctx } = gate
  const { id } = await params

  const body = (await request.json().catch(() => null)) as { grace_hours?: unknown } | null
  const grace = body?.grace_hours === undefined ? DEFAULT_GRACE_HOURS : Number(body.grace_hours)
  if (!Number.isFinite(grace) || grace < 0 || grace > MAX_GRACE_HOURS) {
    return NextResponse.json({ error: 'The grace period must be between 0 and 168 hours' }, { status: 400 })
  }

  const db = supabaseAdmin()
  const { data: old } = await db
    .from('api_keys')
    .select('id, name, scopes, revoked_at, expires_at')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (!old) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (keyState(old, new Date()) !== 'active') {
    return NextResponse.json({ error: 'This API key is no longer active' }, { status: 409 })
  }

  const gen = generateApiKey()
  const { data: created, error } = await db
    .from('api_keys')
    .insert({
      account_id: ctx.accountId,
      name: old.name,
      key_prefix: gen.prefix,
      key_last4: gen.last4,
      key_hash: gen.hash,
      scopes: old.scopes,
      created_by: ctx.userId,
    })
    .select('id, name, key_prefix, key_last4, scopes, created_at, last_used_at, expires_at, revoked_at')
    .single()
  if (error || !created) {
    console.error('[api-keys] rotate failed:', error?.message)
    return NextResponse.json({ error: 'Failed to rotate the API key' }, { status: 500 })
  }

  const now = new Date()
  const patch =
    grace === 0
      ? { revoked_at: now.toISOString() }
      : { expires_at: new Date(now.getTime() + grace * 3600_000).toISOString() }
  await db.from('api_keys').update(patch).eq('id', old.id).eq('account_id', ctx.accountId)

  return NextResponse.json({ key: { ...created, state: 'active' }, secret: gen.key }, { status: 201 })
}
