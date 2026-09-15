import { beforeEach, describe, expect, it, vi } from 'vitest'

// ------------------------------------------------------------
// ingestInboundMessage — the shared pipeline behind the Meta
// webhook and the QR gateway route. The Supabase admin client is a
// hand-rolled in-memory mock; the engines are stubbed.
// ------------------------------------------------------------

const h = vi.hoisted(() => ({
  state: {
    contacts: [] as Record<string, unknown>[],
    conversations: [] as Record<string, unknown>[],
    messages: [] as Record<string, unknown>[],
    recipients: [] as Record<string, unknown>[],
    accountOwner: 'owner-1' as string | null,
    accountPreferences: null as Record<string, unknown> | null,
    events: [] as Record<string, unknown>[],
    contactInsertError: null as { code?: string; message: string } | null,
    updates: [] as { table: string; payload: Record<string, unknown> }[],
  },
  flows: { consumed: false },
  automationCalls: [] as Record<string, unknown>[],
  // Availability features (spec round 2 §2)
  roundRobinPick: null as string | null,
  roundRobinCalls: 0,
  sendCalls: [] as Record<string, unknown>[],
  sendError: null as Error | null,
}))

vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: vi.fn(async (args: Record<string, unknown>) => {
    h.automationCalls.push(args)
  }),
}))

vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: vi.fn(async () => ({
    consumed: h.flows.consumed,
    outcome: h.flows.consumed ? 'advanced' : 'no_match',
  })),
}))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => {
    throw new Error('test must inject db')
  },
}))

vi.mock('@/lib/assignment/round-robin', () => ({
  pickRoundRobinAssignee: vi.fn(async () => {
    h.roundRobinCalls += 1
    return h.roundRobinPick
  }),
}))

vi.mock('@/lib/automations/meta-send', () => ({
  engineSendText: vi.fn(async (args: Record<string, unknown>) => {
    h.sendCalls.push(args)
    if (h.sendError) throw h.sendError
    return { whatsapp_message_id: 'bot-1' }
  }),
}))

vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: vi.fn(async (_db: unknown, accountId: string, phone: string) => {
    return (
      h.state.contacts.find((c) => c.account_id === accountId && c.phone === phone) ?? null
    )
  }),
  isUniqueViolation: (err: unknown) =>
    typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505',
}))

import { ingestInboundMessage, toContentType, toIsoTimestamp } from './inbound'

let idSeq = 0
const nextId = (prefix: string) => `${prefix}-${++idSeq}`

