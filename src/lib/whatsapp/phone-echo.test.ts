import { beforeEach, describe, expect, it, vi } from 'vitest'

// ------------------------------------------------------------
// Phone echoes (sent from the connected phone) and revokes on the QR
// channel — lib/whatsapp/phone-echo. In-memory Supabase mock; every
// customer-side engine is stubbed so we can assert none of them runs.
// ------------------------------------------------------------

const h = vi.hoisted(() => ({
  state: {
    contacts: [] as Record<string, unknown>[],
    conversations: [] as Record<string, unknown>[],
    messages: [] as Record<string, unknown>[],
    flowRuns: [] as Record<string, unknown>[],
    updates: [] as { table: string; payload: Record<string, unknown> }[],
    /** Simulates the race: the next messages insert loses to the unique index. */
    raceOnInsert: null as Record<string, unknown> | null,
  },
  automations: vi.fn(),
  flows: vi.fn(),
  push: vi.fn(),
  cancelWaits: vi.fn(),
  autoReply: vi.fn(),
}))

vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: h.automations,
  cancelWaitsOnCustomerReply: h.cancelWaits,
}))
vi.mock('@/lib/automations/event-queue', () => ({ drainAutomationEvents: vi.fn() }))
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: h.flows }))
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => {
    throw new Error('test must inject db')
  },
}))
vi.mock('@/lib/automations/meta-send', () => ({ engineSendText: h.autoReply }))
vi.mock('@/lib/push/notify', () => ({ notifyInboundMessage: h.push }))
vi.mock('@/lib/push/send', () => ({ isPushConfigured: () => true }))
vi.mock('@/lib/assignment/round-robin', () => ({ pickRoundRobinAssignee: vi.fn() }))
vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: vi.fn(
    async (_db: unknown, accountId: string, phone: string) =>
      h.state.contacts.find((c) => c.account_id === accountId && c.phone === phone) ?? null,
  ),
  isUniqueViolation: (err: unknown) =>
    typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505',
}))

import { claimEchoedRow, ingestPhoneEcho, markMessageRevoked } from './phone-echo'

let idSeq = 0

function makeDb() {
  function builder(table: string) {
    const filters: [string, unknown][] = []
    const ops = {
      type: 'select' as 'select' | 'insert' | 'update',
      payload: undefined as Record<string, unknown> | undefined,
      returning: false,
    }
    const src = (): Record<string, unknown>[] =>
      table === 'contacts'
        ? h.state.contacts
        : table === 'conversations'
          ? h.state.conversations
          : table === 'messages'
            ? h.state.messages
            : table === 'flow_runs'
              ? h.state.flowRuns
              : []
    const rows = () => src().filter((r) => filters.every(([k, v]) => (r[k] ?? null) === v))
    function resolve(): { data: unknown; error: unknown } {
      if (table === 'accounts') return { data: { owner_user_id: 'owner-1' }, error: null }
      if (ops.type === 'insert') {
        const p = ops.payload ?? {}
        if (table === 'messages') {
          if (h.state.raceOnInsert) {
            h.state.messages.push({ id: `m-race`, ...h.state.raceOnInsert })
            h.state.raceOnInsert = null
          }
          const clash = h.state.messages.some(
            (m) => m.conversation_id === p.conversation_id && m.message_id === p.message_id,
          )
          if (clash) return { data: null, error: { code: '23505', message: 'duplicate key' } }
        }
        const row = { id: `${table}-${++idSeq}`, unread_count: 0, ...p }
        src().push(row)
        return { data: row, error: null }
      }
      if (ops.type === 'update') {
        h.state.updates.push({ table, payload: ops.payload ?? {} })
        const hit = rows()
        for (const r of hit) Object.assign(r, ops.payload)
        return { data: ops.returning ? hit : null, error: null }
      }
      return { data: rows(), error: null }
    }
    const b: Record<string, unknown> = {
      select: () => {
        if (ops.type !== 'select') ops.returning = true
        return b
      },
      insert: (p: Record<string, unknown>) => ((ops.type = 'insert'), (ops.payload = p), b),
      update: (p: Record<string, unknown>) => ((ops.type = 'update'), (ops.payload = p), b),
      eq: (k: string, v: unknown) => (filters.push([k, v]), b),
      is: (k: string, v: unknown) => (filters.push([k, v]), b),
      single: () => {
        const r = resolve()
        if (ops.type === 'insert') return Promise.resolve(r)
        const first = (r.data as Record<string, unknown>[] | null)?.[0]
        return Promise.resolve(
          first ? { data: first, error: null } : { data: null, error: { code: 'PGRST116' } },
        )
      },
      maybeSingle: () => {
        const r = resolve()
        if (table === 'accounts') return Promise.resolve(r)
        const first = (r.data as Record<string, unknown>[] | null)?.[0] ?? null
        return Promise.resolve({ data: first, error: r.error })
      },
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(resolve()).then(onF, onR),
    }
    return b
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from: (table: string) => builder(table) } as any
}

