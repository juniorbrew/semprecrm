import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  pick: vi.fn<(db: unknown, accountId: string, opts?: { memberIds?: readonly string[] }) => Promise<string | null>>(),
  notify: vi.fn(async () => ({})),
}))

vi.mock('@/lib/assignment/round-robin', () => ({ pickRoundRobinAssignee: h.pick }))
vi.mock('@/lib/push/notify', () => ({ notifyConversationAssigned: h.notify }))

import { applyRouting, decideRouting, transferToTeam, type RoutingConversation } from './routing'

const base: RoutingConversation = {
  status: 'open',
  archived_at: null,
  category_id: 'cat',
  priority: 'normal',
  team_id: null,
  team_source: null,
  assigned_agent_id: null,
  assignment_source: null,
}
const rule = { team_id: 'team', priority_min: null }
const team = { archived_at: null }

describe('decideRouting', () => {
  it('routes an unassigned conversation to the rule team and picks a member', () => {
    expect(decideRouting(base, rule, team, ['a', 'b'])).toEqual({ action: 'route', teamId: 'team', changeTeam: true, pickAssignee: true })
  })

  it('skips closed and archived conversations', () => {
    expect(decideRouting({ ...base, status: 'closed' }, rule, team, ['a'])).toEqual({ action: 'skip', reason: 'closed' })
    expect(decideRouting({ ...base, archived_at: 'x' }, rule, team, ['a'])).toEqual({ action: 'skip', reason: 'closed' })
  })

  it('skips without category, rule or with an archived team', () => {
    expect(decideRouting({ ...base, category_id: null }, rule, team, [])).toEqual({ action: 'skip', reason: 'no_category' })
    expect(decideRouting(base, null, null, [])).toEqual({ action: 'skip', reason: 'no_rule' })
    expect(decideRouting(base, rule, { archived_at: 'x' }, [])).toEqual({ action: 'skip', reason: 'team_archived' })
  })

  it('honours the minimum priority', () => {
    const min = { team_id: 'team', priority_min: 'high' as const }
    expect(decideRouting(base, min, team, [])).toEqual({ action: 'skip', reason: 'below_priority' })
    expect(decideRouting({ ...base, priority: 'high' }, min, team, []).action).toBe('route')
    expect(decideRouting({ ...base, priority: 'urgent' }, min, team, []).action).toBe('route')
  })

  it('never reassigns a conversation a person claimed, was handed, or that predates provenance', () => {
    for (const source of ['manual', null] as const) {
      const d = decideRouting({ ...base, assigned_agent_id: 'human', assignment_source: source }, rule, team, ['a'])
      expect(d).toMatchObject({ action: 'route', changeTeam: true, pickAssignee: false })
    }
  })

  it('keeps an automatic assignee who already belongs to the team, replaces one who does not', () => {
    const auto = { ...base, assigned_agent_id: 'a', assignment_source: 'auto' as const, team_id: 'team' }
    expect(decideRouting(auto, rule, team, ['a', 'b'])).toMatchObject({ changeTeam: false, pickAssignee: false })
    expect(decideRouting(auto, rule, team, ['b'])).toMatchObject({ changeTeam: false, pickAssignee: true })
  })

  it('leaves a team chosen by hand alone', () => {
    const d = decideRouting({ ...base, team_id: 'other', team_source: 'manual' }, rule, team, ['a'])
    expect(d).toEqual({ action: 'skip', reason: 'manual_team' })
    // The same team chosen by hand is fine: nothing to change.
    expect(decideRouting({ ...base, team_id: 'team', team_source: 'manual' }, rule, team, ['a'])).toMatchObject({ changeTeam: false })
  })
})

// ---- applyRouting against an in-memory table store -------------------------

type Row = Record<string, unknown>
interface Store {
  messages: Row[]
  rpcCalls: Row[]
  conversations: Row[]
  routing_rules: Row[]
  teams: Row[]
  team_members: Row[]
  conversation_events: Row[]
}

/** Mirror of support_set_conversation_team() + conversations_stamp_sources() (migration 073). */
function fakeRpc(store: Store, args: Row) {
  store.rpcCalls.push(args)
  const c = store.conversations.find((r) => r.id === args.p_conversation && r.account_id === args.p_account)
  if (!c || c.status === 'closed' || c.archived_at) return { data: false, error: null }
  if (args.p_check_assignee && (c.assigned_agent_id ?? null) !== (args.p_expect_assignee ?? null)) return { data: false, error: null }
  if (args.p_require_auto && args.p_change_team && c.team_source === 'manual') return { data: false, error: null }
  if (args.p_require_auto && args.p_change_assignee && c.assigned_agent_id && c.assignment_source !== 'auto') return { data: false, error: null }
  const who = args.p_actor_user ? 'manual' : 'auto'
  if (args.p_change_team && c.team_id !== args.p_team) {
    c.team_id = args.p_team
    c.team_source = args.p_team ? who : null
  }
  if (args.p_change_assignee && (c.assigned_agent_id ?? null) !== (args.p_assignee ?? null)) {
    c.assigned_agent_id = args.p_assignee
    c.assignment_source = args.p_assignee ? who : null
  }
  return { data: true, error: null }
}

