// read-only: allowed (settings: API key management stays available, owner decision)
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { DEFAULT_GRACE_HOURS, MAX_GRACE_HOURS, generateApiKey, keyState } from '@/lib/api-keys/keys'
import { KEY_COLUMNS, MAX_ACTIVE_KEYS, countActiveKeys } from '@/lib/api-keys/store'
import { requireAdmin } from '@/lib/webhooks/admin-guard'

export const dynamic = 'force-dynamic'

/**
 * Rotation: issues a new key with the same name, note, permissions and IP allowlist
 * and lets the old one keep working for `grace_hours` (default 24, 0 = revoke now),
 * so integrations can switch without downtime. The new plaintext is shown once.
 *
 * With a grace period the old and the new key are both active for a while, so the
 * active-key limit applies (grace 0 is a swap and never grows the count). If the
 * old key cannot be updated the new one is removed again: no half-rotated state.
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
    .select('id, name, note, scopes, allowed_cidrs, revoked_at, expires_at')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (!old) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (keyState(old, new Date()) !== 'active') {
    return NextResponse.json({ error: 'This API key is no longer active' }, { status: 409 })
  }
  // Already rotated (in its grace period): rotating again would extend the old key's life.
  if (old.expires_at) {
    return NextResponse.json({ error: 'This API key is already being rotated' }, { status: 409 })
  }
  if (grace > 0 && (await countActiveKeys(db, ctx.accountId)) >= MAX_ACTIVE_KEYS) {
    return NextResponse.json({ error: 'API key limit reached. Revoke a key first' }, { status: 409 })
  }

  const gen = generateApiKey()
  const { data: created, error } = await db
    .from('api_keys')
    .insert({
      account_id: ctx.accountId,
      name: old.name,
      note: old.note,
      key_prefix: gen.prefix,
      key_last4: gen.last4,
      key_hash: gen.hash,
      scopes: old.scopes,
      allowed_cidrs: old.allowed_cidrs,
      created_by: ctx.userId,
    })
    .select(KEY_COLUMNS)
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
  const { data: updated, error: updateError } = await db
    .from('api_keys')
    .update(patch)
    .eq('id', old.id)
    .eq('account_id', ctx.accountId)
    .select('id')
    .maybeSingle()
  if (updateError || !updated) {
    console.error('[api-keys] rotate: old key update failed:', updateError?.message)
    // Undo: never leave a surprise extra live key behind.
    await db.from('api_keys').delete().eq('id', created.id).eq('account_id', ctx.accountId)
    return NextResponse.json({ error: 'Failed to rotate the API key' }, { status: 500 })
  }

  return NextResponse.json(
    { key: { ...created, state: 'active' }, secret: gen.key },
    { status: 201, headers: { 'Cache-Control': 'no-store' } },
  )
}
