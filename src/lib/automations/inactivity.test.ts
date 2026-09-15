import { beforeEach, describe, expect, it, vi } from 'vitest'

// ------------------------------------------------------------
// scanInactiveConversations — the cron-driven follow-up scan. The
// Supabase client is a hand-rolled in-memory mock (same pattern as
// inbound.test.ts); the engine dispatch is stubbed and recorded.
// ------------------------------------------------------------

const h = vi.hoisted(() => ({
  state: {
    automations: [] as Record<string, unknown>[],
    conversations: [] as Record<string, unknown>[],
    fires: [] as { automation_id: string; conversation_id: string; fired_for: string }[],
    conversationsError: null as { message: string } | null,
  },
  dispatches: [] as Record<string, unknown>[],
}))

vi.mock('./engine', () => ({
  runAutomationsForTrigger: vi.fn(async (args: Record<string, unknown>) => {
    h.dispatches.push(args)
  }),
}))

import {
  lastSender,
  matchesLastFrom,
  parseInactiveConfig,
  scanInactiveConversations,
} from './inactivity'

const NOW = new Date('2026-09-13T12:00:00Z')
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString()

function makeDb() {
  function builder(table: string) {
    const filters: ((row: Record<string, unknown>) => boolean)[] = []
    let range: [number, number] | null = null
    let orderKey: string | null = null
    const ops = { type: 'select' as 'select' | 'upsert', payload: undefined as unknown }

    const source = (): Record<string, unknown>[] => {
      if (table === 'automations') return h.state.automations
      if (table === 'conversations') return h.state.conversations
      if (table === 'automation_inactivity_fires') return h.state.fires
      return []
    }
    const resolve = () => {
      if (table === 'conversations' && h.state.conversationsError) {
        return { data: null, error: h.state.conversationsError }
      }
      if (ops.type === 'upsert') {
        const p = ops.payload as { automation_id: string; conversation_id: string; fired_for: string }
        const idx = h.state.fires.findIndex(
          (f) => f.automation_id === p.automation_id && f.conversation_id === p.conversation_id,
        )
        if (idx >= 0) h.state.fires[idx] = p
        else h.state.fires.push(p)
        return { data: null, error: null }
      }
      let rows = source().filter((r) => filters.every((f) => f(r)))
      if (orderKey) {
        const k = orderKey
        rows = [...rows].sort((a, b) => String(a[k]).localeCompare(String(b[k])))
      }
      if (range) rows = rows.slice(range[0], range[1] + 1)
      return { data: rows, error: null }
    }
    const b: Record<string, unknown> = {
      select: () => b,
      upsert: (p: unknown) => ((ops.type = 'upsert'), (ops.payload = p), b),
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), b),
      in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), b),
      not: (k: string, op: string, v: unknown) => {
        if (op === 'is' && v === null) filters.push((r) => r[k] !== null && r[k] !== undefined)
        return b
      },
      lte: (k: string, v: string) => (filters.push((r) => String(r[k]) <= v), b),
      order: (k: string) => ((orderKey = k), b),
      range: (from: number, to: number) => ((range = [from, to]), b),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(resolve()).then(onF, onR),
    }
    return b
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from: (table: string) => builder(table) } as any
}

const AUTOMATION = {
  id: 'a1',
  account_id: 'acct-1',
  user_id: 'u1',
  trigger_type: 'conversation_inactive',
  trigger_config: { hours: 24, last_from: 'agent', statuses: ['open', 'pending'] },
  is_active: true,
}

function conv(
  id: string,
  patch: Partial<{
    account_id: string
    contact_id: string | null
    status: string
    last_message_at: string | null
    last_customer_message_at: string | null
    last_agent_message_at: string | null
  }> = {},
) {
  return {
    id,
    account_id: 'acct-1',
    contact_id: `contact-${id}`,
    status: 'open',
    last_message_at: hoursAgo(30),
    last_customer_message_at: hoursAgo(40),
    last_agent_message_at: hoursAgo(30),
    ...patch,
  }
}