function fakeDb(store: Store) {
  function query(table: keyof Store) {
    const filters: ((r: Row) => boolean)[] = []
    let mode: 'select' | 'update' | 'insert' = 'select'
    let payload: Row | Row[] = {}
    const b: Record<string, unknown> = {}
    const run = () => {
      const rows = store[table]
      if (mode === 'insert') {
        for (const r of payload as Row[]) rows.push(r)
        return { data: null, error: null }
      }
      const hit = rows.filter((r) => filters.every((f) => f(r)))
      if (mode === 'update') {
        for (const r of hit) Object.assign(r, payload)
      }
      // Copies, like a real round trip: later writes must not change what was read.
      return { data: hit.map((r) => ({ ...r })), error: null }
    }
    Object.assign(b, {
      select: () => b,
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), b),
      neq: (k: string, v: unknown) => (filters.push((r) => r[k] !== v), b),
      is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), b),
      or: (expr: string) => {
        const parts = expr.split(',').map((p) => p.split('.'))
        filters.push((r) => parts.some(([k, op, v]) => (op === 'is' ? (r[k] ?? null) === null : r[k] === v)))
        return b
      },
      update: (p: Row) => ((mode = 'update'), (payload = p), b),
      insert: (p: Row[]) => ((mode = 'insert'), (payload = p), b),
      limit: () => b,
      maybeSingle: () => Promise.resolve({ data: run().data?.[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
    })
    return b
  }
  return {
    from: (t: string) => query(t as keyof Store),
    rpc: async (name: string, args: Row) => (name === 'support_set_conversation_team' ? fakeRpc(store, args) : { data: null, error: { message: name } }),
  } as never
}

function seed(over: Partial<Row> = {}): Store {
  return {
    conversations: [
      { id: 'c1', account_id: 'acc', status: 'open', archived_at: null, category_id: 'cat', priority: 'normal', team_id: null, team_source: null, assigned_agent_id: null, assignment_source: null, ...over },
    ],
    routing_rules: [{ account_id: 'acc', category_id: 'cat', team_id: 'team', priority_min: null }],
    teams: [{ id: 'team', account_id: 'acc', name: 'Financeiro', archived_at: null }],
    team_members: [
      { team_id: 'team', account_id: 'acc', user_id: 'u1' },
      { team_id: 'team', account_id: 'acc', user_id: 'u2' },
    ],
    conversation_events: [],
    messages: [],
    rpcCalls: [],
  }
}

