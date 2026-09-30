// ============================================================
// SLA compliance (migration 072): share of the deadlines judged in the
// period that were met. Every conversation can carry two deadlines; each
// one that reached a verdict counts once:
//   - first response: answered (met when first_response_at <= due) or
//     still unanswered past its due date (missed);
//   - resolution: resolved (met when resolved_at <= due) or still open
//     past its due date (missed).
// A deadline is judged in the period when its verdict time (the answer /
// resolution, or the due date for a miss) falls inside it. Pending ones
// (due in the future) and conversations without a policy do not count.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { daysAgoStart } from './date-utils'
import type { TeamPeriod } from './team-metrics'

export interface SlaComplianceRow {
  status: string
  first_response_at: string | null
  first_response_due_at: string | null
  resolution_due_at: string | null
  resolved_at: string | null
}

export interface SlaComplianceResult {
  period: TeamPeriod
  met: number
  missed: number
  /** Whole percent, null when nothing was judged. */
  percent: number | null
}

/** Safety cap on the rows read per period. */
export const SLA_SAMPLE_LIMIT = 5000

function ms(iso: string | null): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : t
}

export function aggregateSlaCompliance(
  rows: readonly SlaComplianceRow[],
  period: TeamPeriod,
  since: number,
  now: number,
): SlaComplianceResult {
  let met = 0
  let missed = 0
  const judge = (verdictAt: number | null, dueAt: number, done: boolean) => {
    if (done) {
      if (verdictAt === null || verdictAt < since) return
      if (verdictAt <= dueAt) met += 1
      else missed += 1
    } else if (dueAt <= now && dueAt >= since) {
      missed += 1
    }
  }
  for (const r of rows) {
    const firstDue = ms(r.first_response_due_at)
    if (firstDue !== null) judge(ms(r.first_response_at), firstDue, !!r.first_response_at)
    const resDue = ms(r.resolution_due_at)
    if (resDue !== null) {
      if (r.status === 'closed') {
        // Archived while open has no resolved_at: not a resolution, not judged.
        if (r.resolved_at) judge(ms(r.resolved_at), resDue, true)
      } else {
        judge(null, resDue, false)
      }
    }
  }
  const total = met + missed
  return { period, met, missed, percent: total === 0 ? null : Math.round((met / total) * 100) }
}

export async function loadSlaCompliance(
  db: SupabaseClient,
  accountId: string,
  period: TeamPeriod,
  now: Date = new Date(),
): Promise<SlaComplianceResult> {
  const since = daysAgoStart(period - 1)
  const iso = since.toISOString()
  const { data, error } = await db
    .from('conversations')
    .select('status, first_response_at, first_response_due_at, resolution_due_at, resolved_at')
    .eq('account_id', accountId)
    .or(`first_response_due_at.gte.${iso},resolution_due_at.gte.${iso}`)
    .limit(SLA_SAMPLE_LIMIT)
  if (error) throw error
  return aggregateSlaCompliance((data ?? []) as SlaComplianceRow[], period, since.getTime(), now.getTime())
}
