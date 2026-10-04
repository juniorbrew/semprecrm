import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const reopenBlockedBy = vi.fn()
const findOtherActiveConversation = vi.fn()
const insertConversationEvent = vi.fn()
const updateConversationAssignee = vi.fn()

vi.mock('@/lib/conversations/find-by-contact', () => ({
  reopenBlockedBy: (...a: unknown[]) => reopenBlockedBy(...a),
  findOtherActiveConversation: (...a: unknown[]) => findOtherActiveConversation(...a),
}))
vi.mock('@/lib/conversations/events', () => ({
  insertConversationEvent: (...a: unknown[]) => insertConversationEvent(...a),
}))
vi.mock('@/lib/conversations/assign', () => ({
  updateConversationAssignee: (...a: unknown[]) => updateConversationAssignee(...a),
}))

import { claimRow, setRowSnooze, setRowStatus } from './row-actions'

const actor = { accountId: 'acc', userId: 'me', name: 'Ana' }
const conv = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  status: 'open' as const,
  contact_id: 'k1',
  assigned_agent_id: undefined as string | undefined,
  ...over,
})

function fakeDb(error: { code?: string; message: string } | null = null) {
  const calls: { table: string; patch: unknown; id: unknown }[] = []
  const db = {
    from: (table: string) => ({
      update: (patch: unknown) => ({
        eq: async (_col: string, id: unknown) => {
          calls.push({ table, patch, id })
          return { error }
        },
      }),
    }),
  }
  return { db: db as unknown as SupabaseClient, calls }
}

beforeEach(() => {
  reopenBlockedBy.mockResolvedValue(null)
  findOtherActiveConversation.mockResolvedValue(null)
  insertConversationEvent.mockResolvedValue(null)
})

describe('setRowStatus', () => {
  it('resolves: writes status closed and logs the same event as the header', async () => {
    const { db, calls } = fakeDb()
    expect(await setRowStatus(db, conv(), 'closed', actor)).toEqual({ status: 'ok' })
    expect(calls).toEqual([{ table: 'conversations', patch: { status: 'closed' }, id: 'c1' }])
    expect(insertConversationEvent).toHaveBeenCalledWith(db, {
      account_id: 'acc',
      conversation_id: 'c1',
      actor_user_id: 'me',
      event_type: 'status_changed',
      payload: { actor_name: 'Ana', status: 'closed', previous_status: 'open' },
    })
  })

  it('is a no-op when the status already matches', async () => {
    const { db, calls } = fakeDb()
    expect(await setRowStatus(db, conv({ status: 'closed' }), 'closed', actor)).toEqual({ status: 'ok' })
    expect(calls).toHaveLength(0)
    expect(insertConversationEvent).not.toHaveBeenCalled()
  })

  it('reopen is refused while the contact has another live conversation', async () => {
    reopenBlockedBy.mockResolvedValue({ id: 'other' })
    const { db, calls } = fakeDb()
    expect(await setRowStatus(db, conv({ status: 'closed' }), 'open', actor)).toEqual({ status: 'blocked', otherId: 'other' })
    expect(calls).toHaveLength(0)
  })

  it('a lost reopen race (23505) reports the conversation that won', async () => {
    findOtherActiveConversation.mockResolvedValue({ id: 'newer' })
    const { db } = fakeDb({ code: '23505', message: 'dup' })
    expect(await setRowStatus(db, conv({ status: 'closed' }), 'open', actor)).toEqual({ status: 'blocked', otherId: 'newer' })
  })

  it('other errors fail without logging an event', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = fakeDb({ message: 'rls' })
    expect(await setRowStatus(db, conv(), 'closed', actor)).toEqual({ status: 'failed' })
    expect(insertConversationEvent).not.toHaveBeenCalled()
  })
})

describe('claimRow', () => {
  it('assigns to me as a compare-and-set and logs a self-assignment', async () => {
    updateConversationAssignee.mockResolvedValue({ status: 'ok' })
    const { db } = fakeDb()
    expect(await claimRow(db, conv(), actor)).toEqual({ status: 'ok' })
    expect(updateConversationAssignee).toHaveBeenCalledWith(db, { conversationId: 'c1', agentId: 'me', expectCurrent: null })
    expect(insertConversationEvent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        event_type: 'assigned',
        payload: expect.objectContaining({ assignee_user_id: 'me', self_assigned: true }),
      }),
    )
  })

  it('reports who won when a teammate claimed it first', async () => {
    updateConversationAssignee.mockResolvedValue({ status: 'conflict', assignee: 'bob' })
    const { db } = fakeDb()
    expect(await claimRow(db, conv({ assigned_agent_id: 'old' }), actor)).toEqual({ status: 'conflict', assignee: 'bob' })
    expect(updateConversationAssignee).toHaveBeenCalledWith(db, { conversationId: 'c1', agentId: 'me', expectCurrent: 'old' })
    expect(insertConversationEvent).not.toHaveBeenCalled()
  })

  it('fails cleanly', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    updateConversationAssignee.mockResolvedValue({ status: 'failed', error: 'x' })
    const { db } = fakeDb()
    expect(await claimRow(db, conv(), actor)).toEqual({ status: 'failed' })
  })
})

describe('setRowSnooze (079)', () => {
  function snoozeDb(result: { data: unknown; error: { code?: string; message: string } | null }) {
    const calls: { patch: unknown; id: unknown }[] = []
    const db = {
      from: () => ({
        update: (patch: unknown) => ({
          eq: (_c: string, id: unknown) => ({
            select: () => ({
              maybeSingle: async () => {
                calls.push({ patch, id })
                return result
              },
            }),
          }),
        }),
      }),
    } as unknown as SupabaseClient
    return { db, calls }
  }

  it('writes snoozed_until and the trimmed note, nothing else, no event of its own', async () => {
    const row = { snoozed_until: 'T', snoozed_at: 'N', snoozed_by: 'me', snooze_note: 'x', snooze_woke_at: null, unread_count: 0 }
    const { db, calls } = snoozeDb({ data: row, error: null })
    await expect(setRowSnooze(db, 'c1', 'T', '  boleto  ')).resolves.toEqual({ status: 'ok', row })
    expect(calls).toEqual([{ patch: { snoozed_until: 'T', snooze_note: 'boleto' }, id: 'c1' }])
    expect(insertConversationEvent).not.toHaveBeenCalled()
  })

  it('waking always sends snooze_note: null', async () => {
    const { db, calls } = snoozeDb({ data: { snoozed_until: null }, error: null })
    await setRowSnooze(db, 'c1', null, 'ignored')
    expect(calls[0].patch).toEqual({ snoozed_until: null, snooze_note: null })
  })

  it('maps the guard errors and an RLS no-op', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const [code, error] of [['22023', 'out_of_range'], ['23514', 'not_live'], ['42501', 'failed']] as const) {
      const { db } = snoozeDb({ data: null, error: { code, message: 'x' } })
      await expect(setRowSnooze(db, 'c1', 'T', null)).resolves.toEqual({ status: 'failed', error })
    }
    const { db } = snoozeDb({ data: null, error: null })
    await expect(setRowSnooze(db, 'c1', 'T', null)).resolves.toEqual({ status: 'failed', error: 'failed' })
  })
})