const ECHO = {
  accountId: 'acct-1',
  from: '5511999990000',
  messageId: '3APHONE1',
  type: 'text',
  text: 'respondi pelo celular',
  timestamp: 1_757_700_000,
}

function seedConversation(extra: Record<string, unknown> = {}) {
  h.state.contacts.push({ id: 'c-1', account_id: 'acct-1', phone: '5511999990000', name: 'Maria' })
  h.state.conversations.push({
    id: 'conv-1',
    account_id: 'acct-1',
    contact_id: 'c-1',
    unread_count: 2,
    status: 'closed',
    channel: 'qr',
    ...extra,
  })
}

beforeEach(() => {
  h.state.contacts = []
  h.state.conversations = []
  h.state.messages = []
  h.state.flowRuns = []
  h.state.updates = []
  h.state.raceOnInsert = null
  for (const fn of [h.automations, h.flows, h.push, h.cancelWaits, h.autoReply]) fn.mockReset()
  idSeq = 0
})

describe('ingestPhoneEcho', () => {
  it('stores the echo once as an outbound "phone" row', async () => {
    seedConversation()
    const res = await ingestPhoneEcho(ECHO, makeDb())
    expect(res).toMatchObject({ ok: true, conversationId: 'conv-1', contactId: 'c-1' })
    expect(h.state.messages).toHaveLength(1)
    expect(h.state.messages[0]).toMatchObject({
      conversation_id: 'conv-1',
      sender_type: 'agent',
      sender_id: null,
      origin: 'phone',
      status: 'sent',
      channel: 'qr',
      message_id: '3APHONE1',
      content_text: 'respondi pelo celular',
      created_at: new Date(1_757_700_000 * 1000).toISOString(),
    })
  })

  it('is not customer activity: no unread, no reopen, no flows/automations/push/auto-reply', async () => {
    seedConversation()
    await ingestPhoneEcho(ECHO, makeDb())
    const conv = h.state.updates.find((u) => u.table === 'conversations')!.payload
    expect(conv).toMatchObject({ last_message_text: 'respondi pelo celular' })
    expect(conv).not.toHaveProperty('unread_count')
    expect(conv).not.toHaveProperty('status')
    expect(conv).not.toHaveProperty('channel')
    expect(conv).not.toHaveProperty('last_customer_message_at')
    expect(h.state.conversations[0]).toMatchObject({ unread_count: 2, status: 'closed' })
    expect(h.automations).not.toHaveBeenCalled()
    expect(h.flows).not.toHaveBeenCalled()
    expect(h.push).not.toHaveBeenCalled()
    expect(h.cancelWaits).not.toHaveBeenCalled()
    expect(h.autoReply).not.toHaveBeenCalled()
  })

  it('pauses active flow runs — a human replied, like an inbox send', async () => {
    seedConversation()
    h.state.flowRuns.push({ id: 'run-1', account_id: 'acct-1', contact_id: 'c-1', status: 'active' })
    await ingestPhoneEcho(ECHO, makeDb())
    expect(h.state.flowRuns[0]).toMatchObject({ status: 'paused_by_agent', end_reason: 'agent_replied' })
  })

  it('never renames the contact; a new contact is named after its phone', async () => {
    const res = await ingestPhoneEcho(ECHO, makeDb())
    expect(res.ok).toBe(true)
    expect(h.state.contacts).toEqual([
      expect.objectContaining({ phone: '5511999990000', name: '5511999990000' }),
    ])
    expect(h.state.conversations[0]).toMatchObject({ channel: 'qr' })
  })

  it('a redelivery of the same id is a no-op', async () => {
    seedConversation()
    const db = makeDb()
    await ingestPhoneEcho(ECHO, db)
    const again = await ingestPhoneEcho(ECHO, db)
    expect(again).toMatchObject({ ok: true, duplicate: true })
    expect(h.state.messages).toHaveLength(1)
  })

  it('race: the same id landed between lookup and insert → duplicate, no second row', async () => {
    seedConversation()
    h.state.raceOnInsert = {
      conversation_id: 'conv-1',
      message_id: '3APHONE1',
      sender_type: 'agent',
      sender_id: 'user-9',
    }
    const res = await ingestPhoneEcho(ECHO, makeDb())
    expect(res).toMatchObject({ ok: true, duplicate: true })
    expect(h.state.messages).toHaveLength(1)
    expect(h.state.messages[0]).toMatchObject({ sender_id: 'user-9' })
  })

  it('media echo keeps the media URL and uses the type as preview', async () => {
    seedConversation()
    await ingestPhoneEcho(
      { ...ECHO, messageId: 'IMG', type: 'image', text: null, mediaUrl: 'https://x/a.jpg' },
      makeDb(),
    )
    expect(h.state.messages[0]).toMatchObject({ content_type: 'image', media_url: 'https://x/a.jpg' })
    expect(h.state.updates.find((u) => u.table === 'conversations')!.payload).toMatchObject({
      last_message_text: '[image]',
    })
  })
})

