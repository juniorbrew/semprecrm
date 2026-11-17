// read-only: allowed (cron: secret-authenticated tick, no user)
import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { sweepExtrasRemovals } from '@/lib/billing/extras-sweep'

export const dynamic = 'force-dynamic'

/**
 * Safety net for paid plans (migration 090): an account whose paid period
 * (plus grace) ended without a new confirmed payment turns past_due — e.g.
 * the subscription was deleted in Asaas or its webhook queue is paused.
 * Also applies the removals of extras that came due (migration 114, extras-sweep.ts).
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
  const db = supabaseAdmin()
  const { data, error } = await db.rpc('billing_expire_lapsed')
  if (error) {
    console.error('[billing] expiry sweep failed:', error.message)
    return NextResponse.json({ error: 'billing sweep failed' }, { status: 500 })
  }
  // A failing extras sweep must not hide the expiry result (it retries next hour).
  let extras = null
  try {
    extras = await sweepExtrasRemovals(db)
  } catch (err) {
    console.error('[billing] extras sweep failed:', err instanceof Error ? err.message : err)
  }
  return NextResponse.json({ expired: data ?? 0, extras })
}

export const POST = GET
