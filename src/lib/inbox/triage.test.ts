import { describe, expect, it } from 'vitest'

import {
  DEFAULT_TRIAGE,
  migrateTriage,
  tabConversations,
  tabCounts,
  tabForConversation,
} from './triage'

type Conv = {
  id: string
  status: 'open' | 'pending' | 'closed'
  archived_at?: string | null
  assigned_agent_id?: string
  last_message_at?: string
}

const conv = (id: string, over: Partial<Conv> = {}): Conv => ({
  id,
  status: 'open',
  last_message_at: '2026-09-01T10:00:00Z',
  ...over,
})

const list: Conv[] = [
  conv('open-mine', { assigned_agent_id: 'u1' }),
  conv('pending-mine', { status: 'pending', assigned_agent_id: 'u1' }),
  conv('open-other', { assigned_agent_id: 'u2' }),
  conv('closed-mine-old', { status: 'closed', assigned_agent_id: 'u1', last_message_at: '2026-08-01T10:00:00Z' }),
  conv('closed-new', { status: 'closed', last_message_at: '2026-09-20T10:00:00Z' }),
  conv('archived', { status: 'closed', archived_at: '2026-09-21T10:00:00Z' }),
]
const ids = (rows: Conv[]) => rows.map((c) => c.id)

describe('tabConversations', () => {
  it('Minhas / Todas only show live conversations', () => {
    const opts = { live: 'live' as const, userId: 'u1' }
    expect(ids(tabConversations(list, 'mine', opts))).toEqual(['open-mine', 'pending-mine'])
    expect(ids(tabConversations(list, 'all', opts))).toEqual(['open-mine', 'pending-mine', 'open-other'])
  })

  it('the live filter narrows to open or pending', () => {
    expect(ids(tabConversations(list, 'all', { live: 'open', userId: 'u1' }))).toEqual(['open-mine', 'open-other'])
    expect(ids(tabConversations(list, 'mine', { live: 'pending', userId: 'u1' }))).toEqual(['pending-mine'])
  })

  it('Encerradas: closed, not archived, newest first', () => {
    expect(ids(tabConversations(list, 'closed', { live: 'open', userId: 'u1' }))).toEqual(['closed-new', 'closed-mine-old'])
  })

  it('Arquivadas: archived only', () => {
    expect(ids(tabConversations(list, 'archived', { live: 'live', userId: 'u1' }))).toEqual(['archived'])
  })

  it('a resolved conversation leaves Minhas', () => {
    const resolved = list.map((c) => (c.id === 'open-mine' ? { ...c, status: 'closed' as const } : c))
    expect(ids(tabConversations(resolved, 'mine', { live: 'live', userId: 'u1' }))).toEqual(['pending-mine'])
    expect(ids(tabConversations(resolved, 'closed', { live: 'live', userId: 'u1' }))).toContain('open-mine')
  })
})

describe('tabCounts', () => {
  it('matches the list lengths', () => {
    for (const live of ['live', 'open', 'pending'] as const) {
      const counts = tabCounts(list, { live, userId: 'u1', queueLength: 7 })
      expect(counts.queue).toBe(7)
      for (const tab of ['mine', 'all', 'closed', 'archived'] as const) {
        expect(counts[tab]).toBe(tabConversations(list, tab, { live, userId: 'u1' }).length)
      }
    }
  })

  it('mine is 0 without a user', () => {
    expect(tabCounts(list, { live: 'live', userId: null, queueLength: 0 }).mine).toBe(0)
  })
})

describe('tabForConversation', () => {
  it('points closed / archived deep links at their tab', () => {
    expect(tabForConversation(conv('x', { status: 'closed' }))).toBe('closed')
    expect(tabForConversation(conv('x', { status: 'closed', archived_at: 'x' }))).toBe('archived')
    expect(tabForConversation(conv('x', { status: 'pending' }))).toBeNull()
  })
})

describe('migrateTriage', () => {
  it('maps the legacy status chip', () => {
    expect(migrateTriage({ tab: 'mine', status: 'closed' })).toEqual({ ...DEFAULT_TRIAGE, tab: 'closed', live: 'live' })
    expect(migrateTriage({ tab: 'all', status: 'archived' })).toEqual({ ...DEFAULT_TRIAGE, tab: 'archived', live: 'live' })
    expect(migrateTriage({ tab: 'mine', status: 'all' })).toEqual({ ...DEFAULT_TRIAGE, tab: 'mine', live: 'live' })
    expect(migrateTriage({ tab: 'mine', status: 'open' })).toEqual({ ...DEFAULT_TRIAGE, tab: 'mine', live: 'open' })
    expect(migrateTriage({ tab: 'all', status: 'pending' })).toEqual({ ...DEFAULT_TRIAGE, tab: 'all', live: 'pending' })
    expect(migrateTriage({ tab: 'queue', status: 'closed' })).toEqual({ ...DEFAULT_TRIAGE, tab: 'queue', live: 'live' })
    expect(migrateTriage({ tab: 'unassigned', status: 'open' })).toEqual({ ...DEFAULT_TRIAGE, tab: 'queue', live: 'open' })
  })

  it('keeps the new shape and falls back on garbage', () => {
    expect(migrateTriage({ tab: 'closed', live: 'pending' })).toEqual({ ...DEFAULT_TRIAGE, tab: 'closed', live: 'pending' })
    expect(migrateTriage({ tab: 'nope', live: 'nope' })).toEqual(DEFAULT_TRIAGE)
    expect(migrateTriage(null)).toEqual(DEFAULT_TRIAGE)
    expect(migrateTriage({ tab: 'all', live: 'live' })).toEqual(DEFAULT_TRIAGE)
    expect(migrateTriage('x')).toEqual(DEFAULT_TRIAGE)
  })

  it('persists tag and channel filters, dropping anything malformed', () => {
    const id = '11111111-1111-4111-8111-111111111111'
    expect(migrateTriage({ tab: 'all', live: 'live', tagIds: [id, id, 'x', 5], channel: 'qr' })).toEqual({
      ...DEFAULT_TRIAGE,
      tagIds: [id],
      channel: 'qr',
    })
    expect(migrateTriage({ tab: 'all', live: 'live', tagIds: 'nope', channel: 'sms' })).toEqual(DEFAULT_TRIAGE)
  })

  it('persists the category and priority filters (071), dropping anything malformed', () => {
    const id = '11111111-1111-4111-8111-111111111111'
    expect(migrateTriage({ tab: 'all', live: 'live', categoryId: id, priority: 'urgent' })).toEqual({
      ...DEFAULT_TRIAGE,
      categoryId: id,
      priority: 'urgent',
    })
    expect(migrateTriage({ tab: 'all', live: 'live', categoryId: 'x', priority: 'critical' })).toEqual(DEFAULT_TRIAGE)
  })
})