describe('claimEchoedRow', () => {
  it('lets an inbox send take over the echo row it raced with', async () => {
    h.state.messages.push({
      id: 'm-1',
      conversation_id: 'conv-1',
      message_id: 'W1',
      sender_type: 'agent',
      sender_id: null,
      origin: 'phone',
    })
    const row = await claimEchoedRow(makeDb(), 'conv-1', 'W1', { sender_type: 'agent', sender_id: 'u-1' })
    expect(row).toMatchObject({ id: 'm-1', sender_id: 'u-1', origin: null })
  })

  it('returns null when the conflicting row is not a phone echo', async () => {
    h.state.messages.push({ id: 'm-1', conversation_id: 'conv-1', message_id: 'W1', origin: null })
    expect(await claimEchoedRow(makeDb(), 'conv-1', 'W1', { sender_id: 'u-1' })).toBeNull()
  })
})

describe('markMessageRevoked', () => {
  it('marks the customer message as deleted and keeps its content', async () => {
    seedConversation()
    h.state.messages.push({
      id: 'm-1',
      conversation_id: 'conv-1',
      message_id: 'MSG1',
      content_text: 'segredo',
      sender_type: 'customer',
      revoked_at: null,
    })
    const res = await markMessageRevoked(
      { accountId: 'acct-1', messageId: 'MSG1', from: '5511999990000', revokedBy: 'customer', timestamp: 1_757_700_100 },
      makeDb(),
    )
    expect(res).toEqual({ ok: true, found: true })
    expect(h.state.messages).toHaveLength(1)
    expect(h.state.messages[0]).toMatchObject({
      content_text: 'segredo',
      revoked_by: 'customer',
      revoked_at: new Date(1_757_700_100 * 1000).toISOString(),
    })
  })

  it('unknown contact / message → found false, nothing written', async () => {
    const a = await markMessageRevoked(
      { accountId: 'acct-1', messageId: 'X', from: '5500000000000', revokedBy: 'customer' },
      makeDb(),
    )
    expect(a).toEqual({ ok: true, found: false })
    seedConversation()
    const b = await markMessageRevoked(
      { accountId: 'acct-1', messageId: 'NOPE', from: '5511999990000', revokedBy: 'customer' },
      makeDb(),
    )
    expect(b).toEqual({ ok: true, found: false })
  })

  it('is scoped to the account: another tenant with the same phone is untouched', async () => {
    seedConversation()
    h.state.messages.push({ id: 'm-1', conversation_id: 'conv-1', message_id: 'MSG1', revoked_at: null })
    const res = await markMessageRevoked(
      { accountId: 'acct-2', messageId: 'MSG1', from: '5511999990000', revokedBy: 'customer' },
      makeDb(),
    )
    expect(res.found).toBe(false)
    expect(h.state.messages[0].revoked_at).toBeNull()
  })
})
