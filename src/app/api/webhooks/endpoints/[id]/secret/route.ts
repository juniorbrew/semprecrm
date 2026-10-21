import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import { requireAdmin } from '@/lib/webhooks/admin-guard'
import { generateWebhookSecret } from '@/lib/webhooks/signing'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

const MAX_OVERLAP_HOURS = 24

/** Reveals the current signing secret (admins only). */
export async function GET(_request: Request, { params }: Ctx) {
  const gate = await requireAdmin()
  if ('response' in gate) return gate.response
  const { id } = await params
  const { data } = await supabaseAdmin()
    .from('webhook_endpoints')
    .select('secret_enc, previous_secret_expires_at')
    .eq('id', id)
    .eq('account_id', gate.ctx.accountId)
    .maybeSingle()
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({
    secret: decrypt(data.secret_enc),
    previous_secret_expires_at: data.previous_secret_expires_at,
  })
}

/**
 * Rotates the signing secret. For `overlap_hours` (default 24, max 24) the
 * old secret keeps signing too: every delivery carries one v1 signature per
 * live secret, so the receiver can switch with no downtime.
 */
export async function POST(request: Request, { params }: Ctx) {
  const gate = await requireAdmin()
  if ('response' in gate) return gate.response
  const { id } = await params

  const body = (await request.json().catch(() => null)) as { overlap_hours?: unknown } | null
  const overlap = body?.overlap_hours === undefined ? MAX_OVERLAP_HOURS : Number(body.overlap_hours)
  if (!Number.isFinite(overlap) || overlap < 0 || overlap > MAX_OVERLAP_HOURS) {
    return NextResponse.json({ error: 'The overlap must be between 0 and 24 hours' }, { status: 400 })
  }

  const db = supabaseAdmin()
  const { data: current } = await db
    .from('webhook_endpoints')
    .select('secret_enc')
    .eq('id', id)
    .eq('account_id', gate.ctx.accountId)
    .maybeSingle()
  if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const secret = generateWebhookSecret()
  const expires = overlap > 0 ? new Date(Date.now() + overlap * 3600_000).toISOString() : null
  const { error } = await db
    .from('webhook_endpoints')
    .update({
      secret_enc: encrypt(secret),
      previous_secret_enc: overlap > 0 ? current.secret_enc : null,
      previous_secret_expires_at: expires,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('account_id', gate.ctx.accountId)
  if (error) return NextResponse.json({ error: 'Failed to rotate the secret' }, { status: 500 })
  return NextResponse.json({ secret, previous_secret_expires_at: expires })
}
