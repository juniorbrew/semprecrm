import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ------------------------------------------------------------
// Public API send on Instagram / Messenger (part C): `to` is the customer's id, the contact must have
// an open conversation on that channel, the 24 h window is checked and every refusal has its own code.
// ------------------------------------------------------------

type Row = Record<string, unknown>
const h = vi.hoisted(() => ({
  modules: new Set<string>(['channel_instagram', 'channel_messenger']),
  blocked: false as false | { reason: string },
  contact: null as Row | null,
  conversations: [] as Row[],
  sendError: null as Error | null,
  sends: [] as Record<string, unknown>[],
  onBefore: 0,
}))

vi.mock('@/lib/plans-server', () => ({
  loadAccountEntitlements: async () => ({ blocked: h.blocked }),
  accountHasModule: async (_db: unknown, _acc: string, module: string) => h.modules.has(module),
}))
vi.mock('@/lib/automations/meta-send', () => ({ engineSendText: vi.fn() }))
vi.mock('@/lib/meta-messaging/engine-send', async (orig) => ({
  ...(await orig<typeof import('@/lib/meta-messaging/engine-send')>()),
  engineSendMessaging: async (_db: unknown, args: Record<string, unknown>) => {
    h.sends.push(args)
    if (h.sendError) throw h.sendError
    return { whatsapp_message_id: 'mid.api' }
  },
}))
vi.mock('@/lib/whatsapp/inbound', () => ({
  findOrCreateContact: vi.fn(),
  findOrCreateConversation: vi.fn(),
  listContactConversations: async () => h.conversations,
  pickActiveConversation: (rows: Row[]) => rows.find((r) => r.status !== 'closed') ?? null,
}))

import { MessagingSkipError } from '@/lib/meta-messaging/skip'
import { ApiSendError, sendTextViaApi } from './send-message'

const db = {
  from: (table: string) => {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      is: () => b,
      maybeSingle: async () => ({
        data: table === 'accounts' ? { owner_user_id: 'u1' } : table === 'contacts' ? h.contact : { id: 'msg-1' },
        error: null,
      }),
    }
    return b
  },
} as unknown as SupabaseClient

const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString()
const call = (over: Record<string, unknown> = {}) =>
  sendTextViaApi(db, {
    accountId: 'acct-1',
    to: 'IGSID-1',
    text: 'olá',
    channel: 'instagram',
    claimId: 'claim-1',
    onBeforeSend: async () => void h.onBefore++,
    ...over,
  })
const fails = (p: Promise<unknown>) => p.then(() => null, (e) => e as ApiSendError)

beforeEach(() => {
  h.modules = new Set(['channel_instagram', 'channel_messenger'])
  h.blocked = false
  h.contact = { id: 'c-1', opted_out_at: null, anonymized_at: null }
  h.conversations = [{ id: 'conv-1', status: 'open', channel: 'instagram', last_customer_message_at: hoursAgo(1) }]
  h.sendError = null
  h.sends = []
  h.onBefore = 0
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('sendTextViaApi on Instagram / Messenger', () => {
  it('sends through the engine sender with origin api and the idempotency claim, and reports the channel', async () => {
    const r = await call()
    expect(r).toMatchObject({ conversation_id: 'conv-1', contact_id: 'c-1', channel: 'instagram', whatsapp_message_id: 'mid.api', message_id: 'msg-1' })
    expect(h.sends[0]).toMatchObject({ accountId: 'acct-1', conversationId: 'conv-1', contactId: 'c-1', origin: 'api', apiRequestId: 'claim-1', content: { kind: 'text', text: 'olá' } })
    expect(h.onBefore).toBe(1)
  })

  it('outside the 24 h window: 409 window_closed, nothing sent', async () => {
    h.conversations = [{ id: 'conv-1', status: 'open', channel: 'instagram', last_customer_message_at: hoursAgo(25) }]
    const e = await fails(call())
    expect(e).toMatchObject({ status: 409, code: 'window_closed' })
    expect(e?.message).toMatch(/24-hour Instagram window/)
    expect(h.sends).toHaveLength(0)
    expect(h.onBefore).toBe(0)
  })

  it('no open conversation on that channel (or only a WhatsApp one): 409 no_open_conversation', async () => {
    h.conversations = []
    expect(await fails(call())).toMatchObject({ status: 409, code: 'no_open_conversation' })
    h.conversations = [{ id: 'conv-w', status: 'open', channel: 'qr', last_customer_message_at: hoursAgo(1) }]
    expect(await fails(call())).toMatchObject({ status: 409, code: 'no_open_conversation' })
    expect(h.sends).toHaveLength(0)
  })

  it('unknown id 404, opted out 403, module off 403, read-only 402, bad id 400', async () => {
    h.contact = null
    expect(await fails(call())).toMatchObject({ status: 404, code: 'contact_not_found' })
    h.contact = { id: 'c-1', opted_out_at: '2026-01-01', anonymized_at: null }
    expect(await fails(call())).toMatchObject({ status: 403, code: 'contact_opted_out' })
    h.contact = { id: 'c-1', opted_out_at: null, anonymized_at: null }
    h.modules = new Set(['channel_messenger'])
    expect(await fails(call())).toMatchObject({ status: 403, code: 'module_not_included' })
    h.modules = new Set(['channel_instagram'])
    h.blocked = { reason: 'trial_expired' }
    expect(await fails(call())).toMatchObject({ status: 402, code: 'read_only' })
    h.blocked = false
    expect(await fails(call({ to: 'has spaces!' }))).toMatchObject({ status: 400, code: 'invalid_recipient' })
    expect(await fails(call({ to: 42 }))).toMatchObject({ status: 400, code: 'invalid_recipient' })
    expect(h.sends).toHaveLength(0)
  })

  it('refusals by the sender map to their own status and say nothing was sent', async () => {
    const cases: [ConstructorParameters<typeof MessagingSkipError>[0], number][] = [
      ['window_closed', 409],
      ['channel_not_connected', 422],
      ['channel_expired', 422],
      ['text_too_long', 400],
    ]
    for (const [code, status] of cases) {
      h.sendError = new MessagingSkipError(code, 'motivo')
      const e = await fails(call())
      expect(e, code).toMatchObject({ status, code })
      expect(e?.message).toMatch(/Nothing was sent/)
    }
  })

  it('a transient failure is "unknown" (it may have been delivered) and a recording failure is "do not resend"', async () => {
    h.sendError = new Error('O Instagram não aceitou a mensagem. Tente novamente em instantes.')
    expect(await fails(call())).toMatchObject({ status: 502, code: 'send_unknown', maybeSent: true })
    h.sendError = new Error('sent to Meta but DB insert failed: XX000')
    expect(await fails(call())).toMatchObject({ code: 'send_unconfirmed', maybeSent: true })
  })

  it('Messenger uses messenger_id and its own module', async () => {
    h.conversations = [{ id: 'conv-m', status: 'open', channel: 'messenger', last_customer_message_at: hoursAgo(2) }]
    expect((await call({ channel: 'messenger', to: 'PSID-1' })).channel).toBe('messenger')
    h.modules = new Set(['channel_instagram'])
    expect(await fails(call({ channel: 'messenger', to: 'PSID-1' }))).toMatchObject({ code: 'module_not_included' })
  })

  it('an unknown channel is still refused with the full list', async () => {
    const e = await fails(call({ channel: 'telegram', to: '5511999990000' }))
    expect(e).toMatchObject({ status: 400, code: 'invalid_channel' })
    expect(e?.message).toMatch(/instagram/)
  })
})
