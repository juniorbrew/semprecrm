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
  conversations: Row[]
  routing_rules: Row[]
  teams: Row[]
  team_members: Row[]
  conversation_events: Row[]
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
        // The provenance trigger: server writes are 'auto' unless given.
        if (table === 'conversations') {
          for (const r of hit) {
            if ('assigned_agent_id' in (payload as Row) && !('assignment_source' in (payload as Row))) r.assignment_source = 'auto'
            if ('team_id' in (payload as Row) && !('team_source' in (payload as Row))) r.team_source = 'auto'
          }
        }
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
      maybeSingle: () => Promise.resolve({ data: run().data?.[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
    })
    return b
  }
  return { from: (t: string) => query(t as keyof Store) } as never
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

  it('unassigns and leaves it in the team queue when the whole team is away', async () => {
    h.pick.mockResolvedValue(null)
    const store = seed({ assigned_agent_id: 'old', assignment_source: 'manual' })
    const out = await transferToTeam(fakeDb(store), { accountId: 'acc', conversationId: 'c1', teamId: 'team', actorUserId: 'me' })
    expect(out).toEqual({ status: 'ok', teamId: 'team', assigneeId: null })
    expect(store.conversations[0]).toMatchObject({ team_id: 'team', assigned_agent_id: null, assignment_source: null })
    expect(store.conversation_events.map((e) => e.event_type)).toEqual(['team_changed', 'unassigned'])
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
