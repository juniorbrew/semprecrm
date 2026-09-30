// ============================================================
// SLA compliance (migration 072): share of the deadlines judged in the
// period that were met. The counting lives in SQL (`sla_compliance`) so it
// is exact for any volume; the verdict rules are documented there:
//   - first response: answered (met when first_response_at <= due) or still
//     unanswered past its due date (missed); only once the customer wrote;
//   - resolution: resolved (met when resolved_at <= due) or still open past
//     its due date (missed).
// A deadline is judged in the period when its verdict time (the answer /
// resolution, or the due date for a miss) falls inside it.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { daysAgoStart } from './date-utils'
import type { TeamPeriod } from './team-metrics'

export interface SlaComplianceResult {
  period: TeamPeriod
  met: number
  missed: number
  /** Whole percent, null when nothing was judged. */
  percent: number | null
}

export function complianceResult(period: TeamPeriod, met: number, missed: number): SlaComplianceResult {
  const total = met + missed
  return { period, met, missed, percent: total === 0 ? null : Math.round((met / total) * 100) }
}

export async function loadSlaCompliance(
  db: SupabaseClient,
  accountId: string,
  period: TeamPeriod,
  now: Date = new Date(),
): Promise<SlaComplianceResult> {
  const { data, error } = await db.rpc('sla_compliance', {
    p_account_id: accountId,
    p_since: daysAgoStart(period - 1).toISOString(),
    p_now: now.toISOString(),
  })
  if (error) throw error
  const row = (Array.isArray(data) ? data[0] : data) as { met?: number | string; missed?: number | string } | null
  return complianceResult(period, Number(row?.met ?? 0) || 0, Number(row?.missed ?? 0) || 0)
}
