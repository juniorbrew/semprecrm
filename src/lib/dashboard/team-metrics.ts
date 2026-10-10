// ============================================================
// Team metrics — per-member numbers for the dashboard "Equipe" block
// (spec round 2 §1).
//
// `loadTeamMetrics` reads the roster and the per-user numbers that
// migration 086 (`dashboard_team_metrics`) counts in SQL — handled
// conversations, closes, first responses, completed tasks, open
// assignments — and the pure `aggregateTeamMetrics` joins them. The
// counting rules live (and are tested) in SQL: the old raw-row reads
// were capped at PostgREST's max_rows and undercounted busy teams.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import type { AccountRole } from '@/lib/auth/roles'
import { daysAgoStart } from './date-utils'

export type TeamPeriod = 7 | 30 | 90

export interface TeamMember {
  user_id: string
  full_name: string
  avatar_url: string | null
  role: AccountRole | string
  availability?: 'available' | 'away' | string | null
}

export interface TeamMetricsRow {
  user_id: string
  full_name: string
  avatar_url: string | null
  role: string
  availability: 'available' | 'away'
  /** Distinct conversations with at least one message from this user in the period. */
  handled: number
  /** `status_changed` → closed events where this user was the actor. */
  resolved: number
  /** Mean first-response time (seconds) over conversations this user answered first. */
  firstResponseAvgSeconds: number | null
  /** Median of the same sample. */
  firstResponseMedianSeconds: number | null
  /** How many first responses the average is based on. */
  firstResponseSamples: number
  /** Tasks completed by this assignee in the period. */
  tasksCompleted: number
  /** Conversations assigned to this user that are open right now. */
  openAssigned: number
}

/** One row of `dashboard_team_metrics` (migration 086). */
export interface TeamMemberStats {
  user_id: string
  handled: number
  resolved: number
  first_response_avg_seconds: number | null
  first_response_median_seconds: number | null
  first_response_samples: number
  tasks_completed: number
  open_assigned: number
}

export interface TeamMetricsInput {
  members: TeamMember[]
  /** Per-user numbers for the period; users outside the roster are ignored. */
  stats: TeamMemberStats[]
}

export interface TeamMetricsResult {
  period: TeamPeriod
  rows: TeamMetricsRow[]
  /** Longest average first-response among the rows — the bar's 100%. */
  maxFirstResponseAvgSeconds: number
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Pure aggregation. Every member gets a row (zeros when idle); rows
 * whose user is not a member any more are dropped, since the table is
 * the roster with numbers attached. Order is left to the UI.
 */
export function aggregateTeamMetrics(input: TeamMetricsInput, period: TeamPeriod): TeamMetricsResult {
  const byUser = new Map<string, TeamMetricsRow>()
  for (const m of input.members) {
    byUser.set(m.user_id, {
      user_id: m.user_id,
      full_name: m.full_name,
      avatar_url: m.avatar_url,
      role: m.role,
      availability: m.availability === 'away' ? 'away' : 'available',
      handled: 0,
      resolved: 0,
      firstResponseAvgSeconds: null,
      firstResponseMedianSeconds: null,
      firstResponseSamples: 0,
      tasksCompleted: 0,
      openAssigned: 0,
    })
  }

  for (const st of input.stats) {
    const row = byUser.get(st.user_id)
    if (!row) continue
    row.handled = st.handled
    row.resolved = st.resolved
    row.firstResponseAvgSeconds = st.first_response_avg_seconds
    row.firstResponseMedianSeconds = st.first_response_median_seconds
    row.firstResponseSamples = st.first_response_samples
    row.tasksCompleted = st.tasks_completed
    row.openAssigned = st.open_assigned
  }

  const rows = [...byUser.values()]
  const maxFirstResponseAvgSeconds = rows.reduce(
    (max, r) => (r.firstResponseAvgSeconds !== null && r.firstResponseAvgSeconds > max ? r.firstResponseAvgSeconds : max),
    0,
  )
  return { period, rows, maxFirstResponseAvgSeconds }
}

export type TeamSortKey =
  | 'name'
  | 'handled'
  | 'resolved'
  | 'firstResponse'
  | 'tasksCompleted'
  | 'openAssigned'

export type SortDirection = 'asc' | 'desc'

/** Sort helper shared by the UI; nulls (no first response yet) sink to the end. */
export function sortTeamRows(
  rows: TeamMetricsRow[],
  key: TeamSortKey,
  direction: SortDirection,
): TeamMetricsRow[] {
  const dir = direction === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    if (key === 'name') return dir * a.full_name.localeCompare(b.full_name, undefined, { sensitivity: 'base' })
    if (key === 'firstResponse') {
      const av = a.firstResponseAvgSeconds
      const bv = b.firstResponseAvgSeconds
      if (av === null && bv === null) return a.full_name.localeCompare(b.full_name)
      if (av === null) return 1
      if (bv === null) return -1
      return dir * (av - bv)
    }
    const diff = a[key] - b[key]
    return diff !== 0 ? dir * diff : a.full_name.localeCompare(b.full_name)
  })
}

/** "1 min 20 s" / "2 h 05 min" style duration for the table cells. */
export function formatSeconds(seconds: number | null): string {
  if (seconds === null) return '—'
  const s = Math.round(seconds)
  if (s < 60) return `${s} s`
  const minutes = Math.floor(s / 60)
  if (minutes < 60) {
    const rest = s % 60
    return rest > 0 ? `${minutes} min ${rest} s` : `${minutes} min`
  }
  const hours = Math.floor(minutes / 60)
  const restMin = minutes % 60
  if (hours < 24) return `${hours} h ${String(restMin).padStart(2, '0')} min`
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return `${days} d ${restHours} h`
}

/**
 * Load everything the aggregation needs for one account. The caller's
 * RLS already scopes to the account; `accountId` is applied anyway so a
 * member of several accounts (future) never mixes numbers.
 */
export async function loadTeamMetrics(
  db: SupabaseClient,
  accountId: string,
  period: TeamPeriod,
): Promise<TeamMetricsResult> {
  const since = daysAgoStart(period - 1).toISOString()

  const [members, stats] = await Promise.all([
    db
      .from('profiles')
      .select('user_id, full_name, avatar_url, account_role, availability')
      .eq('account_id', accountId)
      .order('full_name', { ascending: true }),
    db.rpc('dashboard_team_metrics', { p_account_id: accountId, p_since: since }),
  ])
  if (members.error) throw members.error
  if (stats.error) throw stats.error

  return aggregateTeamMetrics(
    {
      members: ((members.data ?? []) as {
        user_id: string
        full_name: string | null
        avatar_url: string | null
        account_role: string
        availability: string | null
      }[]).map((p) => ({
        user_id: p.user_id,
        full_name: p.full_name ?? '',
        avatar_url: p.avatar_url,
        role: p.account_role,
        availability: p.availability,
      })),
      stats: (stats.data ?? []) as TeamMemberStats[],
    },
    period,
  )
}