describe('applyRouting', () => {
  beforeEach(() => {
    h.pick.mockReset()
    h.notify.mockClear()
  })

  it('sets the team, assigns an available member and logs both events', async () => {
    h.pick.mockResolvedValue('u2')
    const store = seed()
    const out = await applyRouting(fakeDb(store), 'c1')
    expect(out).toEqual({ status: 'routed', teamId: 'team', assigneeId: 'u2', teamChanged: true })
    expect(h.pick).toHaveBeenCalledWith(expect.anything(), 'acc', { memberIds: ['u1', 'u2'] })
    expect(store.conversations[0]).toMatchObject({ team_id: 'team', assigned_agent_id: 'u2', assignment_source: 'auto', team_source: 'auto' })
    expect(store.conversation_events.map((e) => e.event_type)).toEqual(['team_changed', 'assigned'])
    expect(store.conversation_events[0].payload).toMatchObject({ team_id: 'team', team_name: 'Financeiro', source: 'routing' })
    expect(store.conversation_events[1].payload).toMatchObject({ assignee_user_id: 'u2', source: 'routing' })
    expect(h.notify).toHaveBeenCalledTimes(1)
  })

  it('is idempotent: a repeated category set changes nothing and logs nothing', async () => {
    h.pick.mockResolvedValue('u1')
    const store = seed()
    await applyRouting(fakeDb(store), 'c1')
    const events = store.conversation_events.length
    h.pick.mockClear()
    const again = await applyRouting(fakeDb(store), 'c1')
    expect(again.status).toBe('skipped')
    expect(h.pick).not.toHaveBeenCalled()
    expect(store.conversation_events).toHaveLength(events)
    expect(store.conversations[0].assigned_agent_id).toBe('u1')
  })

  it('keeps the conversation unassigned but in the team when nobody is available', async () => {
    h.pick.mockResolvedValue(null)
    const store = seed()
    const out = await applyRouting(fakeDb(store), 'c1')
    expect(out).toMatchObject({ status: 'routed', assigneeId: null, teamChanged: true })
    expect(store.conversations[0]).toMatchObject({ team_id: 'team', assigned_agent_id: null })
    expect(store.conversation_events.map((e) => e.event_type)).toEqual(['team_changed'])
    expect(h.notify).not.toHaveBeenCalled()
    // Asking again with nobody available is a no-op, not an event.
    const again = await applyRouting(fakeDb(store), 'c1')
    expect(again).toEqual({ status: 'skipped', reason: 'nothing_to_do' })
    expect(store.conversation_events).toHaveLength(1)
  })

  it('never takes a conversation a person claimed: the team is set, the owner stays', async () => {
    const store = seed({ assigned_agent_id: 'human', assignment_source: 'manual' })
    const out = await applyRouting(fakeDb(store), 'c1')
    expect(out).toMatchObject({ status: 'routed', assigneeId: null, teamChanged: true })
    expect(h.pick).not.toHaveBeenCalled()
    expect(store.conversations[0]).toMatchObject({ assigned_agent_id: 'human', assignment_source: 'manual', team_id: 'team' })
  })

  it('never reroutes a closed conversation', async () => {
    const store = seed({ status: 'closed' })
    expect(await applyRouting(fakeDb(store), 'c1')).toEqual({ status: 'skipped', reason: 'closed' })
    expect(store.conversations[0].team_id).toBeNull()
    expect(store.conversation_events).toHaveLength(0)
  })

  it('replaces an automatic assignee outside the team', async () => {
    h.pick.mockResolvedValue('u1')
    const store = seed({ assigned_agent_id: 'outsider', assignment_source: 'auto' })
    const out = await applyRouting(fakeDb(store), 'c1')
    expect(out).toMatchObject({ status: 'routed', assigneeId: 'u1' })
    expect(store.conversations[0].assigned_agent_id).toBe('u1')
  })

  it('loses the race gracefully when a person claims it between the read and the write', async () => {
    const store = seed()
    h.pick.mockImplementation(async () => {
      // A teammate clicks "Assumir" while the pick is running.
      Object.assign(store.conversations[0], { assigned_agent_id: 'human', assignment_source: 'manual' })
      return 'u1'
    })
    const out = await applyRouting(fakeDb(store), 'c1')
    expect(out).toEqual({ status: 'skipped', reason: 'changed_meanwhile' })
    expect(store.conversations[0]).toMatchObject({ assigned_agent_id: 'human', team_id: null })
    expect(store.conversation_events).toHaveLength(0)
  })

  it('does nothing for a category without a rule, and stays inside the conversation account', async () => {
    const store = seed()
    store.routing_rules = []
    expect(await applyRouting(fakeDb(store), 'c1')).toEqual({ status: 'skipped', reason: 'no_rule' })
    expect(await applyRouting(fakeDb(seed()), 'c1', { accountId: 'other' })).toEqual({ status: 'skipped', reason: 'not_found' })
  })
})

