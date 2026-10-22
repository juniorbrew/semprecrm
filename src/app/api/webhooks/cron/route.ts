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
    // The purges run even when a dispatch pass throws: housekeeping must not depend on delivery health.
    let summary: Awaited<ReturnType<typeof runDispatch>> | null = null
    let dispatchError: unknown = null
    try {
      summary = await runDispatch({ db })
    } catch (err) {
      dispatchError = err
    }
    let purged = 0
    for (const [fn, args] of [
      ['webhook_purge', { p_days: 30, p_limit: 5000 }],
      // Idempotency keys (24 h) and the per-key request log (7 days / 200 rows).
      ['api_purge', undefined],
    ] as const) {
      try {
        const { data } = await db.rpc(fn, args)
        purged += typeof data === 'number' ? data : 0
      } catch (err) {
        console.error(`[webhooks] ${fn} failed:`, err instanceof Error ? err.message : err)
      }
    }
    if (dispatchError) throw dispatchError
    return NextResponse.json({ ...summary, purged })
  } catch (err) {
    console.error('[webhooks] cron failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'webhook dispatch failed' }, { status: 500 })
  }
}

export const POST = GET
