import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { runDispatch } from '@/lib/webhooks/dispatcher'

export const dynamic = 'force-dynamic'

/**
 * Delivers due outbound webhooks (migration 093) and purges history older
 * than 30 days. Hit every tick by scripts/cron-tick.mjs with the shared
 * `x-cron-secret`. Overlapping calls are safe: the claim RPC leases rows
 * with FOR UPDATE SKIP LOCKED, so each delivery is attempted by one caller.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  const supplied = Buffer.from(request.headers.get('x-cron-secret') ?? '')
  const wanted = Buffer.from(expected)
  if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const db = supabaseAdmin()
    const summary = await runDispatch({ db })
    const { data: purged } = await db.rpc('webhook_purge', { p_days: 30, p_limit: 5000 })
    return NextResponse.json({ ...summary, purged: purged ?? 0 })
  } catch (err) {
    console.error('[webhooks] cron failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'webhook dispatch failed' }, { status: 500 })
  }
}

export const POST = GET