describe('applyRouting (review round)', () => {
  beforeEach(() => {
    h.pick.mockReset()
    h.notify.mockClear()
  })

  it('carries the automation depth and origin into the single write path', async () => {
    h.pick.mockResolvedValue('u1')
    const store = seed()
    await applyRouting(fakeDb(store), 'c1', { depth: 2, origin: 'auto-9' })
    expect(store.rpcCalls).toHaveLength(1)
    expect(store.rpcCalls[0]).toMatchObject({ p_depth: 2, p_origin: 'auto-9', p_require_auto: true, p_actor_user: null, p_check_assignee: true, p_expect_assignee: null })
    await applyRouting(fakeDb(seed()), 'c1')
    // Outside automations: depth 0, no origin.
  })

  it('an automatic assignee who already wrote in the conversation is treated as a person at work', async () => {
    const store = seed({ assigned_agent_id: 'outsider', assignment_source: 'auto' })
    store.messages.push({ conversation_id: 'c1', sender_id: 'outsider', sender_type: 'agent' })
    const out = await applyRouting(fakeDb(store), 'c1')
    expect(out).toMatchObject({ status: 'routed', assigneeId: null, teamChanged: true })
    expect(h.pick).not.toHaveBeenCalled()
    expect(store.conversations[0]).toMatchObject({ assigned_agent_id: 'outsider', team_id: 'team' })
    // Without a message from them the same outsider would have been replaced.
    h.pick.mockResolvedValue('u1')
    const quiet = seed({ assigned_agent_id: 'outsider', assignment_source: 'auto' })
    quiet.messages.push({ conversation_id: 'c1', sender_id: 'someone-else' })
    expect(await applyRouting(fakeDb(quiet), 'c1')).toMatchObject({ assigneeId: 'u1' })
  })

  it('reviewer scenario: claimed by a person, transferred to team A then B, a category set never reroutes', async () => {
    const store = seed({ assigned_agent_id: 'human', assignment_source: 'manual' })
    store.teams.push({ id: 'teamB', account_id: 'acc', name: 'Comercial', archived_at: null })
    store.team_members.push({ team_id: 'teamB', account_id: 'acc', user_id: 'u3' })
    h.pick.mockResolvedValue(null)
    const db = fakeDb(store)
    const args = { accountId: 'acc', conversationId: 'c1', actorUserId: 'human' }
    expect(await transferToTeam(db, { ...args, teamId: 'team' })).toMatchObject({ status: 'ok', teamId: 'team', assigneeId: 'human' })
    expect(store.conversations[0]).toMatchObject({ team_id: 'team', team_source: 'manual', assigned_agent_id: 'human', assignment_source: 'manual' })
    expect(await transferToTeam(db, { ...args, teamId: 'teamB' })).toMatchObject({ status: 'ok', teamId: 'teamB', assigneeId: 'human' })
    expect(store.conversations[0]).toMatchObject({ team_id: 'teamB', team_source: 'manual', assigned_agent_id: 'human', assignment_source: 'manual' })
    // The category rule points at team A: a human chose B, so routing stands aside entirely.
    expect(await applyRouting(db, 'c1')).toEqual({ status: 'skipped', reason: 'manual_team' })
    expect(store.conversations[0]).toMatchObject({ team_id: 'teamB', assigned_agent_id: 'human' })
  })

  it('ping-pong (category_set -> set the other category, alternating rules) stops at the depth cap', async () => {
    // Model of the automation loop: every team_changed event runs "set the other
    // category" one level deeper, which re-runs routing. The database drops an
    // event raised at depth > 3 (automation_enqueue_event), so the chain ends.
    const store = seed({ category_id: 'catA' })
    store.teams.push({ id: 'teamB', account_id: 'acc', name: 'B', archived_at: null })
    store.routing_rules = [
      { account_id: 'acc', category_id: 'catA', team_id: 'team', priority_min: null },
      { account_id: 'acc', category_id: 'catB', team_id: 'teamB', priority_min: null },
    ]
    h.pick.mockResolvedValue(null)
    const queue: number[] = []
    const base = fakeDb(store) as unknown as { from: unknown; rpc: (n: string, a: Row) => Promise<{ data: unknown }> }
    const db = {
      from: base.from,
      rpc: async (n: string, a: Row) => {
        const before = store.conversations[0].team_id
        const out = await base.rpc(n, a)
        if (store.conversations[0].team_id !== before && (a.p_depth as number) <= 3) queue.push(a.p_depth as number)
        return out
      },
    } as never
    let runs = 0
    await applyRouting(db, 'c1')
    runs += 1
    while (queue.length && runs < 50) {
      const depth = queue.shift()!
      const conv = store.conversations[0]
      conv.category_id = conv.category_id === 'catA' ? 'catB' : 'catA'
      await applyRouting(db, 'c1', { depth: depth + 1, origin: 'auto-1' })
      runs += 1
    }
    expect(runs).toBeLessThan(50)
    // Events at depth 0..3 ran their action; the routing it caused at depth 4 changed the team but raised nothing.
    expect(runs).toBe(5)
    expect(store.rpcCalls.map((c) => c.p_depth)).toEqual([0, 1, 2, 3, 4])
  })
})

