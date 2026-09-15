import { beforeEach, describe, expect, it } from 'vitest'

import {
  pickRoundRobinAssignee,
  selectRoundRobin,
  type RoundRobinCandidate,
} from './round-robin'

const c = (
  user_id: string,
  over: Partial<RoundRobinCandidate> = {},
): RoundRobinCandidate => ({
  user_id,
  account_role: 'agent',
  availability: 'available',
  last_assigned_at: null,
  ...over,
})

const load = (entries: [string, number][]) => ({ openByUser: new Map(entries) })

describe('selectRoundRobin', () => {
  it('returns null when nobody is available', () => {
    expect(selectRoundRobin([], load([]))).toBeNull()
    expect(selectRoundRobin([c('a', { availability: 'away' })], load([]))).toBeNull()
  })

  it('ignores viewers and away members', () => {
    const picked = selectRoundRobin(
      [c('viewer', { account_role: 'viewer' }), c('away', { availability: 'away' }), c('agent')],
      load([]),
    )
    expect(picked).toBe('agent')
  })

  it('picks the member with the fewest open assigned conversations', () => {
    const picked = selectRoundRobin(
      [c('busy'), c('idle'), c('mid')],
      load([
        ['busy', 5],
        ['mid', 2],
      ]),
    )
    expect(picked).toBe('idle')
  })

  it('breaks ties by the oldest last_assigned_at, never-assigned first', () => {
    expect(
      selectRoundRobin(
        [
          c('recent', { last_assigned_at: '2026-09-13T12:00:00Z' }),
          c('older', { last_assigned_at: '2026-09-13T08:00:00Z' }),
        ],
        load([]),
      ),
    ).toBe('older')

    expect(
      selectRoundRobin(
        [
          c('recent', { last_assigned_at: '2026-09-13T12:00:00Z' }),
          c('never', { last_assigned_at: null }),
        ],
        load([]),
      ),
    ).toBe('never')
  })

  it('load beats recency: a recently assigned but idle member wins over a busy one', () => {
    const picked = selectRoundRobin(
      [
        c('busy', { last_assigned_at: '2026-09-01T00:00:00Z' }),
        c('idle', { last_assigned_at: '2026-09-13T12:00:00Z' }),
      ],
      load([['busy', 3]]),
    )
    expect(picked).toBe('idle')
  })

  it('owners and admins are eligible', () => {
    expect(selectRoundRobin([c('o', { account_role: 'owner' })], load([]))).toBe('o')
    expect(selectRoundRobin([c('a', { account_role: 'admin' })], load([]))).toBe('a')
  })
})

// ------------------------------------------------------------
// pickRoundRobinAssignee with a mocked Supabase client (same style as
// engine.test.ts): a chainable builder whose terminal `then` resolves
// against the table + operation.
// ------------------------------------------------------------

interface Call {
  table: string
  type: string
  payload?: unknown
  filters: [string, string, unknown][]
}

const state = {
  profiles: [] as RoundRobinCandidate[],
  open: [] as { assigned_agent_id: string | null }[],
  calls: [] as Call[],
  failProfiles: false,
}

function mockDb() {
  function resolve(ops: Call) {
    state.calls.push(ops)
    if (ops.table === 'profiles') {
      if (ops.type === 'update') return { data: null, error: null }
      if (state.failProfiles) return { data: null, error: { message: 'boom' } }
      return { data: state.profiles, error: null }
    }
    if (ops.table === 'conversations') return { data: state.open, error: null }
    return { data: null, error: null }
  }
  function builder(table: string) {
    const ops: Call = { table, type: 'select', filters: [] }
    const b: Record<string, unknown> = {
      select: () => b,
      update: (p: unknown) => ((ops.type = 'update'), (ops.payload = p), b),
      eq: (k: string, v: unknown) => (ops.filters.push(['eq', k, v]), b),
      not: (k: string, op: string, v: unknown) => (ops.filters.push([`not.${op}`, k, v]), b),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(resolve(ops)).then(onF, onR),
    }
    return b
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from: (t: string) => builder(t) } as any
}

beforeEach(() => {
  state.profiles = []
  state.open = []
  state.calls = []
  state.failProfiles = false
})

describe('pickRoundRobinAssignee', () => {
  it('scopes the reads to the account and stamps last_assigned_at on the winner', async () => {
    state.profiles = [c('u1'), c('u2', { last_assigned_at: '2026-09-13T10:00:00Z' })]
    state.open = [{ assigned_agent_id: 'u1' }, { assigned_agent_id: 'u1' }]
    const now = new Date('2026-09-13T12:00:00Z')

    const picked = await pickRoundRobinAssignee(mockDb(), 'acct-1', { now })

    expect(picked).toBe('u2')
    const profilesRead = state.calls.find((k) => k.table === 'profiles' && k.type === 'select')
    expect(profilesRead?.filters).toEqual(
      expect.arrayContaining([
        ['eq', 'account_id', 'acct-1'],
        ['eq', 'availability', 'available'],
      ]),
    )
    const convRead = state.calls.find((k) => k.table === 'conversations')
    expect(convRead?.filters).toEqual(
      expect.arrayContaining([
        ['eq', 'account_id', 'acct-1'],
        ['eq', 'status', 'open'],
      ]),
    )
    const stampCall = state.calls.find((k) => k.table === 'profiles' && k.type === 'update')
    expect(stampCall?.payload).toEqual({ last_assigned_at: now.toISOString() })
    expect(stampCall?.filters).toEqual(
      expect.arrayContaining([
        ['eq', 'account_id', 'acct-1'],
        ['eq', 'user_id', 'u2'],
      ]),
    )
  })

  it('returns null and writes nothing when no member is available', async () => {
    state.profiles = []
    const picked = await pickRoundRobinAssignee(mockDb(), 'acct-1')
    expect(picked).toBeNull()
    expect(state.calls.some((k) => k.type === 'update')).toBe(false)
  })

  it('returns null on a read error instead of throwing', async () => {
    state.failProfiles = true
    state.profiles = [c('u1')]
    await expect(pickRoundRobinAssignee(mockDb(), 'acct-1')).resolves.toBeNull()
  })

  it('rotates: consecutive picks alternate between two idle agents', async () => {
    state.profiles = [c('a'), c('b')]
    const first = await pickRoundRobinAssignee(mockDb(), 'acct-1', {
      now: new Date('2026-09-13T12:00:00Z'),
    })
    expect(first).toBe('a')
    // Simulate what the DB now holds: `a` was stamped and got the conversation.
    state.profiles = [c('a', { last_assigned_at: '2026-09-13T12:00:00Z' }), c('b')]
    state.open = [{ assigned_agent_id: 'a' }]
    const second = await pickRoundRobinAssignee(mockDb(), 'acct-1', {
      now: new Date('2026-09-13T12:01:00Z'),
    })
    expect(second).toBe('b')
  })
})
