import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  conversation: { category_id: null as string | null, priority: 'normal', team_id: null as string | null } as Record<string, unknown> | null,
  rpc: vi.fn<(name: string, args: Record<string, unknown>) => Promise<{ data: boolean; error: { message: string } | null }>>(async () => ({ data: true, error: null })),
  inserts: [] as { table: string; payload: Record<string, unknown> }[],
  routing: vi.fn(async () => ({ status: 'routed' })),
}))

vi.mock('./admin-client', () => {
  const builder = (table: string) => {
    const b: Record<string, unknown> = {}
    Object.assign(b, {
      select: () => b,
      eq: () => b,
      maybeSingle: async () => ({
        data:
          table === 'conversations'
            ? h.conversation
            : table === 'conversation_categories'
              ? { name: 'Cobrança' }
              : table === 'teams'
                ? { name: 'Financeiro' }
                : null,
        error: null,
      }),
      insert: (payload: Record<string, unknown>) => {
        h.inserts.push({ table, payload })
        return Promise.resolve({ error: null })
      },
    })
    return b
  }
  return { supabaseAdmin: () => ({ from: builder, rpc: h.rpc }) }
})
vi.mock('@/lib/support/routing', () => ({ applyRouting: h.routing }))
vi.mock('@/lib/assignment/round-robin', () => ({ pickRoundRobinAssignee: vi.fn() }))

import { runSupportStep, triggerMatches } from './engine'

const step = (step_type: string, step_config: Record<string, unknown>) => ({ id: 's1', step_type, step_config }) as never
const args = (over: Record<string, unknown> = {}) =>
  ({
    automation: { id: 'auto-1', account_id: 'acc' },
    contactId: 'k1',
    context: { conversation_id: 'c1' },
    depth: 1,
    ...over,
  }) as never

describe('support actions of the automation engine', () => {
  beforeEach(() => {
    h.conversation = { category_id: null, priority: 'normal', team_id: null }
    h.rpc.mockClear()
    h.routing.mockClear()
    h.inserts.length = 0
    h.rpc.mockResolvedValue({ data: true, error: null })
  })

  it('set_priority writes through the depth-carrying RPC and logs one event', async () => {
    await expect(runSupportStep(step('set_priority', { priority: 'urgent' }), args())).resolves.toBe('priority urgent set')
    expect(h.rpc).toHaveBeenCalledWith('automation_set_conversation', {
      p_account_id: 'acc',
      p_conversation_id: 'c1',
      p_category_id: null,
      p_priority: 'urgent',
      p_team_id: null,
      p_depth: 2,
      p_origin: 'auto-1',
    })
    expect(h.inserts).toHaveLength(1)
    expect(h.inserts[0].payload).toMatchObject({
      account_id: 'acc',
      conversation_id: 'c1',
      actor_user_id: null,
      event_type: 'priority_changed',
      payload: { priority: 'urgent', previous_priority: 'normal', source: 'automation' },
    })
  })

  it('an unchanged value logs nothing (idempotent)', async () => {
    h.conversation = { category_id: 'cat', priority: 'high', team_id: 'team' }
    await expect(runSupportStep(step('set_priority', { priority: 'high' }), args())).resolves.toBe('priority already set')
    await expect(runSupportStep(step('set_category', { category_id: 'cat' }), args())).resolves.toBe('category already set')
    await expect(runSupportStep(step('assign_team', { team_id: 'team' }), args())).resolves.toBe('team already set')
    expect(h.inserts).toHaveLength(0)
    expect(h.routing).not.toHaveBeenCalled()
  })

  it('set_category logs the change and runs the category routing rule', async () => {
    await runSupportStep(step('set_category', { category_id: 'cat' }), args())
    expect(h.inserts[0].payload).toMatchObject({ event_type: 'category_changed', payload: { category_id: 'cat', category_name: 'Cobrança', source: 'automation' } })
    // The routing it triggers is one level deeper than the run (loop protection).
    expect(h.routing).toHaveBeenCalledWith(expect.anything(), 'c1', { accountId: 'acc', depth: 2, origin: 'auto-1' })
  })

  it('assign_team logs team_changed with the team name', async () => {
    await runSupportStep(step('assign_team', { team_id: 'team' }), args())
    expect(h.rpc).toHaveBeenCalledWith('automation_set_conversation', expect.objectContaining({ p_team_id: 'team', p_priority: null, p_category_id: null }))
    expect(h.inserts[0].payload).toMatchObject({ event_type: 'team_changed', payload: { team_id: 'team', team_name: 'Financeiro', source: 'automation' } })
  })

  it('rejects incomplete configuration and unknown conversations', async () => {
    await expect(runSupportStep(step('set_category', {}), args())).rejects.toThrow('set_category needs a category')
    await expect(runSupportStep(step('set_priority', { priority: 'critical' }), args())).rejects.toThrow('valid priority')
    await expect(runSupportStep(step('assign_team', {}), args())).rejects.toThrow('assign_team needs a team')
    h.conversation = null
    await expect(runSupportStep(step('set_priority', { priority: 'low' }), args())).rejects.toThrow('conversation not found')
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('surfaces a database refusal (a category of another account) and logs nothing', async () => {
    h.rpc.mockResolvedValue({ data: false, error: { message: 'category does not belong to this account' } })
    await expect(runSupportStep(step('set_category', { category_id: 'foreign' }), args())).rejects.toThrow('does not belong')
    expect(h.inserts).toHaveLength(0)
    expect(h.routing).not.toHaveBeenCalled()
  })

  it('needs a conversation: from the trigger context or the contact', async () => {
    await expect(runSupportStep(step('set_priority', { priority: 'low' }), args({ context: {}, contactId: null }))).rejects.toThrow('no contact')
  })
})

describe('csat_received trigger filter (migration 074)', () => {
  const rule = (trigger_config: Record<string, unknown> | null) =>
    ({ id: 'a1', account_id: 'acc', trigger_type: 'csat_received', trigger_config }) as never
  const ctx = (score: unknown) => ({ conversation_id: 'c1', vars: { score } }) as never

  it('without max_score every rating matches', () => {
    for (const cfg of [null, {}, { max_score: '' }]) expect(triggerMatches(rule(cfg), ctx(5))).toBe(true)
  })

  it('max_score is a ceiling: 2 matches 1 and 2, not 3', () => {
    expect(triggerMatches(rule({ max_score: 2 }), ctx(1))).toBe(true)
    expect(triggerMatches(rule({ max_score: 2 }), ctx(2))).toBe(true)
    expect(triggerMatches(rule({ max_score: 2 }), ctx(3))).toBe(false)
    expect(triggerMatches(rule({ max_score: '2' }), ctx(2))).toBe(true)
  })

  it('a filter with no usable score does not match', () => {
    expect(triggerMatches(rule({ max_score: 2 }), ctx(undefined))).toBe(false)
    expect(triggerMatches(rule({ max_score: 2 }), { conversation_id: 'c1' } as never)).toBe(false)
  })
})