/** Minimal chainable query builder over the in-memory state. */
function makeDb() {
  function builder(table: string) {
    const filters: [string, unknown][] = []
    const ops = {
      type: 'select' as 'select' | 'insert' | 'update',
      payload: undefined as Record<string, unknown> | undefined,
      count: false,
    }
    const rows = (): Record<string, unknown>[] => {
      const src =
        table === 'contacts'
          ? h.state.contacts
          : table === 'conversations'
            ? h.state.conversations
            : table === 'messages'
              ? h.state.messages
              : table === 'broadcast_recipients'
                ? h.state.recipients
                : []
      // Embedded-resource filters ("broadcasts.account_id") are a
      // join in PostgREST; the mock has no joins, so ignore them.
      return src.filter((r) =>
        filters.every(([k, v]) => k.includes('.') || r[k] === v),
      )
    }
    function resolve() {
      if (table === 'accounts') {
        return {
          data: h.state.accountOwner
            ? { owner_user_id: h.state.accountOwner, preferences: h.state.accountPreferences }
            : null,
          error: null,
        }
      }
      if (ops.type === 'insert') {
        if (table === 'contacts' && h.state.contactInsertError) {
          return { data: null, error: h.state.contactInsertError }
        }
        const row = { id: nextId(table), unread_count: 0, ...ops.payload }
        if (table === 'contacts') h.state.contacts.push(row)
        if (table === 'conversations') h.state.conversations.push(row)
        if (table === 'messages') h.state.messages.push(row)
        if (table === 'conversation_events') h.state.events.push(row)
        return { data: row, error: null }
      }
      if (ops.type === 'update') {
        h.state.updates.push({ table, payload: ops.payload ?? {} })
        for (const r of rows()) Object.assign(r, ops.payload)
        return { data: null, error: null }
      }
      const matched = rows()
      if (ops.count) return { data: null, count: matched.length, error: null }
      return { data: matched, error: null }
    }
    const b: Record<string, unknown> = {
      select: (_cols?: string, opts?: { count?: string }) => {
        if (opts?.count) ops.count = true
        return b
      },
      insert: (p: Record<string, unknown>) => ((ops.type = 'insert'), (ops.payload = p), b),
      update: (p: Record<string, unknown>) => ((ops.type = 'update'), (ops.payload = p), b),
      eq: (k: string, v: unknown) => (filters.push([k, v]), b),
      in: () => b,
      order: () => b,
      limit: () => b,
      single: () => {
        const r = resolve()
        if (ops.type !== 'select') return Promise.resolve(r)
        const first = (r.data as Record<string, unknown>[] | null)?.[0]
        return Promise.resolve(
          first ? { data: first, error: null } : { data: null, error: { code: 'PGRST116' } },
        )
      },
      maybeSingle: () => {
        const r = resolve()
        if (table === 'accounts' || ops.type !== 'select') return Promise.resolve(r)
        const first = (r.data as Record<string, unknown>[] | null)?.[0] ?? null
        return Promise.resolve({ data: first, error: null })
      },
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(resolve()).then(onF, onR),
    }
    return b
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from: (table: string) => builder(table) } as any
}

const BASE = {
  accountId: 'acct-1',
  channel: 'qr' as const,
  from: '5511999990000',
  pushName: 'Maria',
  messageId: 'wamid-1',
  type: 'text',
  text: 'olá',
  timestamp: 1_757_700_000,
}

beforeEach(() => {
  h.state.contacts = []
  h.state.conversations = []
  h.state.messages = []
  h.state.recipients = []
  h.state.accountOwner = 'owner-1'
  h.state.accountPreferences = null
  h.state.events = []
  h.state.contactInsertError = null
  h.state.updates = []
  h.flows.consumed = false
  h.automationCalls = []
  h.roundRobinPick = null
  h.roundRobinCalls = 0
  h.sendCalls = []
  h.sendError = null
  idSeq = 0
  vi.useRealTimers()
})

