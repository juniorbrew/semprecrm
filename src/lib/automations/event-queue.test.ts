import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  claimed: [] as Record<string, unknown>[],
  claimError: null as { code?: string; message: string } | null,
  rpcArgs: [] as Record<string, unknown>[],
  updates: [] as { payload: Record<string, unknown>; id: unknown }[],
  /** Fails the next N queue updates. */
  failUpdates: 0,
  dispatches: [] as Record<string, unknown>[],
  dispatchOk: true,
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
          if (h.failUpdates > 0) {
            h.failUpdates -= 1
            return Promise.resolve({ error: { message: 'db down' } })
          }
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
    return { ok: h.dispatchOk }
  }),
}))

import { drainAutomationEvents } from './event-queue'

const event = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  account_id: 'acct-1',
  trigger_type: 'tag_added',
  contact_id: 'c1',
  conversation_id: null,
  context: { tag_id: 't1' },
  depth: 0,
  origin_automation_id: null,
  ...over,
})

beforeEach(() => {
  h.claimed = []
  h.claimError = null
  h.rpcArgs = []
  h.updates = []
  h.failUpdates = 0
  h.dispatches = []
  h.dispatchOk = true
  h.dispatchError = null
})

describe('drainAutomationEvents', () => {
  it('acknowledges each event before dispatching it with its context and chain depth', async () => {
    h.claimed = [
      event(7, { depth: 1, origin_automation_id: 'auto-a' }),
      event(8, {
        trigger_type: 'conversation_assigned',
        conversation_id: 'conv-1',
        context: { agent_id: 'agent-9' },
      }),
    ]

    const res = await drainAutomationEvents({ accountId: 'acct-1' })

    expect(h.rpcArgs[0]).toEqual({ p_account_id: 'acct-1', p_limit: 100 })
    expect(res).toEqual({ processed: 2, failed: 0 })
    expect(h.dispatches[0]).toMatchObject({
      triggerType: 'tag_added',
      context: { tag_id: 't1' },
      origin: { depth: 1, automationId: 'auto-a' },
    })
    expect(h.dispatches[1]).toMatchObject({
      triggerType: 'conversation_assigned',
      context: { conversation_id: 'conv-1', agent_id: 'agent-9' },
    })
    // One acknowledgement per event, nothing else.
    expect(h.updates.map((u) => u.id)).toEqual([7, 8])
    expect(h.updates[0].payload).toHaveProperty('processed_at')
  })

  it('never runs automations for an event it could not acknowledge', async () => {
    h.claimed = [event(9)]
    h.failUpdates = 1
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await drainAutomationEvents()
    spy.mockRestore()
    expect(res).toEqual({ processed: 0, failed: 1 })
    expect(h.dispatches).toHaveLength(0)
  })

  it('un-acknowledges for a retry when the dispatch could not load the automations', async () => {
    h.claimed = [event(10)]
    h.dispatchOk = false
    const res = await drainAutomationEvents()
    expect(res).toEqual({ processed: 0, failed: 1 })
    expect(h.updates[1]).toEqual({
      payload: { processed_at: null, last_error: 'dispatch could not load the automations' },
      id: 10,
    })
  })

  it('un-acknowledges when the dispatch throws', async () => {
    h.claimed = [event(11)]
    h.dispatchError = new Error('boom')
    const res = await drainAutomationEvents()
    expect(res).toEqual({ processed: 0, failed: 1 })
    expect(h.updates[1].payload).toEqual({ processed_at: null, last_error: 'boom' })
  })

  it('reads a missing queue (migration not applied yet) as empty, quietly', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.claimError = { code: 'PGRST202', message: 'Could not find the function claim_automation_events' }
    expect(await drainAutomationEvents()).toEqual({ processed: 0, failed: 0 })
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