beforeEach(() => {
  h.state.automations = []
  h.state.conversations = []
  h.state.fires = []
  h.state.conversationsError = null
  h.dispatches = []
})

describe('scanInactiveConversations', () => {
  it('fires once for a cold conversation and records the fire', async () => {
    h.state.automations = [AUTOMATION]
    h.state.conversations = [conv('c1')]

    const res = await scanInactiveConversations(makeDb(), NOW)

    expect(res).toMatchObject({ automations: 1, fired: 1, skipped: 0, errors: [] })
    expect(h.dispatches).toHaveLength(1)
    expect(h.dispatches[0]).toMatchObject({
      accountId: 'acct-1',
      triggerType: 'conversation_inactive',
      contactId: 'contact-c1',
      context: {
        conversation_id: 'c1',
        vars: { inactive_automation_id: 'a1', inactive_hours: 24, last_from: 'agent' },
      },
    })
    expect(h.state.fires).toEqual([
      { automation_id: 'a1', conversation_id: 'c1', fired_for: NOW.toISOString() },
    ])
  })

  it('does not fire again for the same silence, but re-arms after a new message', async () => {
    h.state.automations = [AUTOMATION]
    h.state.conversations = [conv('c1')]

    await scanInactiveConversations(makeDb(), NOW)
    const later = new Date(NOW.getTime() + 3_600_000)
    const second = await scanInactiveConversations(makeDb(), later)
    expect(second).toMatchObject({ fired: 0, skipped: 1 })
    expect(h.dispatches).toHaveLength(1)

    // Customer writes back, agent replies, then silence again for 30h.
    const muchLater = new Date(NOW.getTime() + 60 * 3_600_000)
    h.state.conversations[0] = conv('c1', {
      last_message_at: new Date(muchLater.getTime() - 30 * 3_600_000).toISOString(),
      last_agent_message_at: new Date(muchLater.getTime() - 30 * 3_600_000).toISOString(),
      last_customer_message_at: new Date(muchLater.getTime() - 31 * 3_600_000).toISOString(),
    })
    const third = await scanInactiveConversations(makeDb(), muchLater)
    expect(third).toMatchObject({ fired: 1, skipped: 0 })
    expect(h.dispatches).toHaveLength(2)
    expect(h.state.fires[0].fired_for).toBe(muchLater.toISOString())
  })

  it('respects hours, statuses, last_from and the account boundary', async () => {
    h.state.automations = [AUTOMATION]
    h.state.conversations = [
      conv('fresh', { last_message_at: hoursAgo(2), last_agent_message_at: hoursAgo(2) }),
      conv('closed', { status: 'closed' }),
      conv('customer-last', {
        last_customer_message_at: hoursAgo(30),
        last_agent_message_at: hoursAgo(40),
      }),
      conv('other-account', { account_id: 'acct-2' }),
      conv('no-contact', { contact_id: null }),
      conv('never-messaged', {
        last_message_at: null,
        last_customer_message_at: null,
        last_agent_message_at: null,
      }),
      conv('pending-ok', { status: 'pending' }),
    ]

    const res = await scanInactiveConversations(makeDb(), NOW)
    expect(res.fired).toBe(1)
    expect(h.dispatches.map((d) => (d.context as { conversation_id: string }).conversation_id)).toEqual([
      'pending-ok',
    ])
  })

  it("last_from = 'customer' picks unanswered conversations; 'any' picks both", async () => {
    h.state.conversations = [
      conv('agent-last'),
      conv('customer-last', {
        last_customer_message_at: hoursAgo(30),
        last_agent_message_at: hoursAgo(40),
      }),
    ]

    h.state.automations = [
      { ...AUTOMATION, trigger_config: { hours: 24, last_from: 'customer', statuses: ['open'] } },
    ]
    await scanInactiveConversations(makeDb(), NOW)
    expect(h.dispatches.map((d) => (d.context as { conversation_id: string }).conversation_id)).toEqual([
      'customer-last',
    ])

    h.dispatches = []
    h.state.fires = []
    h.state.automations = [
      { ...AUTOMATION, id: 'a2', trigger_config: { hours: 24, last_from: 'any', statuses: ['open'] } },
    ]
    await scanInactiveConversations(makeDb(), NOW)
    expect(h.dispatches).toHaveLength(2)
  })

  it('accepts decimal hours (0.05 = 3 minutes)', async () => {
    h.state.automations = [
      { ...AUTOMATION, trigger_config: { hours: 0.05, last_from: 'agent', statuses: ['open'] } },
    ]
    h.state.conversations = [
      conv('c1', {
        last_message_at: new Date(NOW.getTime() - 4 * 60_000).toISOString(),
        last_agent_message_at: new Date(NOW.getTime() - 4 * 60_000).toISOString(),
        last_customer_message_at: null,
      }),
      conv('c2', {
        last_message_at: new Date(NOW.getTime() - 60_000).toISOString(),
        last_agent_message_at: new Date(NOW.getTime() - 60_000).toISOString(),
        last_customer_message_at: null,
      }),
    ]
    const res = await scanInactiveConversations(makeDb(), NOW)
    expect(res.fired).toBe(1)
    expect((h.dispatches[0].context as { conversation_id: string }).conversation_id).toBe('c1')
  })

  it('processes at most 200 conversations per automation per tick', async () => {
    h.state.automations = [AUTOMATION]
    h.state.conversations = Array.from({ length: 250 }, (_, i) =>
      conv(`c${String(i).padStart(3, '0')}`),
    )
    const res = await scanInactiveConversations(makeDb(), NOW)
    expect(res.fired).toBe(200)
    expect(h.dispatches).toHaveLength(200)

    // Next tick picks up the rest.
    const res2 = await scanInactiveConversations(makeDb(), new Date(NOW.getTime() + 60_000))
    expect(res2.fired).toBe(50)
  })

  it('reports an invalid config and a query failure without throwing', async () => {
    h.state.automations = [
      { ...AUTOMATION, trigger_config: { hours: 0, last_from: 'agent', statuses: [] } },
    ]
    const bad = await scanInactiveConversations(makeDb(), NOW)
    expect(bad.errors).toEqual(['a1: invalid trigger config'])

    h.state.automations = [AUTOMATION]
    h.state.conversationsError = { message: 'boom' }
    const failed = await scanInactiveConversations(makeDb(), NOW)
    expect(failed.errors).toEqual(['a1: conversations: boom'])
    expect(h.dispatches).toHaveLength(0)
  })

  it('does nothing when there are no active inactivity automations', async () => {
    h.state.automations = [{ ...AUTOMATION, is_active: false }]
    h.state.conversations = [conv('c1')]
    const res = await scanInactiveConversations(makeDb(), NOW)
    expect(res).toEqual({ automations: 0, fired: 0, skipped: 0, errors: [] })
  })
})

