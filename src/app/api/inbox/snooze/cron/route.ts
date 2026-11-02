// read-only: allowed (cron: secret-authenticated tick, no user)
import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { runManagerAlerts } from '@/lib/conversations/manager-alerts'
import { runSnoozeWake } from '@/lib/conversations/snooze-wake'

export const dynamic = 'force-dynamic'

/**
 * Wakes snoozed conversations whose time is up (migration 079) and pushes
 * the assignee (or whoever snoozed it). Hit every tick by
 * scripts/cron-tick.mjs with the shared `x-cron-secret` header.
 * Idempotent: a woken conversation no longer matches, and overlapping
 * calls split the rows (SKIP LOCKED).
 *
 * The same tick runs the team monitoring alerts (migration 105), so no new
 * cron path has to be opened in nginx / cron-tick.
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
    const snooze = await runSnoozeWake(db)
    const alerts = await runManagerAlerts(db).catch((err) => {
      console.error('[manager-alerts] tick failed:', err instanceof Error ? err.message : err)
      return { claimed: 0, notified: 0, errors: 1 }
    })
    return NextResponse.json({ ...snooze, alerts })
  } catch (err) {
    console.error('[snooze] cron failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'snooze wake failed' }, { status: 500 })
  }
}

export const POST = GET
