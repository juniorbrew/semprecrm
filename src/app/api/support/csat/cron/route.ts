import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { runCsatCron } from '@/lib/support/csat-cron'

export const dynamic = 'force-dynamic'

/**
 * Satisfaction surveys (migration 074): expires unanswered ones and sends
 * the ones that are due. Hit every tick by scripts/cron-tick.mjs with the
 * shared `x-cron-secret` header. Idempotent: a repeated or overlapping call
 * claims nothing twice (jobs are claimed with SKIP LOCKED, the survey row
 * is unique per conversation).
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  const supplied = Buffer.from(request.headers.get('x-cron-secret') ?? '')
  const wanted = Buffer.from(expected)
  if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return NextResponse.json(await runCsatCron(supabaseAdmin()))
}
