import { describe, expect, it } from 'vitest'

import { updateConversationAssignee } from './assign'

function fakeDb(opts: { updated: unknown[] | null; error?: { message: string } | null; fresh?: unknown }) {
  const calls: { op: string; args: unknown[] }[][] = []
  const db = {
    from(table: string) {
      expect(table).toBe('conversations')
      const ops: { op: string; args: unknown[] }[] = []
      calls.push(ops)
      const b: Record<string, unknown> = {}
      for (const op of ['update', 'eq', 'is', 'select']) {
        b[op] = (...args: unknown[]) => (ops.push({ op, args }), b)
      }
      b.maybeSingle = async () => ({ data: opts.fresh ?? null, error: null })
      b.then = (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: opts.updated, error: opts.error ?? null }).then(res)
      return b
    },
  }
  return { db: db as never, calls }
}

describe('updateConversationAssignee', () => {
  it('claims an unassigned conversation only while it is still unassigned', async () => {
    const { db, calls } = fakeDb({ updated: [{ id: 'conv-1' }] })
    await expect(
      updateConversationAssignee(db, { conversationId: 'conv-1', agentId: 'me', expectCurrent: null }),
    ).resolves.toEqual({ status: 'ok' })
    expect(calls[0]).toContainEqual({ op: 'update', args: [{ assigned_agent_id: 'me' }] })
    expect(calls[0]).toContainEqual({ op: 'is', args: ['assigned_agent_id', null] })
  })

  it('takes over from the teammate it last saw (compare-and-set on that id)', async () => {
    const { db, calls } = fakeDb({ updated: [{ id: 'conv-1' }] })
    await updateConversationAssignee(db, { conversationId: 'conv-1', agentId: 'me', expectCurrent: 'ana' })
    expect(calls[0]).toContainEqual({ op: 'eq', args: ['assigned_agent_id', 'ana'] })
  })

  it('reports a conflict and who holds it now when someone was faster', async () => {
    const { db } = fakeDb({ updated: [], fresh: { assigned_agent_id: 'bia' } })
    await expect(
      updateConversationAssignee(db, { conversationId: 'conv-1', agentId: 'me', expectCurrent: null }),
    ).resolves.toEqual({ status: 'conflict', assignee: 'bia' })
  })

  it('writes unconditionally without expectCurrent and surfaces errors', async () => {
    const plain = fakeDb({ updated: [] })
    await expect(
      updateConversationAssignee(plain.db, { conversationId: 'conv-1', agentId: null }),
    ).resolves.toEqual({ status: 'ok' })
    expect(plain.calls[0].some((c) => c.op === 'is' || (c.op === 'eq' && c.args[0] === 'assigned_agent_id'))).toBe(false)

    const failing = fakeDb({ updated: null, error: { message: 'permission denied' } })
    await expect(
      updateConversationAssignee(failing.db, { conversationId: 'conv-1', agentId: 'me', expectCurrent: null }),
    ).resolves.toEqual({ status: 'failed', error: 'permission denied' })
  })
})