describe('ingestInboundMessage', () => {
  it('creates contact, conversation and message for a first-time sender', async () => {
    const db = makeDb()
    const res = await ingestInboundMessage(BASE, db)

    expect(res.ok).toBe(true)
    expect(res.contactCreated).toBe(true)
    expect(h.state.contacts).toHaveLength(1)
    expect(h.state.contacts[0]).toMatchObject({
      account_id: 'acct-1',
      user_id: 'owner-1',
      name: 'Maria',
    })
    expect(h.state.conversations[0]).toMatchObject({
      account_id: 'acct-1',
      channel: 'qr',
    })
    expect(h.state.messages[0]).toMatchObject({
      sender_type: 'customer',
      content_type: 'text',
      content_text: 'olá',
      message_id: 'wamid-1',
      status: 'delivered',
      channel: 'qr',
      created_at: new Date(1_757_700_000 * 1000).toISOString(),
    })
  })

  it('bumps unread_count, last_message and channel on the conversation', async () => {
    const db = makeDb()
    h.state.contacts.push({ id: 'c-1', account_id: 'acct-1', phone: '5511999990000', name: 'Maria' })
    h.state.conversations.push({
      id: 'conv-1',
      account_id: 'acct-1',
      contact_id: 'c-1',
      unread_count: 2,
      channel: 'official',
    })

    const res = await ingestInboundMessage(BASE, db)
    expect(res.ok).toBe(true)
    expect(res.contactCreated).toBe(false)
    const upd = h.state.updates.find((u) => u.table === 'conversations')
    expect(upd?.payload).toMatchObject({
      unread_count: 3,
      last_message_text: 'olá',
      channel: 'qr',
    })
  })

  it('fires first_inbound_message + new_contact_created + content triggers', async () => {
    const db = makeDb()
    await ingestInboundMessage(BASE, db)
    const triggers = h.automationCalls.map((c) => c.triggerType)
    expect(triggers).toEqual([
      'first_inbound_message',
      'new_contact_created',
      'new_message_received',
      'keyword_match',
    ])
    expect(h.automationCalls[0]).toMatchObject({
      accountId: 'acct-1',
      context: { message_text: 'olá' },
    })
  })

  it('suppresses content triggers when a flow consumed the message', async () => {
    const db = makeDb()
    h.flows.consumed = true
    h.state.contacts.push({ id: 'c-1', account_id: 'acct-1', phone: '5511999990000', name: 'Maria' })
    h.state.conversations.push({ id: 'conv-1', account_id: 'acct-1', contact_id: 'c-1' })
    h.state.messages.push({
      id: 'm-old',
      conversation_id: 'conv-1',
      sender_type: 'customer',
      message_id: 'older',
    })

    await ingestInboundMessage({ ...BASE, messageId: 'wamid-2' }, db)
    expect(h.automationCalls).toHaveLength(0)
  })

  it('maps sticker → image and keeps location as a text summary', async () => {
    const db = makeDb()
    await ingestInboundMessage(
      { ...BASE, messageId: 'st-1', type: 'sticker', text: null, mediaUrl: 'https://x/s.webp' },
      db,
    )
    await ingestInboundMessage(
      { ...BASE, messageId: 'loc-1', type: 'location', text: 'Praça - -23.5,-46.6' },
      db,
    )
    expect(h.state.messages[0]).toMatchObject({
      content_type: 'image',
      media_url: 'https://x/s.webp',
      content_text: null,
    })
    // 'location' is in the CHECK list — the bubble renders it from the
    // text summary the transport built (name - address - lat,lng).
    expect(h.state.messages[1]).toMatchObject({
      content_type: 'location',
      content_text: 'Praça - -23.5,-46.6',
      media_url: null,
    })
  })

  it('ignores a redelivered message id', async () => {
    const db = makeDb()
    await ingestInboundMessage(BASE, db)
    const res = await ingestInboundMessage(BASE, db)
    expect(res.reason).toBe('duplicate')
    expect(h.state.messages).toHaveLength(1)
  })

  it('links a quoted parent when we have it', async () => {
    const db = makeDb()
    await ingestInboundMessage(BASE, db)
    await ingestInboundMessage(
      { ...BASE, messageId: 'wamid-2', quotedMessageId: 'wamid-1' },
      db,
    )
    expect(h.state.messages[1]).toMatchObject({
      reply_to_message_id: h.state.messages[0].id,
    })
  })

  it('flags the latest broadcast recipient as replied', async () => {
    const db = makeDb()
    h.state.contacts.push({ id: 'c-1', account_id: 'acct-1', phone: '5511999990000', name: 'Maria' })
    h.state.recipients.push({ id: 'r-1', contact_id: 'c-1', status: 'delivered' })

    await ingestInboundMessage(BASE, db)
    const upd = h.state.updates.find((u) => u.table === 'broadcast_recipients')
    expect(upd?.payload).toMatchObject({ status: 'replied' })
  })

  it('resolves the account owner when no userId is given, and fails closed without one', async () => {
    const db = makeDb()
    h.state.accountOwner = null
    const res = await ingestInboundMessage(BASE, db)
    expect(res).toMatchObject({ ok: false, reason: 'account_owner_not_found' })
    expect(h.state.messages).toHaveLength(0)
  })

  it('uses the explicit userId as sender-of-record (Meta webhook path)', async () => {
    const db = makeDb()
    await ingestInboundMessage({ ...BASE, channel: 'official', userId: 'cfg-owner' }, db)
    expect(h.state.contacts[0]).toMatchObject({ user_id: 'cfg-owner' })
    expect(h.state.messages[0]).toMatchObject({ channel: 'official' })
  })

  it('recovers from a lost insert race on contacts', async () => {
    const db = makeDb()
    h.state.contactInsertError = { code: '23505', message: 'duplicate key' }
    // The "winner" of the race appears once the unique violation fires.
    const { findExistingContact } = await import('@/lib/contacts/dedupe')
    ;(findExistingContact as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'c-raced', account_id: 'acct-1', phone: '5511999990000', name: 'Maria' })

    const res = await ingestInboundMessage(BASE, db)
    expect(res.ok).toBe(true)
    expect(res.contactId).toBe('c-raced')
    expect(res.contactCreated).toBe(false)
  })
})

