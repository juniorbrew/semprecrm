import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { drainAutomationEvents } from '@/lib/automations/event-queue'
import { runSlaTick } from '@/lib/support/sla-cron'

export const dynamic = 'force-dynamic'

/**
 * SLA warnings and breaches (migration 072). Hit every tick by
 * scripts/cron-tick.mjs with the shared `x-cron-secret` header; the work
 * is idempotent (events are unique per conversation and target), so an
 * overlapping or repeated call changes nothing.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  const supplied = Buffer.from(request.headers.get('x-cron-secret') ?? '')
  const wanted = Buffer.from(expected)
  if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const result = await runSlaTick(supabaseAdmin())
  // The automation triggers sla_warning / sla_breached were queued by the
  // tick: run them now instead of waiting for the next automations tick.
  const events = result.warnings + result.breaches > 0 ? await drainAutomationEvents({ limit: 200 }) : null
  return NextResponse.json({ ...result, events })
}
