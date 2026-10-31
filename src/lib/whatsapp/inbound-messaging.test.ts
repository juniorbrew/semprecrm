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

import { MessagingSkipError } from '@/lib/meta-messaging/skip'
import { ingestInboundMessage } from './inbound'
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
      is: (k: string, v: unknown) => (preds.push((r) => (r[k] ?? null) === v), b),
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

// ------------------------------------------------------------
// Instagram / Messenger identities (migration 100): the sender key is the
// IGSID / PSID, contacts have no phone, nothing automatic answers.
// ------------------------------------------------------------

const IG = {
  accountId: 'acct-1',
  channel: 'instagram' as const,
  from: 'IGSID-123456',
  messageId: 'mid.1',
  type: 'text',
  text: 'oi',
  timestamp: 1_757_700_000_000,
}

describe('ingestInboundMessage — Instagram / Messenger', () => {
  it('creates a contact with only the instagram id, a conversation and a message on that channel', async () => {
    const r = await ingestInboundMessage(IG, makeDb())
    expect(r).toMatchObject({ ok: true, contactCreated: true, newConversation: true })
    expect(h.state.contacts).toHaveLength(1)
    expect(h.state.contacts[0]).toMatchObject({ account_id: 'acct-1', instagram_id: 'IGSID-123456', name: 'Instagram 123456' })
    expect(h.state.contacts[0]).not.toHaveProperty('phone')
    expect(h.state.conversations[0]).toMatchObject({ channel: 'instagram', contact_id: h.state.contacts[0].id })
    expect(h.state.messages[0]).toMatchObject({ channel: 'instagram', message_id: 'mid.1', sender_type: 'customer', content_text: 'oi' })
  })

  it('messenger keys the contact by messenger_id, not instagram_id', async () => {
    await ingestInboundMessage({ ...IG, channel: 'messenger', from: 'PSID-9' }, makeDb())
    expect(h.state.contacts[0]).toMatchObject({ messenger_id: 'PSID-9' })
    expect(h.state.contacts[0]).not.toHaveProperty('instagram_id')
  })

  it('reuses the contact for the same id and ignores a redelivered mid', async () => {
    await ingestInboundMessage(IG, makeDb())
    const again = await ingestInboundMessage({ ...IG, messageId: 'mid.2' }, makeDb())
    expect(again).toMatchObject({ ok: true, contactCreated: false })
    expect(h.state.contacts).toHaveLength(1)
    const dup = await ingestInboundMessage(IG, makeDb())
    expect(dup).toMatchObject({ ok: true, reason: 'duplicate' })
    expect(h.state.messages).toHaveLength(2)
  })

  it('looks the profile up only for a new contact; the photo is stored under the new contact id', async () => {
    const getProfile = vi.fn(async () => ({ name: 'Ana Souza', pictureUrl: 'https://scontent.cdninstagram.com/p.jpg' }))
    const storeAvatar = vi.fn(async (contactId: string) => `/supabase/storage/v1/object/public/contact-avatars/account-acct-1/${contactId}`)
    await ingestInboundMessage({ ...IG, getProfile, storeAvatar }, makeDb())
    expect(getProfile).toHaveBeenCalledTimes(1)
    const contact = h.state.contacts[0]
    expect(storeAvatar).toHaveBeenCalledWith(contact.id, 'https://scontent.cdninstagram.com/p.jpg')
    expect(contact).toMatchObject({ name: 'Ana Souza', avatar_url: `/supabase/storage/v1/object/public/contact-avatars/account-acct-1/${contact.id}` })
    await ingestInboundMessage({ ...IG, messageId: 'mid.2', getProfile, storeAvatar }, makeDb())
    expect(getProfile).toHaveBeenCalledTimes(1)
  })

  it('a DM from an anonymised identity starts a new contact', async () => {
    h.state.contacts.push({ id: 'old', account_id: 'acct-1', instagram_id: 'IGSID-123456', anonymized_at: '2026-01-01T00:00:00Z' })
    const r = await ingestInboundMessage(IG, makeDb())
    expect(r.contactCreated).toBe(true)
    expect(h.state.contacts).toHaveLength(2)
  })

  it('a failing profile lookup never drops the message', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const getProfile = vi.fn(async () => {
      throw new Error('graph down')
    })
    const r = await ingestInboundMessage({ ...IG, getProfile }, makeDb())
    expect(r.ok).toBe(true)
    expect(h.state.contacts[0].name).toBe('Instagram 123456')
    expect(h.state.messages).toHaveLength(1)
    warn.mockRestore()
  })

  it('skips only the phone-only LGPD suppression lookup', async () => {
    await ingestInboundMessage(IG, makeDb())
    expect(findSuppressedPhones).not.toHaveBeenCalled()
  })

  it('answers out of hours on an Instagram conversation through the engine sender (part C)', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-24T15:00:00Z'), toFake: ['Date'] }) // a Saturday
    h.state.accountPreferences = { out_of_hours_enabled: true, out_of_hours_message: 'Voltamos segunda!' }
    const res = await ingestInboundMessage(IG, makeDb())
    expect(res.outOfHoursReply).toBe('sent')
    expect(h.sendCalls).toHaveLength(1)
    expect(h.sendCalls[0]).toMatchObject({ conversationId: h.state.conversations[0].id, text: 'Voltamos segunda!' })
  })

  it('an out-of-hours notice the channel refuses on purpose (window / module / token) is skipped, not failed', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-24T15:00:00Z'), toFake: ['Date'] })
    h.state.accountPreferences = { out_of_hours_enabled: true, out_of_hours_message: 'Voltamos segunda!' }
    h.sendError = new MessagingSkipError('module_off', 'sem módulo')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await ingestInboundMessage(IG, makeDb())
    expect(res.outOfHoursReply).toBe('skipped')
    warn.mockRestore()
  })

  it('feeds the text to the flows engine like any transport (numbered options are matched by text)', async () => {
    await ingestInboundMessage(IG, makeDb())
    expect(dispatchInboundToFlows).toHaveBeenCalledOnce()
    expect(vi.mocked(dispatchInboundToFlows).mock.calls[0][0]).toMatchObject({
      accountId: 'acct-1',
      message: { kind: 'text', text: 'oi', meta_message_id: 'mid.1' },
    })
  })

  it('dispatches the message-triggered automations on an Instagram conversation (part C)', async () => {
    await ingestInboundMessage(IG, makeDb())
    expect(h.automationCalls.map((c) => c.triggerType)).toEqual(
      expect.arrayContaining(['new_contact_created', 'first_inbound_message', 'new_message_received', 'keyword_match']),
    )
  })

  it('flags the AI auto-reply and the triage like the other transports (result hints for the webhook)', async () => {
    const r = await ingestInboundMessage(IG, makeDb())
    expect(r.triageDue).toBe(true)
  })

  it('a store-only part (2nd attachment of a message) is saved but triggers nothing', async () => {
    await ingestInboundMessage(IG, makeDb()) // part 0 did its triggers
    h.automationCalls = []
    vi.mocked(dispatchInboundToFlows).mockClear()
    const r = await ingestInboundMessage({ ...IG, messageId: 'mid.1:1', type: 'image', text: null, storeOnly: true }, makeDb())
    expect(r.ok).toBe(true)
    expect(h.state.messages.map((m) => m.message_id)).toEqual(['mid.1', 'mid.1:1'])
    expect(h.automationCalls).toHaveLength(0)
    expect(dispatchInboundToFlows).not.toHaveBeenCalled()
    expect(h.sendCalls).toHaveLength(0)
    expect(r.aiReplyQueued).toBeUndefined()
  })

  it('does not touch the WhatsApp path: a phone sender still dedupes by phone', async () => {
    await ingestInboundMessage(BASE, makeDb())
    expect(h.state.contacts[0]).toMatchObject({ phone: '5511999990000' })
    expect(h.state.contacts[0]).not.toHaveProperty('instagram_id')
  })
})