describe('ingestInboundMessage — opt-out', () => {
  it('marks the contact opted out, logs the pill and flags the automation context on "PARAR"', async () => {
    const db = makeDb()
    h.state.contacts.push({ id: 'c-1', account_id: 'acct-1', phone: '5511999990000', name: 'Maria' })
    h.state.conversations.push({
      id: 'conv-1',
      account_id: 'acct-1',
      contact_id: 'c-1',
      unread_count: 0,
      channel: 'qr',
    })
    h.state.messages.push({
      id: 'm-0',
      conversation_id: 'conv-1',
      sender_type: 'customer',
      message_id: 'old',
    })

    const res = await ingestInboundMessage({ ...BASE, text: ' PARAR!! ' }, db)

    expect(res.ok).toBe(true)
    expect(res.optedOut).toBe(true)
    expect(h.state.contacts[0].opted_out_at).toEqual(expect.any(String))
    expect(h.state.events).toHaveLength(1)
    expect(h.state.events[0]).toMatchObject({
      account_id: 'acct-1',
      conversation_id: 'conv-1',
      actor_user_id: null,
      event_type: 'contact_opted_out',
      payload: { keyword: 'parar' },
    })
    // The message itself is still stored.
    expect(h.state.messages.filter((m) => m.message_id === 'wamid-1')).toHaveLength(1)
    // Every automation dispatched for this message carries vars.opted_out.
    expect(h.automationCalls.length).toBeGreaterThan(0)
    for (const call of h.automationCalls) {
      expect((call.context as { vars?: Record<string, unknown> }).vars).toEqual({ opted_out: true })
    }
  })

  it('uses the account keyword list and ignores sentences that merely contain a word', async () => {
    const db = makeDb()
    h.state.accountPreferences = { opt_out_keywords: ['chega'] }

    const a = await ingestInboundMessage({ ...BASE, text: 'parar' }, db)
    expect(a.optedOut).toBe(false)
    expect(h.state.events).toHaveLength(0)

    const b = await ingestInboundMessage({ ...BASE, messageId: 'wamid-2', text: 'Chega.' }, db)
    expect(b.optedOut).toBe(true)
    expect(h.state.events).toHaveLength(1)

    const c = await ingestInboundMessage(
      { ...BASE, messageId: 'wamid-3', text: 'quero parar de receber' },
      db,
    )
    expect(c.optedOut).toBe(false)
  })

  it('does not log a second pill for a contact that is already opted out', async () => {
    const db = makeDb()
    h.state.contacts.push({
      id: 'c-1',
      account_id: 'acct-1',
      phone: '5511999990000',
      name: 'Maria',
      opted_out_at: '2026-01-01T00:00:00.000Z',
    })
    const res = await ingestInboundMessage({ ...BASE, text: 'sair' }, db)
    expect(res.optedOut).toBe(true)
    expect(h.state.events).toHaveLength(0)
    expect(h.state.contacts[0].opted_out_at).toBe('2026-01-01T00:00:00.000Z')
  })

  it('leaves normal messages alone', async () => {
    const db = makeDb()
    const res = await ingestInboundMessage(BASE, db)
    expect(res.optedOut).toBe(false)
    expect(h.state.events).toHaveLength(0)
    for (const call of h.automationCalls) {
      expect((call.context as { vars?: unknown }).vars).toBeUndefined()
    }
  })
})

