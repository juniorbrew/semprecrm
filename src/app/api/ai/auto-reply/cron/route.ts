import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { drainAutoReplies } from '@/lib/ai/auto-reply-runtime'

export const dynamic = 'force-dynamic'

/**
 * GET /api/ai/auto-reply/cron — drain due automatic-reply jobs
 * (migration 066). Called by scripts/cron-tick.mjs every tick with the
 * shared `x-cron-secret` (AUTOMATION_CRON_SECRET), like the automations
 * cron. `ai_reply_claim` reaps stale 'running' jobs and claims with
 * FOR UPDATE SKIP LOCKED, so overlapping calls never share a job.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  const supplied = Buffer.from(request.headers.get('x-cron-secret') ?? '')
  const want = Buffer.from(expected)
  if (supplied.length !== want.length || !timingSafeEqual(supplied, want)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    return NextResponse.json(await drainAutoReplies())
  } catch (err) {
    console.error('[ai/auto-reply/cron] drain failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'drain failed' }, { status: 500 })
  }
}
