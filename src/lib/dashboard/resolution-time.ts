// ============================================================
// Average resolution time (migration 071): resolved_at - created_at of
// the conversations resolved in the period. `resolved_at` is stamped by
// a trigger when the status becomes 'closed' and cleared on reopen, so a
// reopened conversation counts again only once it is resolved again.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { median } from './team-metrics'
import { daysAgoStart } from './date-utils'
import type { TeamPeriod } from './team-metrics'

export interface ResolutionTimeResult {
  period: TeamPeriod
  /** Conversations resolved in the period. */
  count: number
  avgSeconds: number | null
  medianSeconds: number | null
}

/** Safety cap on the rows read per period (the newest resolutions win). */
export const RESOLUTION_SAMPLE_LIMIT = 5000

export function aggregateResolutionTimes(
  rows: readonly { created_at: string; resolved_at: string | null }[],
  period: TeamPeriod,
): ResolutionTimeResult {
  const seconds: number[] = []
  for (const r of rows) {
    if (!r.resolved_at) continue
    const s = (Date.parse(r.resolved_at) - Date.parse(r.created_at)) / 1000
    if (Number.isFinite(s) && s >= 0) seconds.push(s)
  }
  if (seconds.length === 0) return { period, count: 0, avgSeconds: null, medianSeconds: null }
  return {
    period,
    count: seconds.length,
    avgSeconds: seconds.reduce((a, b) => a + b, 0) / seconds.length,
    medianSeconds: median(seconds),
  }
}

export async function loadResolutionTime(
  db: SupabaseClient,
  accountId: string,
  period: TeamPeriod,
): Promise<ResolutionTimeResult> {
  const since = daysAgoStart(period - 1).toISOString()
  const { data, error } = await db
    .from('conversations')
    .select('created_at, resolved_at')
    .eq('account_id', accountId)
    .not('resolved_at', 'is', null)
    // Backfilled rows (resolved_at = updated_at) are not a real measure.
    .eq('resolved_at_estimated', false)
    .gte('resolved_at', since)
    .order('resolved_at', { ascending: false })
    .limit(RESOLUTION_SAMPLE_LIMIT)
  if (error) throw error
  return aggregateResolutionTimes((data ?? []) as { created_at: string; resolved_at: string | null }[], period)
}
