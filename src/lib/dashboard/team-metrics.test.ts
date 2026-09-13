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

const empty: TeamMetricsInput = {
  members,
  agentMessages: [],
  statusEvents: [],
  firstResponses: [],
  completedTasks: [],
  openAssigned: [],
}

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

  it('counts handled conversations as distinct per user', () => {
    const r = aggregateTeamMetrics(
      {
        ...empty,
        agentMessages: [
          { conversation_id: 'c1', sender_id: 'ana' },
          { conversation_id: 'c1', sender_id: 'ana' },
          { conversation_id: 'c2', sender_id: 'ana' },
          { conversation_id: 'c2', sender_id: 'bia' },
          { conversation_id: 'c3', sender_id: null },
          { conversation_id: 'c4', sender_id: 'ghost' },
        ],
      },
      7,
    )
    const by = Object.fromEntries(r.rows.map((x) => [x.user_id, x]))
    expect(by.ana.handled).toBe(2)
    expect(by.bia.handled).toBe(1)
    expect(by.caio.handled).toBe(0)
  })

  it('counts only status_changed → closed as resolved, by actor', () => {
    const r = aggregateTeamMetrics(
      {
        ...empty,
        statusEvents: [
          { actor_user_id: 'ana', payload: { status: 'closed' } },
          { actor_user_id: 'ana', payload: { status: 'closed' } },
          { actor_user_id: 'ana', payload: { status: 'open' } },
          { actor_user_id: 'bia', payload: { status: 'pending' } },
          { actor_user_id: null, payload: { status: 'closed' } },
          { actor_user_id: 'bia', payload: null },
        ],
      },
      7,
    )
    const by = Object.fromEntries(r.rows.map((x) => [x.user_id, x]))
    expect(by.ana.resolved).toBe(2)
    expect(by.bia.resolved).toBe(0)
  })

  it('computes mean and median first-response per responder and the bar maximum', () => {
    const r = aggregateTeamMetrics(
      {
        ...empty,
        firstResponses: [
          { first_response_by: 'ana', first_response_seconds: 60 },
          { first_response_by: 'ana', first_response_seconds: 120 },
          { first_response_by: 'ana', first_response_seconds: 600 },
          { first_response_by: 'bia', first_response_seconds: 30 },
          { first_response_by: 'bia', first_response_seconds: 90 },
          { first_response_by: null, first_response_seconds: 5 },
          { first_response_by: 'ana', first_response_seconds: null },
          { first_response_by: 'ana', first_response_seconds: -5 },
        ],
      },
      90,
    )
    const by = Object.fromEntries(r.rows.map((x) => [x.user_id, x]))
    expect(by.ana.firstResponseAvgSeconds).toBe(260)
    expect(by.ana.firstResponseMedianSeconds).toBe(120)
    expect(by.ana.firstResponseSamples).toBe(3)
    expect(by.bia.firstResponseAvgSeconds).toBe(60)
    expect(by.bia.firstResponseMedianSeconds).toBe(60)
    expect(by.caio.firstResponseAvgSeconds).toBeNull()
    expect(r.maxFirstResponseAvgSeconds).toBe(260)
  })

  it('counts completed tasks by assignee and current open assignments', () => {
    const r = aggregateTeamMetrics(
      {
        ...empty,
        completedTasks: [
          { assignee_user_id: 'ana' },
          { assignee_user_id: 'ana' },
          { assignee_user_id: null },
          { assignee_user_id: 'left' },
        ],
        openAssigned: [
          { assigned_agent_id: 'bia' },
          { assigned_agent_id: 'bia' },
          { assigned_agent_id: 'bia' },
          { assigned_agent_id: null },
        ],
      },
      30,
    )
    const by = Object.fromEntries(r.rows.map((x) => [x.user_id, x]))
    expect(by.ana.tasksCompleted).toBe(2)
    expect(by.bia.openAssigned).toBe(3)
    expect(by.ana.openAssigned).toBe(0)
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
      ...empty,
      agentMessages: [
        { conversation_id: 'c1', sender_id: 'bia' },
        { conversation_id: 'c2', sender_id: 'bia' },
        { conversation_id: 'c3', sender_id: 'ana' },
      ],
      firstResponses: [
        { first_response_by: 'ana', first_response_seconds: 300 },
        { first_response_by: 'bia', first_response_seconds: 20 },
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
