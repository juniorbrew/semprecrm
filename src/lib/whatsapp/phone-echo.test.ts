import { beforeEach, describe, expect, it, vi } from 'vitest'

// ------------------------------------------------------------
// Phone echoes (sent from the connected phone) and revokes on the QR
// channel — lib/whatsapp/phone-echo. In-memory Supabase mock; every
// customer-side engine is stubbed so we can assert none of them runs.
// ------------------------------------------------------------

type R = Record<string, unknown>

const h = vi.hoisted(() => ({
  state: {
    contacts: [] as Record<string, unknown>[],
    conversations: [] as Record<string, unknown>[],
    messages: [] as Record<string, unknown>[],
    flowRuns: [] as Record<string, unknown>[],
    updates: [] as { table: string; payload: Record<string, unknown> }[],
    /** Simulates the race: the next messages insert loses to the unique index. */
    raceOnInsert: null as Record<string, unknown> | null,
    /** Table whose next read fails (transient DB error). */
    failRead: null as string | null,
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

import {
  claimEchoedRow,
  ingestPhoneEcho,
  markMessageRevoked,
  phoneEchoCountsAsReply,
} from './phone-echo'

let idSeq = 0

type Filter = (r: R) => boolean

function makeDb() {
  function builder(table: string) {
    const filters: Filter[] = []
    const ops = {
      type: 'select' as 'select' | 'insert' | 'update',
      payload: undefined as R | undefined,
      returning: false,
    }
    const src = (): R[] =>
      table === 'contacts'
        ? h.state.contacts
        : table === 'conversations'
          ? h.state.conversations
          : table === 'messages'
            ? h.state.messages
            : table === 'flow_runs'
              ? h.state.flowRuns
              : []
    const rows = () => src().filter((r) => filters.every((f) => f(r)))
    function resolve(): { data: unknown; error: unknown } {
      if (ops.type === 'select' && h.state.failRead === table) {
        h.state.failRead = null
        return { data: null, error: { message: 'connection reset' } }
      }
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
        const row = { id: `${table}-${++idSeq}`, ...p }
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
      insert: (p: R) => ((ops.type = 'insert'), (ops.payload = p), b),
      update: (p: R) => ((ops.type = 'update'), (ops.payload = p), b),
      eq: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), b),
      neq: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) !== v), b),
      is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), b),
      in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), b),
      like: (k: string, pattern: string) => {
        const suffix = pattern.replace(/^%/, '')
        filters.push((r) => String(r[k] ?? '').endsWith(suffix))
        return b
      },
      // Only the shape phone-echo uses: last_message_at.is.null,last_message_at.lte."<iso>"
      or: (expr: string) => {
        const m = expr.match(/lte\."([^"]+)"/)
        const bound = m ? new Date(m[1]).getTime() : Infinity
        filters.push(
          (r) => r.last_message_at == null || new Date(r.last_message_at as string).getTime() <= bound,
        )
        return b
      },
      order: () => b,
      maybeSingle: () => {
        const r = resolve()
        const first = (r.data as R[] | null)?.[0] ?? null
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

const T0 = 1_757_700_000 // echo timestamp (epoch s)
const iso = (s: number) => new Date(s * 1000).toISOString()

const ECHO = {
  accountId: 'acct-1',
  from: '5511999990000',
  messageId: '3APHONE1',
  type: 'text',
  text: 'respondi pelo celular',
  timestamp: T0,
}

function seedConversation(extra: R = {}) {
  h.state.contacts.push({ id: 'c-1', account_id: 'acct-1', phone: '5511999990000', name: 'Maria' })
  h.state.conversations.push({
    id: 'conv-1',
    account_id: 'acct-1',
    contact_id: 'c-1',
    unread_count: 2,
    status: 'closed',
    channel: 'qr',
    last_message_at: iso(T0 - 600),
    last_customer_message_at: iso(T0 - 600),
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
  h.state.failRead = null
  for (const fn of [h.automations, h.flows, h.push, h.cancelWaits, h.autoReply]) fn.mockReset()
  idSeq = 0
})

describe('phoneEchoCountsAsReply (mirrors the 059 trigger)', () => {
  it('within 15 s after the customer → automatic greeting, not a reply', () => {
    expect(phoneEchoCountsAsReply(iso(T0), iso(T0))).toBe(false)
    expect(phoneEchoCountsAsReply(iso(T0 + 15), iso(T0))).toBe(false)
  })

  it('more than 15 s after, before the customer, or no customer message → reply', () => {
    expect(phoneEchoCountsAsReply(iso(T0 + 16), iso(T0))).toBe(true)
    expect(phoneEchoCountsAsReply(iso(T0 - 1), iso(T0))).toBe(true)
    expect(phoneEchoCountsAsReply(iso(T0), null)).toBe(true)
  })
})

describe('ingestPhoneEcho', () => {
  it('stores the echo once as an outbound "phone" row', async () => {
    seedConversation()
    const res = await ingestPhoneEcho(ECHO, makeDb())
    expect(res).toMatchObject({
      ok: true,
      conversationId: 'conv-1',
      contactId: 'c-1',
      countsAsReply: true,
    })
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
      created_at: iso(T0),
    })
  })

  it('is not customer activity: no unread, no reopen, no flows/automations/push/auto-reply', async () => {
    seedConversation()
    await ingestPhoneEcho(ECHO, makeDb())
    const conv = h.state.updates.find((u) => u.table === 'conversations')!.payload
    expect(conv).toMatchObject({
      last_message_text: 'respondi pelo celular',
      last_message_at: iso(T0),
    })
    for (const key of ['unread_count', 'status', 'channel', 'last_customer_message_at']) {
      expect(conv).not.toHaveProperty(key)
    }
    expect(h.state.conversations[0]).toMatchObject({ unread_count: 2, status: 'closed' })
    expect(h.automations).not.toHaveBeenCalled()
    expect(h.flows).not.toHaveBeenCalled()
    expect(h.push).not.toHaveBeenCalled()
    expect(h.cancelWaits).not.toHaveBeenCalled()
    expect(h.autoReply).not.toHaveBeenCalled()
  })

  it('a human reply (> 15 s after the customer) pauses active flow runs', async () => {
    seedConversation({ last_customer_message_at: iso(T0 - 16) })
    h.state.flowRuns.push({ id: 'run-1', account_id: 'acct-1', contact_id: 'c-1', status: 'active' })
    const res = await ingestPhoneEcho(ECHO, makeDb())
    expect(res.countsAsReply).toBe(true)
    expect(h.state.flowRuns[0]).toMatchObject({
      status: 'paused_by_agent',
      end_reason: 'agent_replied',
    })
  })

  it('a greeting / away message (≤ 15 s after the customer) is stored but pauses nothing', async () => {
    seedConversation({ last_customer_message_at: iso(T0 - 2) })
    h.state.flowRuns.push({ id: 'run-1', account_id: 'acct-1', contact_id: 'c-1', status: 'active' })
    const res = await ingestPhoneEcho(ECHO, makeDb())
    expect(res).toMatchObject({ ok: true, countsAsReply: false })
    expect(h.state.messages).toHaveLength(1)
    expect(h.state.flowRuns[0]).toMatchObject({ status: 'active' })
    // the preview still moves
    expect(h.state.conversations[0]).toMatchObject({ last_message_at: iso(T0) })
  })

  it('never creates contacts or conversations (personal chats are skipped)', async () => {
    const res = await ingestPhoneEcho(ECHO, makeDb())
    expect(res).toEqual({ ok: true, skipped: 'unknown_contact' })
    expect(h.state.contacts).toHaveLength(0)
    expect(h.state.conversations).toHaveLength(0)
    expect(h.state.messages).toHaveLength(0)

    h.state.contacts.push({ id: 'c-1', account_id: 'acct-1', phone: '5511999990000' })
    expect(await ingestPhoneEcho(ECHO, makeDb())).toEqual({ ok: true, skipped: 'no_conversation' })
    expect(h.state.conversations).toHaveLength(0)
    expect(h.state.messages).toHaveLength(0)
  })

  it('skips anonymised contacts', async () => {
    seedConversation()
    h.state.contacts[0].anonymized_at = iso(T0 - 100)
    expect(await ingestPhoneEcho(ECHO, makeDb())).toEqual({
      ok: true,
      skipped: 'anonymized_contact',
    })
    expect(h.state.messages).toHaveLength(0)
  })

  it('another account with the same phone is not touched', async () => {
    seedConversation()
    const res = await ingestPhoneEcho({ ...ECHO, accountId: 'acct-2' }, makeDb())
    expect(res.skipped).toBe('unknown_contact')
    expect(h.state.messages).toHaveLength(0)
  })

  it('never moves the preview backwards', async () => {
    seedConversation({ last_message_at: iso(T0 + 60), last_message_text: 'mais nova' })
    await ingestPhoneEcho(ECHO, makeDb())
    expect(h.state.messages).toHaveLength(1)
    expect(h.state.conversations[0]).toMatchObject({
      last_message_at: iso(T0 + 60),
      last_message_text: 'mais nova',
    })
  })

  it('a redelivery of the same id is a no-op, across all conversations of the contact', async () => {
    seedConversation()
    h.state.conversations.push({ id: 'conv-2', account_id: 'acct-1', contact_id: 'c-1' })
    h.state.messages.push({ id: 'm-0', conversation_id: 'conv-2', message_id: '3APHONE1' })
    const res = await ingestPhoneEcho(ECHO, makeDb())
    expect(res).toMatchObject({ ok: true, duplicate: true })
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

  it('a DB failure on any lookup is ok:false (the route answers 5xx → gateway retries)', async () => {
    for (const table of ['contacts', 'conversations', 'messages']) {
      h.state.contacts = []
      h.state.conversations = []
      h.state.messages = []
      seedConversation()
      h.state.failRead = table
      const res = await ingestPhoneEcho(ECHO, makeDb())
      expect(res.ok).toBe(false)
      expect(h.state.messages).toHaveLength(0)
    }
  })

  it('media echo keeps the media URL and uses the type as preview', async () => {
    seedConversation()
    await ingestPhoneEcho(
      { ...ECHO, messageId: 'IMG', type: 'image', text: null, mediaUrl: 'https://x/a.jpg' },
      makeDb(),
    )
    expect(h.state.messages[0]).toMatchObject({
      content_type: 'image',
      media_url: 'https://x/a.jpg',
    })
    expect(h.state.conversations[0]).toMatchObject({ last_message_text: '[image]' })
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
    const row = await claimEchoedRow(makeDb(), 'conv-1', 'W1', {
      sender_type: 'agent',
      sender_id: 'u-1',
    })
    expect(row).toMatchObject({ id: 'm-1', sender_id: 'u-1', origin: null })
  })

  it('returns null when the conflicting row is not a phone echo', async () => {
    h.state.messages.push({ id: 'm-1', conversation_id: 'conv-1', message_id: 'W1', origin: null })
    expect(await claimEchoedRow(makeDb(), 'conv-1', 'W1', { sender_id: 'u-1' })).toBeNull()
  })
})

describe('markMessageRevoked', () => {
  const REVOKE = {
    accountId: 'acct-1',
    messageId: 'MSG1',
    from: '5511999990000',
    revokedBy: 'customer' as const,
    timestamp: T0 + 100,
  }

  function seedMessage(extra: R) {
    h.state.messages.push({
      id: 'm-1',
      conversation_id: 'conv-1',
      message_id: 'MSG1',
      content_text: 'segredo',
      sender_type: 'customer',
      revoked_at: null,
      ...extra,
    })
  }

  it('marks the customer message as deleted and keeps its content', async () => {
    seedConversation()
    seedMessage({})
    expect(await markMessageRevoked(REVOKE, makeDb())).toEqual({ ok: true, found: true })
    expect(h.state.messages).toHaveLength(1)
    expect(h.state.messages[0]).toMatchObject({
      content_text: 'segredo',
      revoked_by: 'customer',
      revoked_at: iso(T0 + 100),
    })
  })

  it('the customer cannot revoke one of OUR messages (same id)', async () => {
    seedConversation()
    seedMessage({ sender_type: 'agent' })
    expect(await markMessageRevoked(REVOKE, makeDb())).toEqual({ ok: true, found: false })
    expect(h.state.messages[0].revoked_at).toBeNull()
  })

  it('our phone only revokes outbound rows', async () => {
    seedConversation()
    seedMessage({ sender_type: 'customer' })
    const phone = { ...REVOKE, revokedBy: 'phone' as const }
    expect(await markMessageRevoked(phone, makeDb())).toEqual({ ok: true, found: false })
    h.state.messages[0].sender_type = 'agent'
    expect(await markMessageRevoked(phone, makeDb())).toEqual({ ok: true, found: true })
    expect(h.state.messages[0]).toMatchObject({ revoked_by: 'phone' })
  })

  it('finds the message in any conversation of that contact', async () => {
    seedConversation()
    h.state.conversations.push({ id: 'conv-2', account_id: 'acct-1', contact_id: 'c-1' })
    seedMessage({ conversation_id: 'conv-2' })
    expect(await markMessageRevoked(REVOKE, makeDb())).toEqual({ ok: true, found: true })
  })

  it('unknown contact / message → found false, nothing written', async () => {
    expect(await markMessageRevoked(REVOKE, makeDb())).toEqual({ ok: true, found: false })
    seedConversation()
    expect(await markMessageRevoked({ ...REVOKE, messageId: 'NOPE' }, makeDb())).toEqual({
      ok: true,
      found: false,
    })
  })

  it('is scoped to the account: another tenant with the same phone is untouched', async () => {
    seedConversation()
    seedMessage({})
    const res = await markMessageRevoked({ ...REVOKE, accountId: 'acct-2' }, makeDb())
    expect(res.found).toBe(false)
    expect(h.state.messages[0].revoked_at).toBeNull()
  })

  it('a DB failure on the lookup is ok:false (retry)', async () => {
    seedConversation()
    seedMessage({})
    h.state.failRead = 'conversations'
    expect(await markMessageRevoked(REVOKE, makeDb())).toEqual({ ok: false, found: false })
    expect(h.state.messages[0].revoked_at).toBeNull()
  })
})
