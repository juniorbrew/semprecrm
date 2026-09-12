import { describe, expect, it, vi } from 'vitest'
import type { ConversationEventRecord } from '@/types'
import {
  deriveBaselineEvents,
  eventFromRecord,
  formatConversationEvent,
  formatEventAge,
  insertConversationEvent,
  isVisibleEvent,
  upsertEventRecord,
} from './events'

function record(
  over: Partial<ConversationEventRecord> = {},
): ConversationEventRecord {
  return {
    id: 'e1',
    account_id: 'a',
    conversation_id: 'c',
    actor_user_id: 'u1',
    event_type: 'assigned',
    payload: {},
    created_at: '2026-09-12T10:00:00Z',
    ...over,
  }
}

const names = (id: string) => ({ u1: 'Ana', u2: 'Bruno' })[id]

describe('eventFromRecord', () => {
  it('prefers live profile names over the stored snapshot', () => {
    const e = eventFromRecord(
      record({
        payload: { actor_name: 'Old Name', assignee_user_id: 'u2', assignee_name: 'Old B' },
      }),
      names,
    )
    expect(e.type).toBe('assigned')
    expect(e.actor_name).toBe('Ana')
    expect(e.assignee_name).toBe('Bruno')
    expect(e.self_assigned).toBe(false)
  })

  it('falls back to the snapshot for users no longer in the account', () => {
    const e = eventFromRecord(
      record({ actor_user_id: 'gone', payload: { actor_name: 'Carla', assignee_user_id: 'gone', assignee_name: 'Carla' } }),
      names,
    )
    expect(e.actor_name).toBe('Carla')
    expect(e.assignee_name).toBe('Carla')
    expect(e.self_assigned).toBe(true)
  })

  it('infers self-assignment from ids when the payload omits it', () => {
    const e = eventFromRecord(
      record({ actor_user_id: 'u1', payload: { assignee_user_id: 'u1' } }),
      names,
    )
    expect(e.self_assigned).toBe(true)
    expect(e.assignee_name).toBe('Ana')
  })

  it('carries status / label / note details through', () => {
    expect(
      eventFromRecord(
        record({
          event_type: 'status_changed',
          payload: { status: 'closed', previous_status: 'open' },
        }),
      ),
    ).toMatchObject({ type: 'status_changed', status: 'closed', previous_status: 'open' })
    expect(
      eventFromRecord(
        record({ event_type: 'label_added', payload: { tag_id: 't', tag_name: 'VIP' } }),
      ),
    ).toMatchObject({ tag_id: 't', tag_name: 'VIP' })
    expect(
      eventFromRecord(record({ event_type: 'note_added', payload: { note_id: 'n' } })),
    ).toMatchObject({ note_id: 'n' })
  })

  it('tolerates a null actor (automation) and missing payload', () => {
    const e = eventFromRecord(
      { ...record({ actor_user_id: null }), payload: undefined as never },
      names,
    )
    expect(e.actor_name).toBeUndefined()
    expect(e.actor_user_id).toBeNull()
  })
})

describe('upsertEventRecord', () => {
  it('appends in time order and ignores an id already present', () => {
    const a = record({ id: 'a', created_at: '2026-09-12T10:00:00Z' })
    const b = record({ id: 'b', created_at: '2026-09-12T09:00:00Z' })
    const list = upsertEventRecord(upsertEventRecord([], a), b)
    expect(list.map((e) => e.id)).toEqual(['b', 'a'])
    // Realtime echo of the optimistic insert — same id, same list.
    expect(upsertEventRecord(list, { ...a })).toBe(list)
  })
})