describe('ingestInboundMessage — auto-assign (round-robin)', () => {
  it('does nothing when auto_assign_enabled is off', async () => {
    const db = makeDb()
    const res = await ingestInboundMessage(BASE, db)
    expect(res.autoAssignedTo).toBeUndefined()
    expect(h.roundRobinCalls).toBe(0)
  })

  it('assigns the first customer message of an ownerless conversation and logs the pill', async () => {
    const db = makeDb()
    h.state.accountPreferences = { auto_assign_enabled: true }
    h.roundRobinPick = 'agent-7'

    const res = await ingestInboundMessage(BASE, db)

    expect(res.autoAssignedTo).toBe('agent-7')
    expect(h.state.conversations[0].assigned_agent_id).toBe('agent-7')
    expect(h.state.events).toHaveLength(1)
    expect(h.state.events[0]).toMatchObject({
      event_type: 'assigned',
      actor_user_id: null,
      payload: { assignee_user_id: 'agent-7', source: 'auto_assign' },
    })
    expect(h.automationCalls.map((c) => c.triggerType)).toContain('conversation_assigned')
  })

  it('leaves the conversation alone when it already has an owner or is not the first message', async () => {
    const db = makeDb()
    h.state.accountPreferences = { auto_assign_enabled: true }
    h.roundRobinPick = 'agent-7'
    h.state.contacts.push({ id: 'c-1', account_id: 'acct-1', phone: '5511999990000', name: 'Maria' })
    h.state.conversations.push({
      id: 'conv-1',
      account_id: 'acct-1',
      contact_id: 'c-1',
      assigned_agent_id: 'agent-1',
      channel: 'qr',
    })

    const res = await ingestInboundMessage(BASE, db)
    expect(res.autoAssignedTo).toBeUndefined()
    expect(h.roundRobinCalls).toBe(0)
    expect(h.state.conversations[0].assigned_agent_id).toBe('agent-1')

    // Second customer message on an ownerless conversation: not the first → untouched.
    h.state.conversations[0].assigned_agent_id = null
    const res2 = await ingestInboundMessage({ ...BASE, messageId: 'wamid-2' }, db)
    expect(res2.autoAssignedTo).toBeUndefined()
    expect(h.roundRobinCalls).toBe(0)
  })

  it('stays unassigned when nobody is available', async () => {
    const db = makeDb()
    h.state.accountPreferences = { auto_assign_enabled: true }
    h.roundRobinPick = null

    const res = await ingestInboundMessage(BASE, db)
    expect(res.autoAssignedTo).toBeUndefined()
    expect(h.roundRobinCalls).toBe(1)
    expect(h.state.conversations[0].assigned_agent_id).toBeUndefined()
    expect(h.state.events).toHaveLength(0)
  })
})

