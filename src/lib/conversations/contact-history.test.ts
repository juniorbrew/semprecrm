import { describe, expect, it, vi } from 'vitest'
import type { Conversation } from '@/types'
import {
  PREVIOUS_CONVERSATIONS_LIMIT,
  contactHistorySummary,
  csatByConversation,
  listCsatAnswersByContact,
  previousConversationRows,
} from './contact-history'

const conv = (id: string, extra: Partial<Conversation> = {}): Conversation =>
  ({
    id,
    user_id: 'u',
    contact_id: 'c1',
    status: 'closed',
    unread_count: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...extra,
  }) as Conversation

const categories = new Map([['cat-1', 'Cobrança']])
const name = (id: string) => categories.get(id)

describe('csatByConversation', () => {
  it('keeps only valid 1–5 scores', () => {
    const map = csatByConversation([
      { conversation_id: 'a', score: 5 },
      { conversation_id: 'b', score: null },
      { conversation_id: 'c', score: 9 },
      { conversation_id: 'd', score: 3 },
    ])
    expect([...map]).toEqual([
      ['a', 5],
      ['d', 3],
    ])
  })
})

describe('previousConversationRows', () => {
  it('drops the open thread, sorts newest first and caps at 5', () => {
    const rows = previousConversationRows(
      Array.from({ length: 8 }, (_, i) =>
        conv(`k${i}`, { last_message_at: `2026-03-0${i + 1}T10:00:00Z` }),
      ),
      'k7',
      new Map(),
      name,
    )
    expect(PREVIOUS_CONVERSATIONS_LIMIT).toBe(5)
    expect(rows.map((r) => r.id)).toEqual(['k6', 'k5', 'k4', 'k3', 'k2'])
  })

  it('titles by subject, then category, then last message; carries status, date and CSAT', () => {
    const rows = previousConversationRows(
      [
        conv('s', { subject: '  Boleto de agosto ', category_id: 'cat-1', last_message_at: '2026-03-03T00:00:00Z' }),
        conv('c', { category_id: 'cat-1', last_message_text: 'oi', last_message_at: '2026-03-02T00:00:00Z' }),
        conv('m', { status: 'open', last_message_text: 'Tudo certo?', last_message_at: '2026-03-01T00:00:00Z' }),
        conv('n', { created_at: '2026-02-01T00:00:00Z' }),
      ],
      null,
      new Map([['s', 5]]),
      name,
    )
    expect(rows.map((r) => [r.title, r.status, r.csat])).toEqual([
      ['Boleto de agosto', 'closed', 5],
      ['Cobrança', 'closed', null],
      ['Tudo certo?', 'open', null],
      [null, 'closed', null],
    ])
    expect(rows[3].at).toBe('2026-02-01T00:00:00Z')
  })
})

describe('contactHistorySummary', () => {
  it('counts conversations, averages CSAT to one decimal and dates the oldest record', () => {
    const summary = contactHistorySummary(
      [conv('a', { created_at: '2025-03-10T00:00:00Z' }), conv('b')],
      new Map([
        ['a', 5],
        ['b', 4],
        ['x', 4],
      ]),
      '2025-05-01T00:00:00Z',
    )
    expect(summary).toEqual({ count: 2, csatAverage: 4.3, since: '2025-03-10T00:00:00.000Z' })
  })

  it('has no average without answers and survives missing dates', () => {
    expect(contactHistorySummary([], new Map(), undefined)).toEqual({ count: 0, csatAverage: null, since: null })
  })
})

describe('listCsatAnswersByContact', () => {
  it('reads answered rows of the contact only', async () => {
    const calls: unknown[][] = []
    const builder = {
      select: (...a: unknown[]) => (calls.push(['select', ...a]), builder),
      eq: (...a: unknown[]) => (calls.push(['eq', ...a]), builder),
      not: (...a: unknown[]) => {
        calls.push(['not', ...a])
        return Promise.resolve({ data: [{ conversation_id: 'a', score: 4 }], error: null })
      },
    }
    const from = vi.fn(() => builder)
    const rows = await listCsatAnswersByContact({ from } as never, 'c1')
    expect(from).toHaveBeenCalledWith('csat_responses')
    expect(calls).toEqual([
      ['select', 'conversation_id, score'],
      ['eq', 'contact_id', 'c1'],
      ['not', 'score', 'is', null],
    ])
    expect(rows).toEqual([{ conversation_id: 'a', score: 4 }])
    expect(await listCsatAnswersByContact({ from } as never, '')).toEqual([])
  })
})
