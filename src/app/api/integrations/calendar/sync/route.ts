// ============================================================
// POST /api/integrations/calendar/sync — the cron tick for the
// calendar sync (scripts/cron-tick.mjs every CALENDAR_SYNC_INTERVAL_MS,
// default 5 min). Requires `x-cron-secret` = AUTOMATION_CRON_SECRET.
//
// Syncs the stalest active connections first, at most 20 per call
// (`syncDueConnections`), and answers with the per-connection counts.
// ============================================================

import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { CRON_BATCH_LIMIT, syncDueConnections } from '@/lib/calendar/sync/engine'

export async function POST(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  // Same constant-time check as the other cron routes; the length
  // pre-check is required by timingSafeEqual and leaks only the length.
  const suppliedBuf = Buffer.from(request.headers.get('x-cron-secret') ?? '')
  const expectedBuf = Buffer.from(expected)
  if (suppliedBuf.length !== expectedBuf.length || !timingSafeEqual(suppliedBuf, expectedBuf)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const result = await syncDueConnections({ admin: supabaseAdmin(), limit: CRON_BATCH_LIMIT })
    return NextResponse.json(result)
  } catch (err) {
    console.error('[POST /api/integrations/calendar/sync] failed:', err)
    return NextResponse.json({ error: 'Sync failed' }, { status: 500 })
  }
}
