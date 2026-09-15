import { describe, expect, it } from 'vitest'
import {
  inboxConversationHref,
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
