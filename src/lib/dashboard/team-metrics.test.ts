import { describe, expect, it } from 'vitest'

import {
  aggregateTeamMetrics,
  formatSeconds,
  median,
  sortTeamRows,
  type TeamMetricsInput,
} from './team-metrics'

const members: TeamMetricsInput['members'] = [
  { user_id: 'ana', full_name: 'Ana', avatar_url: null, role: 'admin', availability: 'available' },
  { user_id: 'bia', full_name: 'Bia', avatar_url: null, role: 'agent', availability: 'away' },
  { user_id: 'caio', full_name: 'Caio', avatar_url: null, role: 'viewer', availability: null },
]

const empty: TeamMetricsInput = { members, stats: [] }

const stat = (user_id: string, extra: Partial<TeamMetricsInput['stats'][number]> = {}) => ({
  user_id,
  handled: 0,
  resolved: 0,
  first_response_avg_seconds: null,
  first_response_median_seconds: null,
  first_response_samples: 0,
  tasks_completed: 0,
  open_assigned: 0,
  ...extra,
})

// The counting rules (distinct handled conversations, closes by actor,
// first-response mean/median, tasks, open assignments) live in SQL since
// migration 085 and are tested in supabase/tests/dashboard_team_metrics.sql.
describe('aggregateTeamMetrics', () => {
  it('gives every member a zero row and keeps the roster order', () => {
    const r = aggregateTeamMetrics(empty, 30)
    expect(r.period).toBe(30)
    expect(r.rows.map((x) => x.user_id)).toEqual(['ana', 'bia', 'caio'])
    expect(r.rows[0]).toMatchObject({
      handled: 0,
      resolved: 0,
      firstResponseAvgSeconds: null,
      firstResponseMedianSeconds: null,
      firstResponseSamples: 0,
      tasksCompleted: 0,
      openAssigned: 0,
      availability: 'available',
    })
    // Unknown / null availability reads as available; 'away' survives.
    expect(r.rows[1].availability).toBe('away')
    expect(r.rows[2].availability).toBe('available')
    expect(r.maxFirstResponseAvgSeconds).toBe(0)
  })

  it('puts each member numbers on their row, drops non-members, sets the bar maximum', () => {
    const r = aggregateTeamMetrics(
      {
        members,
        stats: [
          stat('ana', {
            handled: 2,
            resolved: 2,
            first_response_avg_seconds: 260,
            first_response_median_seconds: 120,
            first_response_samples: 3,
            tasks_completed: 2,
          }),
          stat('bia', { handled: 1, first_response_avg_seconds: 60, first_response_median_seconds: 60, first_response_samples: 2, open_assigned: 3 }),
          stat('ghost', { handled: 9, first_response_avg_seconds: 9999, first_response_samples: 1 }),
        ],
      },
      90,
    )
    expect(r.rows.map((x) => x.user_id)).toEqual(['ana', 'bia', 'caio'])
    const by = Object.fromEntries(r.rows.map((x) => [x.user_id, x]))
    expect(by.ana).toMatchObject({
      handled: 2,
      resolved: 2,
      firstResponseAvgSeconds: 260,
      firstResponseMedianSeconds: 120,
      firstResponseSamples: 3,
      tasksCompleted: 2,
      openAssigned: 0,
    })
    expect(by.bia).toMatchObject({ handled: 1, firstResponseAvgSeconds: 60, openAssigned: 3 })
    expect(by.caio).toMatchObject({ handled: 0, firstResponseAvgSeconds: null })
    // ghost is not a member: neither a row nor the bar's 100%.
    expect(r.maxFirstResponseAvgSeconds).toBe(260)
  })
})

describe('median', () => {
  it('handles odd, even and empty samples', () => {
    expect(median([])).toBeNull()
    expect(median([5])).toBe(5)
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })
})

describe('sortTeamRows', () => {
  const rows = aggregateTeamMetrics(
    {
      members,
      stats: [
        stat('bia', { handled: 2, first_response_avg_seconds: 20, first_response_median_seconds: 20, first_response_samples: 1 }),
        stat('ana', { handled: 1, first_response_avg_seconds: 300, first_response_median_seconds: 300, first_response_samples: 1 }),
      ],
    },
    7,
  ).rows

  it('sorts numeric columns both ways with a name tiebreak', () => {
    expect(sortTeamRows(rows, 'handled', 'desc').map((r) => r.user_id)).toEqual(['bia', 'ana', 'caio'])
    expect(sortTeamRows(rows, 'handled', 'asc').map((r) => r.user_id)).toEqual(['caio', 'ana', 'bia'])
  })

  it('sinks members without a first response to the end in either direction', () => {
    expect(sortTeamRows(rows, 'firstResponse', 'asc').map((r) => r.user_id)).toEqual(['bia', 'ana', 'caio'])
    expect(sortTeamRows(rows, 'firstResponse', 'desc').map((r) => r.user_id)).toEqual(['ana', 'bia', 'caio'])
  })

  it('sorts by name', () => {
    expect(sortTeamRows(rows, 'name', 'desc').map((r) => r.user_id)).toEqual(['caio', 'bia', 'ana'])
  })
})

describe('formatSeconds', () => {
  it('formats seconds, minutes, hours and days', () => {
    expect(formatSeconds(null)).toBe('—')
    expect(formatSeconds(42)).toBe('42 s')
    expect(formatSeconds(60)).toBe('1 min')
    expect(formatSeconds(95)).toBe('1 min 35 s')
    expect(formatSeconds(3900)).toBe('1 h 05 min')
    expect(formatSeconds(90000)).toBe('1 d 1 h')
  })
})