describe('helpers', () => {
  it('parseInactiveConfig normalises and rejects', () => {
    expect(parseInactiveConfig({ hours: '12', statuses: ['open', 'open', 'bogus'] })).toEqual({
      hours: 12,
      last_from: 'agent',
      statuses: ['open'],
    })
    expect(parseInactiveConfig({ hours: 0.01, statuses: ['open'] })).toBeNull()
    expect(parseInactiveConfig({ hours: 1000, statuses: ['open'] })).toBeNull()
    expect(parseInactiveConfig({ hours: 24, statuses: [] })).toBeNull()
    expect(parseInactiveConfig(null)).toBeNull()
  })

  it('lastSender / matchesLastFrom', () => {
    expect(lastSender({ last_customer_message_at: null, last_agent_message_at: null })).toBeNull()
    expect(lastSender({ last_customer_message_at: hoursAgo(1), last_agent_message_at: null })).toBe(
      'customer',
    )
    expect(
      lastSender({ last_customer_message_at: hoursAgo(2), last_agent_message_at: hoursAgo(1) }),
    ).toBe('agent')
    expect(
      matchesLastFrom(
        { last_customer_message_at: hoursAgo(2), last_agent_message_at: hoursAgo(1) },
        'any',
      ),
    ).toBe(true)
  })
})
