import { describe, expect, it } from 'vitest'

import type { Message } from '@/types'
import {
  anchoredScrollTop,
  mergeOlder,
  MESSAGE_PAGE_SIZE,
  MESSAGE_RESYNC_MAX,
  missingParentIds,
  olderThanFilter,
  oldestPersisted,
  pageFromNewestFirst,
  resyncLimit,
  withinLoadedWindow,
} from './message-paging'

const msg = (id: string, at: string, over: Partial<Message> = {}): Message => ({
  id,
  conversation_id: 'c1',
  sender_type: 'customer',
  content_type: 'text',
  content_text: id,
  status: 'sent',
  created_at: at,
  ...over,
})

describe('page from a newest-first fetch', () => {
  const rows = ['m5', 'm4', 'm3', 'm2'].map((id, i) => msg(id, `2026-09-30T10:0${5 - i}:00Z`))

  it('drops the probe row, reverses to ascending and flags older rows', () => {
    const { messages, hasMore } = pageFromNewestFirst(rows, 3)
    expect(messages.map((m) => m.id)).toEqual(['m3', 'm4', 'm5'])
    expect(hasMore).toBe(true)
  })

  it('has no older rows when the fetch returned <= limit', () => {
    expect(pageFromNewestFirst(rows, 4).hasMore).toBe(false)
    expect(pageFromNewestFirst([], 50)).toEqual({ messages: [], hasMore: false })
  })
})

describe('older-messages merge', () => {
  const loaded = [msg('m3', '2026-09-30T10:03:00Z'), msg('m4', '2026-09-30T10:04:00Z')]

  it('prepends older rows in ascending order', () => {
    const merged = mergeOlder(loaded, [msg('m2', '2026-09-30T10:02:00Z'), msg('m1', '2026-09-30T10:01:00Z')])
    expect(merged.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4'])
  })

  it('drops rows already loaded (a realtime insert racing the fetch)', () => {
    const merged = mergeOlder(loaded, [msg('m3', '2026-09-30T10:03:00Z'), msg('m2', '2026-09-30T10:02:00Z')])
    expect(merged.map((m) => m.id)).toEqual(['m2', 'm3', 'm4'])
    expect(merged[1]).toBe(loaded[0])
  })

  it('keeps optimistic messages where they are (at the end)', () => {
    const withTemp = [...loaded, msg('temp-1', '2026-09-30T10:09:00Z')]
    expect(mergeOlder(withTemp, [msg('m2', '2026-09-30T10:02:00Z')]).map((m) => m.id)).toEqual(['m2', 'm3', 'm4', 'temp-1'])
  })

  it('orders same-timestamp rows by id', () => {
    const merged = mergeOlder([msg('z', '2026-09-30T10:05:00Z')], [msg('b', '2026-09-30T10:00:00Z'), msg('a', '2026-09-30T10:00:00Z')])
    expect(merged.map((m) => m.id)).toEqual(['a', 'b', 'z'])
  })
})

describe('older cursor', () => {
  it('ignores optimistic messages when picking the oldest', () => {
    const list = [msg('temp-9', '2026-01-01T00:00:00Z'), msg('m2', '2026-09-30T10:02:00Z'), msg('m1', '2026-09-30T10:01:00Z')]
    expect(oldestPersisted(list)?.id).toBe('m1')
    expect(oldestPersisted([])).toBeNull()
  })

  it('builds a quoted (created_at, id) keyset filter', () => {
    expect(olderThanFilter({ id: 'abc', created_at: '2026-09-30T10:01:00.123456+00:00' })).toBe(
      'created_at.lt."2026-09-30T10:01:00.123456+00:00",and(created_at.eq."2026-09-30T10:01:00.123456+00:00",id.lt."abc")',
    )
  })
})

describe('resync size', () => {
  it('refetches at least one page and what is loaded, capped', () => {
    expect(resyncLimit([])).toBe(MESSAGE_PAGE_SIZE)
    const many = Array.from({ length: 120 }, (_, i) => msg(`m${i}`, '2026-09-30T10:00:00Z'))
    expect(resyncLimit(many)).toBe(120)
    expect(resyncLimit([...many, msg('temp-1', '2026-09-30T10:00:00Z')])).toBe(120)
    const huge = Array.from({ length: MESSAGE_RESYNC_MAX + 10 }, (_, i) => msg(`h${i}`, '2026-09-30T10:00:00Z'))
    expect(resyncLimit(huge)).toBe(MESSAGE_RESYNC_MAX)
  })
})

describe('scroll anchor', () => {
  it('keeps the reading position when content is prepended', () => {
    expect(anchoredScrollTop({ scrollTop: 0, scrollHeight: 1000 }, 1800)).toBe(800)
    expect(anchoredScrollTop({ scrollTop: 40, scrollHeight: 1000 }, 1800)).toBe(840)
  })

  it('is a no-op when nothing was added', () => {
    expect(anchoredScrollTop({ scrollTop: 120, scrollHeight: 1000 }, 1000)).toBe(120)
  })
})

describe('window for notes and events', () => {
  const items = [
    { id: 'old', created_at: '2026-09-29T10:00:00Z' },
    { id: 'in', created_at: '2026-09-30T10:03:00Z' },
  ]
  it('hides items older than the oldest loaded message while older pages remain', () => {
    expect(withinLoadedWindow(items, '2026-09-30T10:00:00Z', true).map((i) => i.id)).toEqual(['in'])
  })
  it('shows everything once the whole history is loaded', () => {
    expect(withinLoadedWindow(items, '2026-09-30T10:00:00Z', false)).toHaveLength(2)
    expect(withinLoadedWindow(items, null, true)).toHaveLength(2)
  })
})

describe('quoted messages that are not loaded', () => {
  it('lists unloaded reply parents once, skipping loaded and already-fetched ones', () => {
    const list = [
      msg('m5', '2026-09-30T10:05:00Z', { reply_to_message_id: 'p1' }),
      msg('m6', '2026-09-30T10:06:00Z', { reply_to_message_id: 'p1' }),
      msg('m7', '2026-09-30T10:07:00Z', { reply_to_message_id: 'm5' }),
      msg('m8', '2026-09-30T10:08:00Z', { reply_to_message_id: 'p2' }),
      msg('m9', '2026-09-30T10:09:00Z'),
    ]
    expect(missingParentIds(list, new Set(['p2']))).toEqual(['p1'])
  })
})
