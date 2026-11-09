// read-only: allowed (cron: secret-authenticated tick, no user)
import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { processCapiBatch } from '@/lib/meta-capi/process'

export const dynamic = 'force-dynamic'

/**
 * Sends the due Conversions API events (migration 110) and purges terminal ones older than 90 days.
 * Hit every tick by scripts/cron-tick.mjs with the shared `x-cron-secret`. Overlapping calls are safe:
 * meta_capi_claim leases rows with FOR UPDATE SKIP LOCKED.
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
  let summary: Awaited<ReturnType<typeof processCapiBatch>> | null = null
  let failure: unknown = null
  try {
    summary = await processCapiBatch({ db })
  } catch (err) {
    failure = err
  }
  let purged = 0
  try {
    const { data } = await db.rpc('meta_capi_purge', { p_days: 90, p_limit: 5000 })
    purged = typeof data === 'number' ? data : 0
  } catch (err) {
    console.error('[meta-capi] purge failed:', err instanceof Error ? err.message : err)
  }
  if (failure) {
    console.error('[meta-capi] cron failed:', failure instanceof Error ? failure.message : failure)
    return NextResponse.json({ error: 'meta capi send failed' }, { status: 500 })
  }
  return NextResponse.json({ ...summary, purged })
}

export const POST = GET