describe('ingestInboundMessage — out-of-hours reply', () => {
  // Saturday 2026-09-12 14:00Z = 11:00 in São Paulo → closed (default hours).
  const SATURDAY = new Date('2026-09-12T14:00:00Z')
  // Monday 2026-09-14 14:00Z = 11:00 in São Paulo → open.
  const MONDAY = new Date('2026-09-14T14:00:00Z')

  it('is silent when the feature is off', async () => {
    vi.useFakeTimers({ now: SATURDAY, toFake: ['Date'] })
    const db = makeDb()
    const res = await ingestInboundMessage(BASE, db)
    expect(res.outOfHoursReply).toBeUndefined()
    expect(h.sendCalls).toHaveLength(0)
  })

  it('sends the message through the conversation channel and stamps the conversation', async () => {
    vi.useFakeTimers({ now: SATURDAY, toFake: ['Date'] })
    const db = makeDb()
    h.state.accountPreferences = {
      out_of_hours_enabled: true,
      out_of_hours_message: 'Voltamos segunda!',
    }

    const res = await ingestInboundMessage(BASE, db)

    expect(res.outOfHoursReply).toBe('sent')
    expect(h.sendCalls).toHaveLength(1)
    expect(h.sendCalls[0]).toMatchObject({
      accountId: 'acct-1',
      userId: 'owner-1',
      conversationId: h.state.conversations[0].id,
      text: 'Voltamos segunda!',
    })
    expect(h.state.conversations[0].out_of_hours_replied_at).toBe(SATURDAY.toISOString())
  })

  it('does not reply during business hours', async () => {
    vi.useFakeTimers({ now: MONDAY, toFake: ['Date'] })
    const db = makeDb()
    h.state.accountPreferences = { out_of_hours_enabled: true }
    const res = await ingestInboundMessage(BASE, db)
    expect(res.outOfHoursReply).toBeUndefined()
    expect(h.sendCalls).toHaveLength(0)
  })

  it('replies at most once per local day', async () => {
    vi.useFakeTimers({ now: SATURDAY, toFake: ['Date'] })
    const db = makeDb()
    h.state.accountPreferences = { out_of_hours_enabled: true }

    await ingestInboundMessage(BASE, db)
    const res2 = await ingestInboundMessage({ ...BASE, messageId: 'wamid-2' }, db)
    expect(res2.outOfHoursReply).toBeUndefined()
    expect(h.sendCalls).toHaveLength(1)

    // Next local day (Sunday, still closed) → replies again.
    vi.setSystemTime(new Date('2026-09-13T14:00:00Z'))
    const res3 = await ingestInboundMessage({ ...BASE, messageId: 'wamid-3' }, db)
    expect(res3.outOfHoursReply).toBe('sent')
    expect(h.sendCalls).toHaveLength(2)
  })

  it('records skipped (and still stamps) when Meta refuses the send outside the 24 h window', async () => {
    vi.useFakeTimers({ now: SATURDAY, toFake: ['Date'] })
    const db = makeDb()
    h.state.accountPreferences = { out_of_hours_enabled: true }
    h.sendError = new Error('Meta API error 131047: Re-engagement message')

    const res = await ingestInboundMessage({ ...BASE, channel: 'official' }, db)
    expect(res.outOfHoursReply).toBe('skipped')
    expect(h.state.conversations[0].out_of_hours_replied_at).toBe(SATURDAY.toISOString())
  })

  it('reports failed and leaves the stamp empty on other send errors', async () => {
    vi.useFakeTimers({ now: SATURDAY, toFake: ['Date'] })
    const db = makeDb()
    h.state.accountPreferences = { out_of_hours_enabled: true }
    h.sendError = new Error('gateway unreachable')

    const res = await ingestInboundMessage(BASE, db)
    expect(res.outOfHoursReply).toBe('failed')
    expect(h.state.conversations[0].out_of_hours_replied_at).toBeUndefined()
  })

  it('does not auto-reply to an opt-out message', async () => {
    vi.useFakeTimers({ now: SATURDAY, toFake: ['Date'] })
    const db = makeDb()
    h.state.accountPreferences = { out_of_hours_enabled: true }
    const res = await ingestInboundMessage({ ...BASE, text: 'PARAR' }, db)
    expect(res.optedOut).toBe(true)
    expect(res.outOfHoursReply).toBeUndefined()
    expect(h.sendCalls).toHaveLength(0)
  })
})

describe('helpers', () => {
  it('toContentType', () => {
    expect(toContentType('text')).toBe('text')
    expect(toContentType('sticker')).toBe('image')
    expect(toContentType('reaction')).toBe('text')
    expect(toContentType('interactive')).toBe('interactive')
  })

  it('toIsoTimestamp accepts seconds, millis, ISO and empty', () => {
    expect(toIsoTimestamp(1_700_000_000)).toBe('2023-11-14T22:13:20.000Z')
    expect(toIsoTimestamp('1700000000')).toBe('2023-11-14T22:13:20.000Z')
    expect(toIsoTimestamp(1_700_000_000_000)).toBe('2023-11-14T22:13:20.000Z')
    expect(toIsoTimestamp('2023-11-14T22:13:20.000Z')).toBe('2023-11-14T22:13:20.000Z')
    expect(typeof toIsoTimestamp(undefined)).toBe('string')
  })
})
