// ============================================================
// Reports -> "IA" and "Equipe" (migration 111): typed faces of ai_report() / team_report() and the pure
// helpers the sections use. The counting happens in SQL; nothing here sums rows.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { originPeriodBounds } from '@/lib/lead-origins/report'
import type { ReportPeriod } from '@/lib/support/reports'

const num = (v: unknown) => {
  const x = typeof v === 'number' ? v : Number(v ?? 0)
  return Number.isFinite(x) ? x : 0
}

export interface AiFeatureCost {
  feature: string
  calls: number
  /** USD cents. */
  costCents: number
}

export interface AiReport {
  enabled: boolean
  attended: number
  handedOff: number
  topReason: string | null
  topReasonCount: number
  resolvedWithoutPerson: number
  messages: number
  /** null = the caller is not an admin (ai_usage is admin-only). */
  costByFeature: AiFeatureCost[] | null
}

export async function fetchAiReport(
  db: Pick<SupabaseClient, 'rpc'>,
  accountId: string,
  period: ReportPeriod,
  timezone: string,
): Promise<AiReport> {
  const { start, end } = originPeriodBounds(period, timezone)
  const { data, error } = await db.rpc('ai_report', { p_account_id: accountId, p_start: start, p_end: end })
  if (error) throw error
  const r = ((Array.isArray(data) ? data[0] : data) ?? {}) as Record<string, unknown>
  const cost = Array.isArray(r.cost_by_feature)
    ? (r.cost_by_feature as Record<string, unknown>[]).map((c) => ({
        feature: String(c.feature ?? ''),
        calls: num(c.calls),
        costCents: num(c.cost_cents),
      }))
    : null
  return {
    enabled: r.ai_enabled === true,
    attended: num(r.attended),
    handedOff: num(r.handed_off),
    topReason: typeof r.top_reason === 'string' && r.top_reason ? r.top_reason : null,
    topReasonCount: num(r.top_reason_count),
    resolvedWithoutPerson: num(r.resolved_without_person),
    messages: num(r.ai_messages),
    costByFeature: cost,
  }
}

/** Nothing to show: AI off and no trace of use in the period. */
export const aiIsEmpty = (r: AiReport) =>
  !r.enabled && r.attended === 0 && r.messages === 0 && !r.costByFeature?.length

export interface TeamStats {
  userId: string
  handled: number
  resolved: number
  firstResponseAvgSeconds: number | null
  tasksCompleted: number
  openAssigned: number
  dealsWon: number
  dealsLost: number
  wonValue: number
}

export async function fetchTeamReport(
  db: Pick<SupabaseClient, 'rpc'>,
  accountId: string,
  period: ReportPeriod,
  timezone: string,
): Promise<TeamStats[]> {
  const { start, end } = originPeriodBounds(period, timezone)
  const { data, error } = await db.rpc('team_report', { p_account_id: accountId, p_start: start, p_end: end })
  if (error) throw error
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    userId: String(r.user_id),
    handled: num(r.handled),
    resolved: num(r.resolved),
    firstResponseAvgSeconds: r.first_response_avg_seconds == null ? null : num(r.first_response_avg_seconds),
    tasksCompleted: num(r.tasks_completed),
    openAssigned: num(r.open_assigned),
    dealsWon: num(r.deals_won),
    dealsLost: num(r.deals_lost),
    wonValue: num(r.won_value),
  }))
}

/** won / (won + lost) as a percentage with one decimal; null when nothing was closed. */
export function winRatePct(won: number, lost: number): number | null {
  const closed = won + lost
  return closed > 0 ? Math.round((1000 * won) / closed) / 10 : null
}

/** Most sales first, then the busiest, then by name. */
export function sortTeam(rows: TeamStats[], nameOf: (id: string) => string): TeamStats[] {
  return [...rows].sort(
    (a, b) => b.wonValue - a.wonValue || b.handled - a.handled || nameOf(a.userId).localeCompare(nameOf(b.userId)),
  )
}
