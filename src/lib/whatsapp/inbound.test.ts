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
    profiles: [] as Record<string, unknown>[],
    flowRuns: [] as Record<string, unknown>[],
    /** A concurrent delivery's conversation that lands just before our insert. */
    conversationRace: null as Record<string, unknown> | null,
  },
  flows: { consumed: false },
  csat: null as { consumed: true; conversationId: string; kind: 'score' | 'comment' | 'declined' } | null,
  csatCalls: [] as Record<string, unknown>[],
  automationCalls: [] as Record<string, unknown>[],
  cancelledWaits: [] as string[],
  drains: [] as Record<string, unknown>[],
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
  cancelWaitsOnCustomerReply: vi.fn(async (conversationId: string) => {
    h.cancelledWaits.push(conversationId)
    return 0
  }),
}))

vi.mock('@/lib/automations/event-queue', () => ({
  drainAutomationEvents: vi.fn(async (opts: Record<string, unknown>) => {
    h.drains.push(opts)
    return { processed: 0, failed: 0 }
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

vi.mock('@/lib/support/csat-inbound', () => ({
  tryConsumeCsat: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
    h.csatCalls.push(input)
    return h.csat ?? { consumed: false }
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

// Suppression list (migration 077): no number is suppressed unless a test says so.
vi.mock('@/lib/lgpd/suppression', () => ({
  findSuppressedPhones: vi.fn(async () => new Set<string>()),
}))

import { ingestInboundMessage, toContentType, toIsoTimestamp } from './inbound'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { findSuppressedPhones } from '@/lib/lgpd/suppression'

let idSeq = 0
const nextId = (prefix: string) => `${prefix}-${++idSeq}`

/** Minimal chainable query builder over the in-memory state. */
function makeDb() {
  function builder(table: string) {
    const filters: [string, unknown][] = []
    const preds: ((r: Record<string, unknown>) => boolean)[] = []
    let orderBy: { col: string; ascending: boolean } | null = null
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
                : table === 'profiles'
                  ? h.state.profiles
                  : table === 'flow_runs'
                    ? h.state.flowRuns
                    : []
      // Embedded-resource filters ("broadcasts.account_id") are a
      // join in PostgREST; the mock has no joins, so ignore them.
      const out = src.filter(
        (r) =>
          filters.every(([k, v]) => k.includes('.') || r[k] === v) &&
          preds.every((f) => f(r)),
      )
      if (orderBy) {
        const { col, ascending } = orderBy
        out.sort((a, b) => {
          const x = String(a[col] ?? '')
          const y = String(b[col] ?? '')
          return (x < y ? -1 : x > y ? 1 : 0) * (ascending ? 1 : -1)
        })
      }
      return out
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
        if (table === 'conversations') {
          // Partial unique index (migration 060): one non-closed per contact.
          if (h.state.conversationRace) {
            h.state.conversations.push(h.state.conversationRace)
            h.state.conversationRace = null
          }
          const clash = h.state.conversations.some(
            (c) => c.contact_id === ops.payload?.contact_id && c.status !== 'closed',
          )
          if (clash) return { data: null, error: { code: '23505', message: 'duplicate key' } }
        }
        const row = {
          id: nextId(table),
          unread_count: 0,
          created_at: `2026-09-28T00:00:${String(idSeq).padStart(2, '0')}Z`,
          ...ops.payload,
        }
        if (table === 'contacts') h.state.contacts.push(row)
        if (table === 'conversations') h.state.conversations.push(row)
        if (table === 'messages') h.state.messages.push(row)
        if (table === 'conversation_events') h.state.events.push(row)
        return { data: row, error: null }
      }
      if (ops.type === 'update') {
        h.state.updates.push({ table, payload: ops.payload ?? {} })
        const hit = rows()
        for (const r of hit) Object.assign(r, ops.payload)
        return { data: hit, error: null }
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
      neq: (k: string, v: unknown) => (preds.push((r) => r[k] !== v), b),
      in: (k: string, vs: unknown[]) => (preds.push((r) => vs.includes(r[k])), b),
      order: (col: string, o?: { ascending?: boolean }) => (
        (orderBy = { col, ascending: o?.ascending ?? true }), b
      ),
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
        if (ops.type === 'update') {
          return Promise.resolve({ data: (r.data as Record<string, unknown>[])[0] ?? null, error: null })
        }
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
  h.state.conversationRace = null
  h.state.profiles = []
  h.state.flowRuns = []
  h.flows.consumed = false
  h.csat = null
  h.csatCalls = []
  h.automationCalls = []
  h.cancelledWaits = []
  h.drains = []
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

  it('flags the 1st and the 3rd customer message for the AI triage (071), nothing else', async () => {
    const seed = (customerMessages: number) => {
      h.state.contacts.push({ id: 'c-1', account_id: 'acct-1', phone: '5511999990000', name: 'Maria' })
      h.state.conversations.push({ id: 'conv-1', account_id: 'acct-1', contact_id: 'c-1' })
      for (let i = 0; i < customerMessages; i++) {
        h.state.messages.push({ id: `m-${i}`, conversation_id: 'conv-1', sender_type: 'customer', content_text: 'x' })
      }
    }
    const db = makeDb()
    expect((await ingestInboundMessage(BASE, db)).triageDue).toBe(true) // 1st
    h.state.contacts.length = 0
    h.state.conversations.length = 0
    h.state.messages.length = 0
    seed(1)
    expect((await ingestInboundMessage({ ...BASE, messageId: 'w2' }, db)).triageDue).toBeUndefined() // 2nd
    h.state.contacts.length = 0
    h.state.conversations.length = 0
    h.state.messages.length = 0
    seed(2)
    expect((await ingestInboundMessage({ ...BASE, messageId: 'w3' }, db)).triageDue).toBe(true) // 3rd
    h.state.contacts.length = 0
    h.state.conversations.length = 0
    h.state.messages.length = 0
    seed(3)
    expect((await ingestInboundMessage({ ...BASE, messageId: 'w4' }, db)).triageDue).toBeUndefined() // 4th
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

  // wacrm #478 / #490 — a template quick-reply tap (Meta `type: 'button'`)
  // must travel the same pipeline as any inbound message: stored as an
  // interactive reply, offered to the Flows engine as a tap, and handed
  // to the automations exactly once per trigger (no double-firing).
  it('treats a template quick-reply tap as one interactive inbound message', async () => {
    const db = makeDb()
    vi.mocked(dispatchInboundToFlows).mockClear()
    await ingestInboundMessage(
      {
        ...BASE,
        channel: 'official',
        messageId: 'wamid-btn',
        type: 'button',
        text: 'Quero saber mais',
        interactiveReplyId: 'SABER_MAIS',
      },
      db,
    )

    expect(h.state.messages).toHaveLength(1)
    expect(h.state.messages[0]).toMatchObject({
      content_type: 'interactive',
      content_text: 'Quero saber mais',
      interactive_reply_id: 'SABER_MAIS',
    })

    expect(dispatchInboundToFlows).toHaveBeenCalledTimes(1)
    expect(vi.mocked(dispatchInboundToFlows).mock.calls[0][0]).toMatchObject({
      message: {
        kind: 'interactive_reply',
        reply_id: 'SABER_MAIS',
        reply_title: 'Quero saber mais',
        meta_message_id: 'wamid-btn',
      },
    })

    const triggers = h.automationCalls.map((c) => c.triggerType)
    expect(triggers).toEqual([
      'first_inbound_message',
      'new_contact_created',
      'new_message_received',
      'keyword_match',
    ])
    // Keyword automations see the visible label, like typed text.
    for (const call of h.automationCalls) {
      expect(call).toMatchObject({ context: { message_text: 'Quero saber mais' } })
    }
  })

  it('suppresses the content triggers for a tap a flow consumed', async () => {
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

    await ingestInboundMessage(
      {
        ...BASE,
        channel: 'official',
        messageId: 'wamid-btn-2',
        type: 'button',
        text: 'Sim',
        interactiveReplyId: 'Sim',
      },
      db,
    )
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

  it('an opted-out contact writing again gets no flow and no out-of-hours notice', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-12T14:00:00Z'), toFake: ['Date'] }) // Saturday, closed
    const db = makeDb()
    h.state.accountPreferences = { out_of_hours_enabled: true, out_of_hours_message: 'Voltamos segunda!' }
    h.state.contacts.push({ id: 'c-1', account_id: 'acct-1', phone: '5511999990000', name: 'Maria', opted_out_at: '2026-01-01T00:00:00.000Z' })
    vi.mocked(dispatchInboundToFlows).mockClear()

    const res = await ingestInboundMessage({ ...BASE, text: 'tenho uma dúvida' }, db)

    expect(res.ok).toBe(true)
    expect(res.outOfHoursReply).toBeUndefined()
    expect(h.sendCalls).toHaveLength(0)
    expect(dispatchInboundToFlows).not.toHaveBeenCalled()
    // The message itself is stored for the agents.
    expect(h.state.messages.filter((m) => m.message_id === 'wamid-1')).toHaveLength(1)
  })

  it('an anonymised contact gets no flow either', async () => {
    const db = makeDb()
    h.state.contacts.push({ id: 'c-1', account_id: 'acct-1', phone: '5511999990000', name: 'Contato anonimizado', anonymized_at: '2026-01-01T00:00:00.000Z' })
    vi.mocked(dispatchInboundToFlows).mockClear()
    await ingestInboundMessage(BASE, db)
    expect(dispatchInboundToFlows).not.toHaveBeenCalled()
  })

  it('a number on the suppression list is created already opted out', async () => {
    const db = makeDb()
    vi.mocked(findSuppressedPhones).mockResolvedValueOnce(new Set(['5511999990000']))
    const res = await ingestInboundMessage(BASE, db)
    expect(res.contactCreated).toBe(true)
    expect(h.state.contacts[0].opted_out_at).toEqual(expect.any(String))
  })

  it('creates the contact normally when the suppression lookup fails (fail-open)', async () => {
    const db = makeDb()
    vi.mocked(findSuppressedPhones).mockRejectedValueOnce(new Error('down'))
    const res = await ingestInboundMessage(BASE, db)
    expect(res.contactCreated).toBe(true)
    expect(h.state.contacts[0].opted_out_at).toBeUndefined()
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
    // conversation_assigned now comes from the DB trigger's queue
    // (migration 048); inbound drains this account right away.
    expect(h.automationCalls.map((c) => c.triggerType)).not.toContain('conversation_assigned')
    expect(h.drains).toEqual([{ accountId: 'acct-1' }])
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

describe('ingestInboundMessage — resolved conversation is final', () => {
  function seedConversation(extra: Record<string, unknown>) {
    h.state.contacts.push({ id: 'c-1', account_id: 'acct-1', phone: '5511999990000', name: 'Maria' })
    h.state.conversations.push({
      id: 'conv-1',
      account_id: 'acct-1',
      contact_id: 'c-1',
      channel: 'qr',
      unread_count: 0,
      created_at: '2026-09-01T00:00:00Z',
      ...extra,
    })
    h.state.messages.push({ id: 'm-0', conversation_id: 'conv-1', sender_type: 'customer' })
  }

  it('a message after closing starts a NEW open conversation; the old one stays closed', async () => {
    const db = makeDb()
    seedConversation({ status: 'closed', assigned_agent_id: 'agent-1', archived_at: '2026-09-02T00:00:00Z' })

    const res = await ingestInboundMessage(BASE, db)

    expect(res).toMatchObject({ ok: true, newConversation: true, previousConversationId: 'conv-1' })
    expect(res.conversationId).not.toBe('conv-1')
    expect(h.state.conversations).toHaveLength(2)
    expect(h.state.conversations[0]).toMatchObject({ id: 'conv-1', status: 'closed', unread_count: 0 })
    const fresh = h.state.conversations[1]
    expect(fresh).toMatchObject({
      account_id: 'acct-1',
      user_id: 'owner-1',
      contact_id: 'c-1',
      channel: 'qr',
      status: 'open',
      unread_count: 1,
    })
    // Fresh owner: the previous assignee is not carried over.
    expect(fresh.assigned_agent_id).toBeUndefined()
    expect(h.state.messages.at(-1)).toMatchObject({ conversation_id: fresh.id, message_id: 'wamid-1' })
    // No reopen pill / status write on any row.
    expect(h.state.events).toHaveLength(0)
    const convUpdates = h.state.updates.filter((u) => u.table === 'conversations')
    expect(convUpdates.every((u) => !('status' in u.payload))).toBe(true)
  })

  it('fires the new-conversation triggers, not a reopen', async () => {
    const db = makeDb()
    seedConversation({ status: 'closed' })
    await ingestInboundMessage(BASE, db)
    const triggers = h.automationCalls.map((c) => c.triggerType)
    expect(triggers).toEqual(['first_inbound_message', 'new_message_received', 'keyword_match'])
    const fresh = h.state.conversations[1]
    expect(h.automationCalls[0]).toMatchObject({ context: { conversation_id: fresh.id } })
    expect(vi.mocked(dispatchInboundToFlows).mock.lastCall?.[0]).toMatchObject({
      conversationId: fresh.id,
      isFirstInboundMessage: true,
    })
    // Nothing reopened → no reopen event to drain.
    expect(h.drains).toEqual([])
  })

  it('runs the normal auto-assign on the new conversation', async () => {
    const db = makeDb()
    h.state.accountPreferences = { auto_assign_enabled: true }
    h.roundRobinPick = 'agent-7'
    seedConversation({ status: 'closed', assigned_agent_id: 'agent-1' })
    const res = await ingestInboundMessage(BASE, db)
    expect(res.autoAssignedTo).toBe('agent-7')
    expect(h.state.conversations[1].assigned_agent_id).toBe('agent-7')
    expect(h.state.conversations[0].assigned_agent_id).toBe('agent-1')
  })

  it('cancels reply-cancellable follow-ups on the new and the replaced conversation', async () => {
    const db = makeDb()
    seedConversation({ status: 'closed' })
    await ingestInboundMessage(BASE, db)
    expect(h.cancelledWaits).toEqual([h.state.conversations[1].id, 'conv-1'])
  })

  it('open and pending conversations continue: same row, no new conversation', async () => {
    const db = makeDb()
    seedConversation({ status: 'open' })
    const res = await ingestInboundMessage(BASE, db)
    expect(res).toMatchObject({ ok: true, conversationId: 'conv-1' })
    expect(res.newConversation).toBeUndefined()
    expect(h.state.conversations).toHaveLength(1)
    expect(h.state.events).toHaveLength(0)
    const upd = h.state.updates.find((u) => u.table === 'conversations')
    expect(upd?.payload).not.toHaveProperty('status')
    expect(h.automationCalls.map((c) => c.triggerType)).not.toContain('first_inbound_message')

    h.state.conversations[0].status = 'pending'
    const res2 = await ingestInboundMessage({ ...BASE, messageId: 'wamid-2' }, db)
    expect(res2.conversationId).toBe('conv-1')
    expect(h.state.conversations).toHaveLength(1)
    expect(h.state.conversations[0].status).toBe('pending')
  })

  it('continues the open conversation even when older resolved ones exist', async () => {
    const db = makeDb()
    seedConversation({ status: 'closed' })
    h.state.conversations.push({
      id: 'conv-2',
      account_id: 'acct-1',
      contact_id: 'c-1',
      status: 'open',
      unread_count: 0,
      created_at: '2026-09-10T00:00:00Z',
    })
    const res = await ingestInboundMessage(BASE, db)
    expect(res.conversationId).toBe('conv-2')
    expect(h.state.conversations).toHaveLength(2)
  })

  it('race: a concurrent delivery created the new conversation first → reuse it', async () => {
    const db = makeDb()
    seedConversation({ status: 'closed' })
    h.state.conversationRace = {
      id: 'conv-winner',
      account_id: 'acct-1',
      contact_id: 'c-1',
      status: 'open',
      unread_count: 1,
      created_at: '2026-09-28T00:00:00Z',
    }
    const res = await ingestInboundMessage(BASE, db)
    expect(res).toMatchObject({ ok: true, conversationId: 'conv-winner' })
    expect(res.newConversation).toBeUndefined()
    expect(h.state.conversations.filter((c) => c.status !== 'closed')).toHaveLength(1)
    expect(h.state.messages.at(-1)).toMatchObject({ conversation_id: 'conv-winner' })
  })

  it('a redelivery of a message stored in the resolved conversation is a duplicate, nothing created', async () => {
    const db = makeDb()
    seedConversation({ status: 'closed' })
    h.state.messages.push({
      id: 'm-1',
      conversation_id: 'conv-1',
      sender_type: 'customer',
      message_id: 'wamid-1',
    })
    const res = await ingestInboundMessage(BASE, db)
    expect(res).toMatchObject({ reason: 'duplicate', conversationId: 'conv-1' })
    expect(h.state.conversations).toHaveLength(1)
    expect(h.state.conversations[0].status).toBe('closed')
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
    expect(toContentType('button')).toBe('interactive')
  })

  it('toIsoTimestamp accepts seconds, millis, ISO and empty', () => {
    expect(toIsoTimestamp(1_700_000_000)).toBe('2023-11-14T22:13:20.000Z')
    expect(toIsoTimestamp('1700000000')).toBe('2023-11-14T22:13:20.000Z')
    expect(toIsoTimestamp(1_700_000_000_000)).toBe('2023-11-14T22:13:20.000Z')
    expect(toIsoTimestamp('2023-11-14T22:13:20.000Z')).toBe('2023-11-14T22:13:20.000Z')
    expect(typeof toIsoTimestamp(undefined)).toBe('string')
  })
})

describe('ingestInboundMessage — after a resolved conversation (review round)', () => {
  const NOW = new Date('2026-09-28T12:00:00Z')
  const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString()

  function seedClosed(lastMessage: Record<string, unknown> | null, extra: Record<string, unknown> = {}) {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    h.state.contacts.push({ id: 'c-1', account_id: 'acct-1', phone: '5511999990000', name: 'Maria' })
    h.state.conversations.push({
      id: 'conv-1',
      account_id: 'acct-1',
      contact_id: 'c-1',
      channel: 'qr',
      status: 'closed',
      unread_count: 0,
      created_at: '2026-09-01T00:00:00Z',
      ...extra,
    })
    h.state.messages.push({
      id: 'm-c',
      conversation_id: 'conv-1',
      sender_type: 'customer',
      created_at: hoursAgo(48),
    })
    if (lastMessage) h.state.messages.push({ id: 'm-last', conversation_id: 'conv-1', ...lastMessage })
  }

  it('a reply to our outbound message (< 24 h) reopens that conversation, keeps the owner, no first-message triggers', async () => {
    seedClosed(
      { sender_type: 'agent', origin: 'automation', created_at: hoursAgo(2) },
      { assigned_agent_id: 'agent-1' },
    )
    h.state.accountPreferences = { auto_assign_enabled: true }
    h.roundRobinPick = 'agent-7'
    const res = await ingestInboundMessage(BASE, makeDb())
    expect(res).toMatchObject({ ok: true, conversationId: 'conv-1', reopened: true })
    expect(res.newConversation).toBeUndefined()
    expect(res.autoAssignedTo).toBeUndefined()
    expect(h.state.conversations).toHaveLength(1)
    expect(h.state.conversations[0]).toMatchObject({ status: 'open', assigned_agent_id: 'agent-1' })
    expect(h.automationCalls.map((c) => c.triggerType)).not.toContain('first_inbound_message')
    expect(vi.mocked(dispatchInboundToFlows).mock.lastCall?.[0]).toMatchObject({ isFirstInboundMessage: false })
    expect(h.state.events).toEqual([
      expect.objectContaining({
        event_type: 'status_changed',
        payload: { status: 'open', previous_status: 'closed', source: 'customer_reply' },
      }),
    ])
    expect(h.drains).toEqual([{ accountId: 'acct-1' }])
  })

  describe('satisfaction survey answers (migration 074)', () => {
    const csatAnswer = { consumed: true as const, conversationId: 'conv-1', kind: 'score' as const }
    beforeEach(() => vi.mocked(dispatchInboundToFlows).mockClear())

    it('is asked BEFORE the conversation is chosen, with the closed conversations of the contact', async () => {
      seedClosed({ sender_type: 'bot', origin: 'csat', created_at: hoursAgo(1) })
      await ingestInboundMessage({ ...BASE, text: '5' }, makeDb())
      expect(h.csatCalls).toHaveLength(1)
      expect(h.csatCalls[0]).toMatchObject({
        accountId: 'acct-1',
        contactId: 'c-1',
        text: '5',
        type: 'text',
        messageId: 'wamid-1',
        conversations: [{ id: 'conv-1', status: 'closed' }],
      })
    })

    it('a consumed answer is the exception to the 24 h reply rule: no reopen, no new conversation, nothing else runs', async () => {
      seedClosed({ sender_type: 'bot', origin: 'csat', created_at: hoursAgo(1) }, { assigned_agent_id: 'agent-1', unread_count: 0 })
      h.csat = csatAnswer
      const res = await ingestInboundMessage({ ...BASE, text: '5' }, makeDb())
      expect(res).toMatchObject({ ok: true, conversationId: 'conv-1', csat: 'score' })
      expect(res.reopened).toBeUndefined()
      expect(res.newConversation).toBeUndefined()
      // The pipeline did not store the message, touch the conversation, or run anything.
      expect(h.state.conversations).toHaveLength(1)
      expect(h.state.conversations[0]).toMatchObject({ status: 'closed', unread_count: 0 })
      expect(h.state.updates).toEqual([])
      expect(h.state.messages.filter((m) => m.message_id === 'wamid-1')).toEqual([])
      expect(h.state.events).toEqual([])
      expect(vi.mocked(dispatchInboundToFlows)).not.toHaveBeenCalled()
      expect(h.automationCalls).toEqual([])
      expect(h.cancelledWaits).toEqual([])
      expect(h.drains).toEqual([])
      expect(h.roundRobinCalls).toBe(0)
      expect(h.sendCalls).toEqual([])
    })

    it('survey traffic is not "our outbound": a non-score reply after only the survey never reopens, it is a new conversation', async () => {
      seedClosed({ sender_type: 'bot', origin: 'csat', created_at: hoursAgo(1) })
      const res = await ingestInboundMessage({ ...BASE, text: 'meu problema voltou' }, makeDb())
      expect(res.reopened).toBeUndefined()
      expect(res.csat).toBeUndefined()
      expect(res.newConversation).toBe(true)
      expect(h.state.conversations.find((c) => c.id === 'conv-1')?.status).toBe('closed')
      expect(h.automationCalls.map((c) => c.triggerType)).toContain('first_inbound_message')
    })

    it('the survey, the thanks and the answers do not hide a REAL agent message before them: within 24 h it still reopens', async () => {
      seedClosed({ sender_type: 'agent', origin: null, created_at: hoursAgo(3) })
      h.state.messages.push(
        { id: 'm-s', conversation_id: 'conv-1', sender_type: 'bot', origin: 'csat', created_at: hoursAgo(2) },
        { id: 'm-a', conversation_id: 'conv-1', sender_type: 'customer', origin: 'csat', created_at: hoursAgo(1.5) },
        { id: 'm-t', conversation_id: 'conv-1', sender_type: 'bot', origin: 'csat', created_at: hoursAgo(1) },
      )
      const res = await ingestInboundMessage({ ...BASE, text: 'preciso de outra coisa' }, makeDb())
      expect(res).toMatchObject({ ok: true, conversationId: 'conv-1', reopened: true })
    })

    it('a redelivery of an already stored message is a duplicate before the survey is consulted', async () => {
      seedClosed({ sender_type: 'bot', origin: 'csat', created_at: hoursAgo(1) })
      h.state.messages.push({ id: 'm-dup', conversation_id: 'conv-1', message_id: 'wamid-1', sender_type: 'customer', created_at: hoursAgo(0.5) })
      const res = await ingestInboundMessage({ ...BASE, text: '5' }, makeDb())
      expect(res.reason).toBe('duplicate')
      expect(h.csatCalls).toEqual([])
    })
  })

  it('also for an outbound sent from the inbox (no origin)', async () => {
    seedClosed({ sender_type: 'agent', origin: null, created_at: hoursAgo(23) })
    const res = await ingestInboundMessage(BASE, makeDb())
    expect(res).toMatchObject({ conversationId: 'conv-1', reopened: true })
  })

  it.each([
    ['our last message is older than 24 h', { sender_type: 'agent', created_at: hoursAgo(25) }],
    ['the last message was a phone echo', { sender_type: 'agent', origin: 'phone', created_at: hoursAgo(1) }],
    ['the customer wrote last', null],
  ])('a new conversation when %s', async (_label, last) => {
    seedClosed(last as Record<string, unknown> | null)
    const res = await ingestInboundMessage(BASE, makeDb())
    expect(res.newConversation).toBe(true)
    expect(res.reopened).toBeUndefined()
    expect(h.state.conversations[0].status).toBe('closed')
    expect(h.automationCalls.map((c) => c.triggerType)).toContain('first_inbound_message')
  })

  it('moves the contact\'s active flow runs from the resolved conversation to the new one before the runner', async () => {
    seedClosed(null)
    h.state.flowRuns.push(
      { id: 'run-1', account_id: 'acct-1', contact_id: 'c-1', conversation_id: 'conv-1', status: 'active' },
      { id: 'run-2', account_id: 'acct-1', contact_id: 'c-1', conversation_id: 'conv-1', status: 'completed' },
    )
    let seenAtDispatch: unknown = null
    vi.mocked(dispatchInboundToFlows).mockImplementationOnce(async () => {
      seenAtDispatch = h.state.flowRuns[0].conversation_id
      return { consumed: false, outcome: 'no_match' } as never
    })
    const res = await ingestInboundMessage(BASE, makeDb())
    expect(seenAtDispatch).toBe(res.conversationId)
    expect(h.state.flowRuns[1].conversation_id).toBe('conv-1')
  })

  it('resolves a quoted message that lives in the resolved conversation', async () => {
    seedClosed(null)
    h.state.messages.push({ id: 'm-quoted', conversation_id: 'conv-1', message_id: 'wamid-old', sender_type: 'agent' })
    await ingestInboundMessage({ ...BASE, quotedMessageId: 'wamid-old' }, makeDb())
    expect(h.state.messages.at(-1)).toMatchObject({ message_id: 'wamid-1', reply_to_message_id: 'm-quoted' })
  })

  it('without auto-assign, the new conversation goes to the previous agent when still an agent+ member', async () => {
    seedClosed(null, { assigned_agent_id: 'agent-1' })
    h.state.profiles.push({ account_id: 'acct-1', user_id: 'agent-1', account_role: 'agent' })
    const res = await ingestInboundMessage(BASE, makeDb())
    expect(res.inheritedAssignee).toBe('agent-1')
    expect(h.state.conversations[1].assigned_agent_id).toBe('agent-1')
    expect(h.state.events).toEqual([
      expect.objectContaining({
        event_type: 'assigned',
        payload: { assignee_user_id: 'agent-1', source: 'previous_conversation' },
      }),
    ])
  })

  it('does not inherit a removed member, a viewer, or when auto-assign already assigned', async () => {
    seedClosed(null, { assigned_agent_id: 'agent-1' })
    const gone = await ingestInboundMessage(BASE, makeDb())
    expect(gone.inheritedAssignee).toBeUndefined()

    h.state.conversations.splice(1)
    h.state.conversations[0].status = 'closed'
    h.state.profiles.push({ account_id: 'acct-1', user_id: 'agent-1', account_role: 'viewer' })
    const viewer = await ingestInboundMessage({ ...BASE, messageId: 'wamid-2' }, makeDb())
    expect(viewer.inheritedAssignee).toBeUndefined()

    h.state.conversations.splice(1)
    h.state.profiles[0].account_role = 'agent'
    h.state.accountPreferences = { auto_assign_enabled: true }
    h.roundRobinPick = 'agent-7'
    const auto = await ingestInboundMessage({ ...BASE, messageId: 'wamid-3' }, makeDb())
    expect(auto.autoAssignedTo).toBe('agent-7')
    expect(auto.inheritedAssignee).toBeUndefined()
  })

  it('out-of-hours: no second notice when the contact got one in the resolved conversation < 12 h ago', async () => {
    // Saturday 2026-09-12 14:00Z = 11:00 in São Paulo → closed.
    const SATURDAY = new Date('2026-09-12T14:00:00Z')
    seedClosed(null, { out_of_hours_replied_at: new Date(SATURDAY.getTime() - 3 * 3_600_000).toISOString() })
    vi.setSystemTime(SATURDAY)
    h.state.accountPreferences = { out_of_hours_enabled: true, out_of_hours_message: 'Voltamos segunda!' }
    const res = await ingestInboundMessage(BASE, makeDb())
    expect(res.newConversation).toBe(true)
    expect(res.outOfHoursReply).toBeUndefined()
    expect(h.sendCalls).toHaveLength(0)
  })

  it('out-of-hours: replies again when the previous notice is older than 12 h', async () => {
    const SATURDAY = new Date('2026-09-12T14:00:00Z')
    seedClosed(null, { out_of_hours_replied_at: new Date(SATURDAY.getTime() - 13 * 3_600_000).toISOString() })
    vi.setSystemTime(SATURDAY)
    h.state.accountPreferences = { out_of_hours_enabled: true, out_of_hours_message: 'Voltamos segunda!' }
    const res = await ingestInboundMessage(BASE, makeDb())
    expect(res.outOfHoursReply).toBe('sent')
  })
})
