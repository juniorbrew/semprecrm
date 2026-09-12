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
    contactInsertError: null as { code?: string; message: string } | null,
    updates: [] as { table: string; payload: Record<string, unknown> }[],
  },
  flows: { consumed: false },
  automationCalls: [] as Record<string, unknown>[],
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
          data: h.state.accountOwner ? { owner_user_id: h.state.accountOwner } : null,
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
  h.state.contactInsertError = null
  h.state.updates = []
  h.flows.consumed = false
  h.automationCalls = []
  idSeq = 0
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
