// read-only: allowed (cron: secret-authenticated tick, no user)
import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'

export const dynamic = 'force-dynamic'

/**
 * Safety net for paid plans (migration 090): an account whose paid period
 * (plus grace) ended without a new confirmed payment turns past_due — e.g.
 * the subscription was deleted in Asaas or its webhook queue is paused.
 * Hit hourly by scripts/cron-tick.mjs with the shared `x-cron-secret` header.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  const supplied = Buffer.from(request.headers.get('x-cron-secret') ?? '')
  const wanted = Buffer.from(expected)
  if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { data, error } = await supabaseAdmin().rpc('billing_expire_lapsed')
  if (error) {
    console.error('[billing] expiry sweep failed:', error.message)
    return NextResponse.json({ error: 'billing sweep failed' }, { status: 500 })
  }
  return NextResponse.json({ expired: data ?? 0 })
}

export const POST = GET
