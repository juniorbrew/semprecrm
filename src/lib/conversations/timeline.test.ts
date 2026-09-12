import { describe, expect, it } from 'vitest'
import { buildThreadTimeline, groupTimelineByDay } from './timeline'
import type { ContactNote, Message } from '@/types'
import type { ConversationEvent } from './events'

function msg(id: string, at: string): Message {
  return {
    id,
    conversation_id: 'c',
    sender_type: 'customer',
    content_type: 'text',
    content_text: id,
    status: 'sent',
    created_at: at,
  }
}
function note(id: string, at: string): ContactNote {
  return { id, contact_id: 'k', user_id: 'u', note_text: id, created_at: at }
}
function evt(id: string, at: string): ConversationEvent {
  return { id, conversation_id: 'c', type: 'status_changed', status: 'closed', created_at: at }
}

describe('buildThreadTimeline', () => {
  it('interleaves by created_at across kinds', () => {
    const items = buildThreadTimeline(
      [msg('m1', '2026-09-12T10:00:00Z'), msg('m2', '2026-09-12T12:00:00Z')],
      [note('n1', '2026-09-12T11:00:00Z')],
      [evt('e1', '2026-09-12T11:30:00Z')],
    )
    expect(items.map((i) => i.id)).toEqual(['m:m1', 'n:n1', 'e:e1', 'm:m2'])
  })

  it('keeps message, note, event order on identical stamps and is stable', () => {
    const t = '2026-09-12T10:00:00Z'
    const items = buildThreadTimeline(
      [msg('m1', t)],
      [note('n1', t), note('n2', t)],
      [evt('e1', t)],
    )
    expect(items.map((i) => i.id)).toEqual(['m:m1', 'n:n1', 'n:n2', 'e:e1'])
  })

  it('tolerates garbage timestamps by sorting them first', () => {
    const items = buildThreadTimeline([msg('m1', '2026-09-12T10:00:00Z')], [], [
      evt('e1', 'garbage'),
    ])
    expect(items[0].id).toBe('e:e1')
  })
})

describe('groupTimelineByDay', () => {
  it('buckets consecutive items by local day', () => {
    const items = buildThreadTimeline(
      [msg('m1', '2026-09-10T12:00:00'), msg('m2', '2026-09-11T12:00:00')],
      [note('n1', '2026-09-11T13:00:00')],
      [],
    )
    const groups = groupTimelineByDay(items)
    expect(groups).toHaveLength(2)
    expect(groups[0].items.map((i) => i.id)).toEqual(['m:m1'])
    expect(groups[1].items.map((i) => i.id)).toEqual(['m:m2', 'n:n1'])
    expect(groups[1].date).toBe('2026-09-11T12:00:00')
  })

  it('returns nothing for an empty timeline', () => {
    expect(groupTimelineByDay([])).toEqual([])
  })
})
