import { describe, expect, it } from 'vitest'
import {
  conversationContinuity,
  findOtherActiveConversation,
  inboxConversationHref,
  reopenBlockedBy,
  pickLatestConversation,
  sortConversationsNewestFirst,
} from './find-by-contact'

describe('inboxConversationHref', () => {
  it('builds the inbox deep link', () => {
    expect(inboxConversationHref('abc-123')).toBe('/inbox?c=abc-123')
  })
})

describe('pickLatestConversation', () => {
  it('returns null for an empty list', () => {
    expect(pickLatestConversation([])).toBeNull()
  })

  it('prefers the most recent last_message_at', () => {
    const rows = [
      {
        id: 'old',
        last_message_at: '2026-01-01T00:00:00Z',
        created_at: '2025-12-01T00:00:00Z',
      },
      {
        id: 'new',
        last_message_at: '2026-03-01T00:00:00Z',
        created_at: '2025-11-01T00:00:00Z',
      },
    ]
    expect(pickLatestConversation(rows)?.id).toBe('new')
  })

  it('falls back to created_at when a conversation has no messages', () => {
    const rows = [
      {
        id: 'quiet',
        last_message_at: undefined,
        created_at: '2026-05-01T00:00:00Z',
      },
      {
        id: 'talked',
        last_message_at: '2026-02-01T00:00:00Z',
        created_at: '2026-01-01T00:00:00Z',
      },
    ]
    expect(pickLatestConversation(rows)?.id).toBe('quiet')
  })
})

describe('sortConversationsNewestFirst', () => {
  it('orders by last_message_at, falling back to created_at', () => {
    const rows = [
      {
        id: 'old',
        last_message_at: '2026-01-01T00:00:00Z',
        created_at: '2025-12-01T00:00:00Z',
      },
      {
        id: 'quiet',
        last_message_at: undefined,
        created_at: '2026-02-15T00:00:00Z',
      },
      {
        id: 'new',
        last_message_at: '2026-03-01T00:00:00Z',
        created_at: '2025-11-01T00:00:00Z',
      },
    ]
    expect(sortConversationsNewestFirst(rows).map((r) => r.id)).toEqual([
      'new',
      'quiet',
      'old',
    ])
  })

  it('does not mutate the input and keeps the first entry in sync with pickLatestConversation', () => {
    const rows = [
      { id: 'a', last_message_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' },
      { id: 'b', last_message_at: '2026-04-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' },
    ]
    const sorted = sortConversationsNewestFirst(rows)
    expect(rows.map((r) => r.id)).toEqual(['a', 'b'])
    expect(sorted[0]?.id).toBe(pickLatestConversation(rows)?.id)
  })

  it('returns an empty array for no rows', () => {
    expect(sortConversationsNewestFirst([])).toEqual([])
  })
})

// ------------------------------------------------------------
// A resolved conversation is final (migration 060).
// ------------------------------------------------------------

const conv = (id: string, status: 'open' | 'pending' | 'closed', created_at: string) => ({
  id,
  status,
  created_at,
  updated_at: created_at,
  last_message_at: created_at,
})

describe('conversationContinuity', () => {
  const old1 = conv('old-1', 'closed', '2026-08-01T00:00:00Z')
  const old2 = conv('old-2', 'closed', '2026-09-01T00:00:00Z')
  const live = conv('live', 'open', '2026-09-20T00:00:00Z')

  it('points a new conversation to the newest resolved one before it', () => {
    const r = conversationContinuity(live, [live, old2, old1])
    expect(r.previousClosed?.id).toBe('old-2')
    expect(r.activeOther).toBeNull()
  })

  it('a resolved thread sees the live conversation that replaced it', () => {
    const r = conversationContinuity(old2, [live, old2, old1])
    expect(r.activeOther?.id).toBe('live')
    expect(r.previousClosed?.id).toBe('old-1')
  })

  it('first conversation: nothing before it, nothing replacing it', () => {
    expect(conversationContinuity(old1, [old1])).toEqual({ previousClosed: null, activeOther: null })
  })

  it('ignores later resolved conversations as "previous"', () => {
    const r = conversationContinuity(old1, [old2, old1])
    expect(r.previousClosed).toBeNull()
  })
})

function clientReturning(rows: unknown[]) {
  const calls: [string, unknown[]][] = []
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'neq', 'order', 'limit']) {
    b[m] = (...args: unknown[]) => (calls.push([m, args]), b)
  }
  b.then = (onF: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(onF)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: { from: () => b } as any, calls }
}

describe('findOtherActiveConversation / reopenBlockedBy', () => {
  it('looks for a non-closed conversation of the contact other than this one', async () => {
    const { client, calls } = clientReturning([{ id: 'live', status: 'open' }])
    const found = await findOtherActiveConversation(client, 'c-1', 'old')
    expect(found?.id).toBe('live')
    expect(calls).toContainEqual(['eq', ['contact_id', 'c-1']])
    expect(calls).toContainEqual(['neq', ['status', 'closed']])
    expect(calls).toContainEqual(['neq', ['id', 'old']])
  })

  it('blocks Reabrir on a resolved thread while a live one exists', async () => {
    const { client } = clientReturning([{ id: 'live', status: 'open' }])
    const old = { id: 'old', status: 'closed' as const, contact_id: 'c-1' }
    expect((await reopenBlockedBy(client, old, 'open'))?.id).toBe('live')
    expect((await reopenBlockedBy(client, old, 'pending'))?.id).toBe('live')
  })

  it('lets Reabrir through when nothing else is live, and ignores non-reopen changes', async () => {
    const none = clientReturning([])
    const old = { id: 'old', status: 'closed' as const, contact_id: 'c-1' }
    expect(await reopenBlockedBy(none.client, old, 'open')).toBeNull()
    const busy = clientReturning([{ id: 'live', status: 'open' }])
    expect(await reopenBlockedBy(busy.client, old, 'closed')).toBeNull()
    expect(await reopenBlockedBy(busy.client, { ...old, status: 'open' }, 'pending')).toBeNull()
    expect(busy.calls).toHaveLength(0)
  })
})