describe('transferToTeam', () => {
  beforeEach(() => h.pick.mockReset())

  it('hands the conversation to an available member as a manual decision', async () => {
    h.pick.mockResolvedValue('u2')
    const store = seed({ assigned_agent_id: 'old', assignment_source: 'manual' })
    const out = await transferToTeam(fakeDb(store), { accountId: 'acc', conversationId: 'c1', teamId: 'team', actorUserId: 'me' })
    expect(out).toEqual({ status: 'ok', teamId: 'team', assigneeId: 'u2' })
    expect(store.conversations[0]).toMatchObject({ team_id: 'team', team_source: 'manual', assigned_agent_id: 'u2', assignment_source: 'manual' })
    expect(store.conversation_events.map((e) => [e.event_type, e.actor_user_id])).toEqual([['team_changed', 'me'], ['assigned', 'me']])
  })

  it('keeps the current owner when they already belong to the team', async () => {
    const store = seed({ assigned_agent_id: 'u1', assignment_source: 'manual' })
    const out = await transferToTeam(fakeDb(store), { accountId: 'acc', conversationId: 'c1', teamId: 'team', actorUserId: 'me' })
    expect(out).toEqual({ status: 'ok', teamId: 'team', assigneeId: 'u1' })
    expect(h.pick).not.toHaveBeenCalled()
    expect(store.conversations[0]).toMatchObject({ team_id: 'team', team_source: 'manual', assigned_agent_id: 'u1', assignment_source: 'manual' })
    expect(store.rpcCalls[0]).toMatchObject({ p_change_assignee: false, p_actor_user: 'me' })
    expect(store.conversation_events.map((e) => e.event_type)).toEqual(['team_changed'])
  })

  it('does not drop the current owner when the whole team is away: only the team changes', async () => {
    h.pick.mockResolvedValue(null)
    const store = seed({ assigned_agent_id: 'old', assignment_source: 'manual' })
    const out = await transferToTeam(fakeDb(store), { accountId: 'acc', conversationId: 'c1', teamId: 'team', actorUserId: 'me' })
    expect(out).toEqual({ status: 'ok', teamId: 'team', assigneeId: 'old' })
    expect(store.conversations[0]).toMatchObject({ team_id: 'team', team_source: 'manual', assigned_agent_id: 'old', assignment_source: 'manual' })
    expect(store.conversation_events.map((e) => e.event_type)).toEqual(['team_changed'])
  })

  it('an unassigned conversation with nobody available waits in the team queue', async () => {
    h.pick.mockResolvedValue(null)
    const store = seed()
    expect(await transferToTeam(fakeDb(store), { accountId: 'acc', conversationId: 'c1', teamId: 'team', actorUserId: 'me' })).toEqual({ status: 'ok', teamId: 'team', assigneeId: null })
    expect(store.conversations[0]).toMatchObject({ team_id: 'team', assigned_agent_id: null })
  })

  it('is a compare-and-set on the owner the person saw', async () => {
    const store = seed({ assigned_agent_id: 'old', assignment_source: 'manual' })
    h.pick.mockImplementation(async () => {
      // A teammate took it while the pick was running.
      Object.assign(store.conversations[0], { assigned_agent_id: 'someone', assignment_source: 'manual' })
      return 'u2'
    })
    const out = await transferToTeam(fakeDb(store), { accountId: 'acc', conversationId: 'c1', teamId: 'team', actorUserId: 'me' })
    expect(out).toEqual({ status: 'failed', reason: 'changed_meanwhile' })
    expect(store.conversations[0]).toMatchObject({ assigned_agent_id: 'someone', team_id: null })
    expect(store.conversation_events).toHaveLength(0)
  })

  it('writing again to the same team with the same owner is a no-op', async () => {
    const store = seed({ assigned_agent_id: 'u1', assignment_source: 'manual', team_id: 'team', team_source: 'manual' })
    expect(await transferToTeam(fakeDb(store), { accountId: 'acc', conversationId: 'c1', teamId: 'team', actorUserId: 'me' })).toEqual({ status: 'ok', teamId: 'team', assigneeId: 'u1' })
    expect(store.rpcCalls).toHaveLength(0)
    expect(store.conversation_events).toHaveLength(0)
  })

  it('refuses archived / foreign teams and closed conversations', async () => {
    const closed = seed({ status: 'closed' })
    expect(await transferToTeam(fakeDb(closed), { accountId: 'acc', conversationId: 'c1', teamId: 'team', actorUserId: 'me' })).toEqual({ status: 'failed', reason: 'closed' })
    const archived = seed()
    archived.teams[0].archived_at = 'x'
    expect(await transferToTeam(fakeDb(archived), { accountId: 'acc', conversationId: 'c1', teamId: 'team', actorUserId: 'me' })).toEqual({ status: 'failed', reason: 'team_not_found' })
    expect(await transferToTeam(fakeDb(seed()), { accountId: 'acc', conversationId: 'c1', teamId: 'nope', actorUserId: 'me' })).toEqual({ status: 'failed', reason: 'team_not_found' })
    expect(await transferToTeam(fakeDb(seed()), { accountId: 'other', conversationId: 'c1', teamId: 'team', actorUserId: 'me' })).toEqual({ status: 'failed', reason: 'not_found' })
  })
})
