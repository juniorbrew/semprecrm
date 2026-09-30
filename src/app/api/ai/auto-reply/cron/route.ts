import { timingSafeEqual } from 'node:crypto'
import { NextResponse, after } from 'next/server'

import { claimAutoReplies, runClaimedJobs } from '@/lib/ai/auto-reply-runtime'

export const dynamic = 'force-dynamic'

/**
 * GET /api/ai/auto-reply/cron — claim due automatic-reply jobs
 * (migration 066) and run them AFTER the response, so the cron tick is
 * never held up by model calls and typing delays. Called by
 * scripts/cron-tick.mjs every tick with `x-cron-secret`
 * (AUTOMATION_CRON_SECRET). The claim only takes the free slots of this
 * process (MAX_CONCURRENCY); `ai_reply_claim` reaps dead jobs and uses
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
    const jobs = await claimAutoReplies()
    if (jobs.length > 0) {
      after(() =>
        runClaimedJobs(jobs).catch((err) =>
          console.error('[ai/auto-reply/cron] run failed:', err instanceof Error ? err.message : err),
        ),
      )
    }
    return NextResponse.json({ claimed: jobs.length })
  } catch (err) {
    console.error('[ai/auto-reply/cron] claim failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'claim failed' }, { status: 500 })
  }
}
