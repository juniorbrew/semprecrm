import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  claimed: [] as Record<string, unknown>[],
  claimError: null as { code?: string; message: string } | null,
  rpcArgs: [] as Record<string, unknown>[],
  updates: [] as { payload: Record<string, unknown>; id: unknown }[],
  dispatches: [] as Record<string, unknown>[],
  dispatchError: null as Error | null,
}))

vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    rpc: (_fn: string, args: Record<string, unknown>) => {
      h.rpcArgs.push(args)
      return Promise.resolve({ data: h.claimError ? null : h.claimed, error: h.claimError })
    },
    from: () => {
      let payload: Record<string, unknown> = {}
      const b: Record<string, unknown> = {
        update: (p: Record<string, unknown>) => ((payload = p), b),
        eq: (_k: string, v: unknown) => {
          h.updates.push({ payload, id: v })
          return Promise.resolve({ error: null })
        },
      }
      return b
    },
  }),
}))

vi.mock('./engine', () => ({
  runAutomationsForTrigger: vi.fn(async (input: Record<string, unknown>) => {
    h.dispatches.push(input)
    if (h.dispatchError) throw h.dispatchError
  }),
}))

import { drainAutomationEvents } from './event-queue'

beforeEach(() => {
  h.claimed = []
  h.claimError = null
  h.rpcArgs = []
  h.updates = []
  h.dispatches = []
  h.dispatchError = null
})

describe('drainAutomationEvents', () => {
  it('dispatches each claimed event with its context and chain depth, then marks it processed', async () => {
    h.claimed = [
      {
        id: 7,
        account_id: 'acct-1',
        trigger_type: 'tag_added',
        contact_id: 'c1',
        conversation_id: null,
        context: { tag_id: 't1' },
        depth: 1,
        origin_automation_id: 'auto-a',
      },
      {
        id: 8,
        account_id: 'acct-1',
        trigger_type: 'conversation_assigned',
        contact_id: 'c1',
        conversation_id: 'conv-1',
        context: { agent_id: 'agent-9' },
        depth: 0,
        origin_automation_id: null,
      },
    ]

    const res = await drainAutomationEvents({ accountId: 'acct-1' })

    expect(h.rpcArgs[0]).toEqual({ p_account_id: 'acct-1', p_limit: 100 })
    expect(res).toEqual({ processed: 2, failed: 0 })
    expect(h.dispatches[0]).toMatchObject({
      accountId: 'acct-1',
      triggerType: 'tag_added',
      contactId: 'c1',
      context: { tag_id: 't1' },
      origin: { depth: 1, automationId: 'auto-a' },
    })
    expect(h.dispatches[1]).toMatchObject({
      triggerType: 'conversation_assigned',
      context: { conversation_id: 'conv-1', agent_id: 'agent-9' },
      origin: { depth: 0, automationId: null },
    })
    expect(h.updates.map((u) => u.id)).toEqual([7, 8])
    expect(h.updates[0].payload).toHaveProperty('processed_at')
  })

  it('leaves a failing event unprocessed with its error, for a later retry', async () => {
    h.claimed = [
      { id: 9, account_id: 'a', trigger_type: 'tag_added', contact_id: 'c', conversation_id: null, context: {}, depth: 0, origin_automation_id: null },
    ]
    h.dispatchError = new Error('boom')
    const res = await drainAutomationEvents()
    expect(res).toEqual({ processed: 0, failed: 1 })
    expect(h.updates[0]).toEqual({ payload: { last_error: 'boom' }, id: 9 })
  })

  it('reads a missing queue (migration not applied yet) as empty, quietly', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.claimError = { code: 'PGRST202', message: 'Could not find the function claim_automation_events' }
    expect(await drainAutomationEvents()).toEqual({ processed: 0, failed: 0 })
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
