import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { generateApiKey, keyState, normalizeScopes } from '@/lib/api-keys/keys'
import { requireAdmin } from '@/lib/webhooks/admin-guard'

export const dynamic = 'force-dynamic'

const MAX_ACTIVE_KEYS = 20

const COLUMNS = 'id, name, key_prefix, key_last4, scopes, created_at, last_used_at, expires_at, revoked_at'

export async function GET() {
  const gate = await requireAdmin()
  if ('response' in gate) return gate.response
  const { data, error } = await supabaseAdmin()
    .from('api_keys')
    .select(COLUMNS)
    .eq('account_id', gate.ctx.accountId)
    .order('created_at', { ascending: false })
  if (error) return NextResponse.json({ error: 'Failed to load API keys' }, { status: 500 })
  const now = new Date()
  return NextResponse.json({
    keys: (data ?? []).map((k) => ({ ...k, state: keyState(k, now) })),
  })
}

/** Creates a key. The plaintext is in this response and nowhere else, ever. */
export async function POST(request: Request) {
  const gate = await requireAdmin()
  if ('response' in gate) return gate.response
  const { ctx } = gate

  const body = (await request.json().catch(() => null)) as { name?: unknown; scopes?: unknown } | null
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (name.length < 1 || name.length > 80) {
    return NextResponse.json({ error: 'Enter a name of up to 80 characters' }, { status: 400 })
  }
  const scopes = normalizeScopes(body?.scopes)
  if (!scopes) return NextResponse.json({ error: 'Pick at least one permission' }, { status: 400 })

  const db = supabaseAdmin()
  const { count } = await db
    .from('api_keys')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', ctx.accountId)
    .is('revoked_at', null)
  if ((count ?? 0) >= MAX_ACTIVE_KEYS) {
    return NextResponse.json({ error: 'API key limit reached. Revoke a key first' }, { status: 409 })
  }

  const gen = generateApiKey()
  const { data, error } = await db
    .from('api_keys')
    .insert({
      account_id: ctx.accountId,
      name,
      key_prefix: gen.prefix,
      key_last4: gen.last4,
      key_hash: gen.hash,
      scopes,
      created_by: ctx.userId,
    })
    .select(COLUMNS)
    .single()
  if (error || !data) {
    console.error('[api-keys] create failed:', error?.message)
    return NextResponse.json({ error: 'Failed to create the API key' }, { status: 500 })
  }
  return NextResponse.json({ key: { ...data, state: 'active' }, secret: gen.key }, { status: 201 })
}
