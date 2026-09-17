// ============================================================
// POST /api/integrations/calendar/sync — the cron tick for the
// calendar sync (scripts/cron-tick.mjs every CALENDAR_SYNC_INTERVAL_MS,
// default 5 min). Requires `x-cron-secret` = AUTOMATION_CRON_SECRET.
//
// Syncs the stalest active connections first, at most 20 per call
// (`syncDueConnections`), and answers with the per-connection counts.
// ============================================================

import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { CRON_BATCH_LIMIT, syncDueConnections } from '@/lib/calendar/sync/engine'

export async function POST(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  if (request.headers.get('x-cron-secret') !== expected) {
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