describe('insertConversationEvent', () => {
  function fakeClient(result: { data: unknown; error: unknown }) {
    const single = vi.fn().mockResolvedValue(result)
    const select = vi.fn().mockReturnValue({ single })
    const insert = vi.fn().mockReturnValue({ select })
    const from = vi.fn().mockReturnValue({ insert })
    return { client: { from } as never, from, insert }
  }

  it('inserts the row shape the table expects and returns it', async () => {
    const stored = record({ id: 'new' })
    const { client, from, insert } = fakeClient({ data: stored, error: null })
    const out = await insertConversationEvent(client, {
      account_id: 'a',
      conversation_id: 'c',
      actor_user_id: 'u1',
      event_type: 'assigned',
      payload: { assignee_user_id: 'u1' },
    })
    expect(from).toHaveBeenCalledWith('conversation_events')
    expect(insert).toHaveBeenCalledWith({
      account_id: 'a',
      conversation_id: 'c',
      actor_user_id: 'u1',
      event_type: 'assigned',
      payload: { assignee_user_id: 'u1' },
    })
    expect(out).toBe(stored)
  })

  it('returns null (and does not throw) on a database error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { client } = fakeClient({ data: null, error: { message: 'rls' } })
    const out = await insertConversationEvent(client, {
      account_id: 'a',
      conversation_id: 'c',
      actor_user_id: null,
      event_type: 'unassigned',
    })
    expect(out).toBeNull()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('deriveBaselineEvents', () => {
  const conv = {
    id: 'c',
    status: 'closed' as const,
    assigned_agent_id: 'u1',
    updated_at: '2026-09-12T10:00:00Z',
    created_at: '2026-09-01T10:00:00Z',
  }

  it('describes current assignee and status when the log is empty', () => {
    const events = deriveBaselineEvents(conv, [], names)
    expect(events.map((e) => e.type)).toEqual(['assigned', 'status_changed'])
    expect(events.every((e) => e.derived)).toBe(true)
    expect(events[0].assignee_name).toBe('Ana')
    expect(events[0].assignee_user_id).toBe('u1')
    expect(events[1].status).toBe('closed')
  })

  it('skips facts already covered by logged events', () => {
    const logged = [
      eventFromRecord(
        record({ event_type: 'status_changed', payload: { status: 'closed' } }),
      ),
    ]
    const events = deriveBaselineEvents(conv, logged, names)
    expect(events.map((e) => e.type)).toEqual(['assigned'])
    const both = [...logged, eventFromRecord(record({ event_type: 'unassigned' }))]
    expect(deriveBaselineEvents(conv, both, names)).toEqual([])
  })

  it('emits nothing for an open, unassigned conversation', () => {
    expect(
      deriveBaselineEvents(
        { ...conv, status: 'open', assigned_agent_id: undefined },
        [],
        names,
      ),
    ).toEqual([])
  })
})

describe('formatConversationEvent', () => {
  const base = { id: 'e', conversation_id: 'c', created_at: 'x' }

  it('renders pt-BR copy for each shape', () => {
    expect(
      formatConversationEvent(
        { ...base, type: 'assigned', actor_name: 'Ana', assignee_name: 'Ana', self_assigned: true },
        'pt-BR',
      ),
    ).toBe('Ana atribuiu para si')
    expect(
      formatConversationEvent(
        { ...base, type: 'assigned', actor_name: 'Ana', assignee_name: 'Bruno' },
        'pt-BR',
      ),
    ).toBe('Ana atribuiu para Bruno')
    expect(
      formatConversationEvent({ ...base, type: 'assigned', assignee_name: 'Ana' }, 'pt-BR'),
    ).toBe('Atribuída a Ana')
    expect(
      formatConversationEvent({ ...base, type: 'status_changed', status: 'closed' }, 'pt-BR'),
    ).toBe('Conversa resolvida')
    expect(
      formatConversationEvent(
        { ...base, type: 'status_changed', status: 'closed', actor_name: 'Ana' },
        'pt-BR',
      ),
    ).toBe('Ana resolveu a conversa')
    expect(
      formatConversationEvent({ ...base, type: 'label_added', tag_name: 'VIP' }, 'pt-BR'),
    ).toBe('Etiqueta VIP adicionada')
    expect(
      formatConversationEvent(
        { ...base, type: 'label_removed', tag_name: 'VIP', actor_name: 'Ana' },
        'pt-BR',
      ),
    ).toBe('Etiqueta VIP removida por Ana')
    expect(formatConversationEvent({ ...base, type: 'unassigned' }, 'pt-BR')).toBe(
      'Atribuição removida',
    )
    expect(formatConversationEvent({ ...base, type: 'note_added' }, 'pt-BR')).toBe('')
  })

  it('renders en-US copy', () => {
    expect(
      formatConversationEvent({ ...base, type: 'status_changed', status: 'pending' }, 'en-US'),
    ).toBe('Conversation marked pending')
    expect(
      formatConversationEvent(
        { ...base, type: 'assigned', actor_name: 'Ana', assignee_name: 'Ana', self_assigned: true },
        'en-US',
      ),
    ).toBe('Ana self-assigned')
  })
})

describe('isVisibleEvent', () => {
  it('hides note_added (the note bubble is the visible trace)', () => {
    expect(isVisibleEvent({ type: 'note_added' })).toBe(false)
    expect(isVisibleEvent({ type: 'assigned' })).toBe(true)
  })
})

describe('formatEventAge', () => {
  const now = new Date('2026-09-12T12:00:00Z').getTime()
  it('is compact and language-aware', () => {
    expect(formatEventAge('2026-09-12T11:59:50Z', 'pt-BR', now)).toBe('agora')
    expect(formatEventAge('2026-09-12T11:45:00Z', 'pt-BR', now)).toBe('há 15 min')
    expect(formatEventAge('2026-09-12T10:00:00Z', 'pt-BR', now)).toBe('há 2 h')
    expect(formatEventAge('2026-09-10T10:00:00Z', 'pt-BR', now)).toBe('há 2 d')
    expect(formatEventAge('2026-09-12T10:00:00Z', 'en-US', now)).toBe('2h ago')
    expect(formatEventAge('garbage', 'pt-BR', now)).toBe('')
  })
})
