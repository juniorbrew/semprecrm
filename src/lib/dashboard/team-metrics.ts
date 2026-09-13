// ============================================================
// Team metrics — per-member numbers for the dashboard "Equipe" block
// (spec round 2 §1).
//
// `loadTeamMetrics` pulls the raw rows for the period (members,
// messages sent by agents, `status_changed → closed` events, first
// responses, completed tasks, open assignments) with the caller's RLS-
// scoped client and hands them to the pure `aggregateTeamMetrics`,
// which is what the unit tests exercise.
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

export interface TeamMetricsInput {
  members: TeamMember[]
  /** Agent messages in the period: who sent it and to which conversation. */
  agentMessages: { conversation_id: string; sender_id: string | null }[]
  /** `conversation_events` rows of type status_changed in the period. */
  statusEvents: { actor_user_id: string | null; payload: { status?: string } | null }[]
  /** Conversations whose first response landed in the period. */
  firstResponses: { first_response_by: string | null; first_response_seconds: number | null }[]
  /** Tasks completed in the period. */
  completedTasks: { assignee_user_id: string | null }[]
  /** Conversations open right now with an assignee. */
  openAssigned: { assigned_agent_id: string | null }[]
}

export interface TeamMetricsResult {
  period: TeamPeriod
  rows: TeamMetricsRow[]
  /** Longest average first-response among the rows — the bar's 100%. */
  maxFirstResponseAvgSeconds: number
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((a, b) => a + b, 0) / values.length
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

  const handledSets = new Map<string, Set<string>>()
  for (const msg of input.agentMessages) {
    if (!msg.sender_id || !byUser.has(msg.sender_id)) continue
    let set = handledSets.get(msg.sender_id)
    if (!set) {
      set = new Set()
      handledSets.set(msg.sender_id, set)
    }
    set.add(msg.conversation_id)
  }
  for (const [userId, set] of handledSets) byUser.get(userId)!.handled = set.size

  for (const ev of input.statusEvents) {
    if (!ev.actor_user_id || ev.payload?.status !== 'closed') continue
    const row = byUser.get(ev.actor_user_id)
    if (row) row.resolved += 1
  }

  const samples = new Map<string, number[]>()
  for (const fr of input.firstResponses) {
    if (!fr.first_response_by || fr.first_response_seconds === null) continue
    if (!byUser.has(fr.first_response_by)) continue
    if (!Number.isFinite(fr.first_response_seconds) || fr.first_response_seconds < 0) continue
    let arr = samples.get(fr.first_response_by)
    if (!arr) {
      arr = []
      samples.set(fr.first_response_by, arr)
    }
    arr.push(fr.first_response_seconds)
  }
  for (const [userId, arr] of samples) {
    const row = byUser.get(userId)!
    row.firstResponseAvgSeconds = mean(arr)
    row.firstResponseMedianSeconds = median(arr)
    row.firstResponseSamples = arr.length
  }

  for (const task of input.completedTasks) {
    if (!task.assignee_user_id) continue
    const row = byUser.get(task.assignee_user_id)
    if (row) row.tasksCompleted += 1
  }

  for (const conv of input.openAssigned) {
    if (!conv.assigned_agent_id) continue
    const row = byUser.get(conv.assigned_agent_id)
    if (row) row.openAssigned += 1
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

  const [members, agentMessages, statusEvents, firstResponses, completedTasks, openAssigned] =
    await Promise.all([
      db
        .from('profiles')
        .select('user_id, full_name, avatar_url, account_role, availability')
        .eq('account_id', accountId)
        .order('full_name', { ascending: true }),
      // messages has no account_id: join through conversations.
      db
        .from('messages')
        .select('conversation_id, sender_id, conversations!inner(account_id)')
        .eq('conversations.account_id', accountId)
        .eq('sender_type', 'agent')
        .not('sender_id', 'is', null)
        .gte('created_at', since),
      db
        .from('conversation_events')
        .select('actor_user_id, payload')
        .eq('account_id', accountId)
        .eq('event_type', 'status_changed')
        .gte('created_at', since),
      db
        .from('conversations')
        .select('first_response_by, first_response_seconds')
        .eq('account_id', accountId)
        .not('first_response_at', 'is', null)
        .gte('first_response_at', since),
      db
        .from('tasks')
        .select('assignee_user_id')
        .eq('account_id', accountId)
        .not('completed_at', 'is', null)
        .gte('completed_at', since),
      db
        .from('conversations')
        .select('assigned_agent_id')
        .eq('account_id', accountId)
        .eq('status', 'open')
        .not('assigned_agent_id', 'is', null),
    ])

  for (const r of [members, agentMessages, statusEvents, firstResponses, openAssigned]) {
    if (r.error) throw r.error
  }
  // The tasks module may be off / the table missing on older forks —
  // treat a failure there as "no tasks" rather than hiding the block.
  const tasks = completedTasks.error ? [] : (completedTasks.data ?? [])

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
      agentMessages: (agentMessages.data ?? []) as TeamMetricsInput['agentMessages'],
      statusEvents: (statusEvents.data ?? []) as TeamMetricsInput['statusEvents'],
      firstResponses: (firstResponses.data ?? []) as TeamMetricsInput['firstResponses'],
      completedTasks: tasks as TeamMetricsInput['completedTasks'],
      openAssigned: (openAssigned.data ?? []) as TeamMetricsInput['openAssigned'],
    },
    period,
  )
}
