import { beforeEach, describe, expect, it, vi } from 'vitest'

// ------------------------------------------------------------
// Part C: the automatic features reach Instagram / Messenger conversations through the engine
// sender, and nothing on them ever touches a WhatsApp primitive.
// ------------------------------------------------------------

const h = vi.hoisted(() => ({
  channel: 'instagram' as string,
  sends: [] as Record<string, unknown>[],
  wa: {
    sendTextMessage: vi.fn(),
    sendTemplateMessage: vi.fn(),
    sendMediaMessage: vi.fn(),
    sendInteractiveButtons: vi.fn(),
    sendInteractiveList: vi.fn(),
  },
  gateway: vi.fn(),
}))

vi.mock('@/lib/plans-server', () => ({ accountIsWritable: async () => true, accountHasModule: async () => true }))
// A permissive fake: the conversation's channel, a contact with a phone, inserts accepted.
const fakeAdmin = () => ({
  from: (table: string) => {
    const b: Record<string, unknown> = {
      select: () => b,
      insert: () => b,
      update: () => b,
      eq: () => b,
      limit: () => b,
      maybeSingle: async () => ({
        data: table === 'conversations' ? { id: 'conv-1', channel: h.channel } : table === 'contacts' ? { id: 'c-1', phone: '5511999990000' } : null,
        error: null,
      }),
      then: (f: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(f),
    }
    return b
  },
})
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => fakeAdmin() }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => fakeAdmin() }))
vi.mock('@/lib/whatsapp/meta-api', () => h.wa)
vi.mock('@/lib/whatsapp/qr-gateway', async (orig) => ({ ...(await orig<typeof import('@/lib/whatsapp/qr-gateway')>()), sendViaGateway: (...a: unknown[]) => h.gateway(...a) }))
// A full replacement (no importOriginal): the real module pulls in the flows engine, which imports
// flows/meta-send while this factory is still running.
vi.mock('./engine-send', async () => {
  const { MessagingSkipError } = await import('./skip')
  return {
    MessagingSkipError,
    templateSkip: (kind: string) => new MessagingSkipError('template_unsupported', `Modelos de mensagem não existem no ${kind}.`),
    engineSendMessaging: async (_db: unknown, args: Record<string, unknown>) => {
      h.sends.push(args)
      return { whatsapp_message_id: 'mid.x' }
    },
  }
})

import { checkEligibility, type EligibilityInput } from '@/lib/ai/auto-reply'
import { resolveConversationAgent } from '@/lib/ai/auto-reply-runtime'
import { makeFakeDb } from '@/lib/ai/fake-db.test-helper'
import { engineSendTemplate, engineSendText } from '@/lib/automations/meta-send'
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
  engineSendMedia,
  engineSendText as flowSendText,
} from '@/lib/flows/meta-send'
import { MessagingSkipError } from './skip'

const BASE = { accountId: 'acct-1', userId: 'u-1', conversationId: 'conv-1', contactId: 'c-1' }

beforeEach(() => {
  h.channel = 'instagram'
  h.sends = []
  Object.values(h.wa).forEach((m) => m.mockClear())
  h.gateway.mockClear()
})

const noWhatsApp = () => {
  for (const m of Object.values(h.wa)) expect(m).not.toHaveBeenCalled()
  expect(h.gateway).not.toHaveBeenCalled()
}

describe('automations and flows on an Instagram / Messenger conversation', () => {
  it('automation text goes to the engine sender with the engine\'s origin (automation / ai / csat / api)', async () => {
    for (const origin of [undefined, 'ai', 'csat', 'api'] as const) {
      await engineSendText({ ...BASE, text: 'oi', origin, apiRequestId: origin === 'api' ? 'req-1' : undefined })
    }
    expect(h.sends.map((s) => s.origin)).toEqual(['automation', 'ai', 'csat', 'api'])
    expect(h.sends[0]).toMatchObject({ accountId: 'acct-1', conversationId: 'conv-1', contactId: 'c-1', content: { kind: 'text', text: 'oi' } })
    expect(h.sends[3]).toMatchObject({ apiRequestId: 'req-1' })
    noWhatsApp()
  })

  it('a scheduled human message passes the agent and no bot origin', async () => {
    await engineSendText({ ...BASE, text: 'oi', agentId: 'agent-1' })
    expect(h.sends[0]).toMatchObject({ agentId: 'agent-1', origin: undefined })
  })

  it('a template step is a SKIP with a reason (these channels have no templates)', async () => {
    const e = await engineSendTemplate({ ...BASE, templateName: 'boas_vindas', language: 'pt_BR' }).catch((x) => x)
    expect(e).toBeInstanceOf(MessagingSkipError)
    expect(e.code).toBe('template_unsupported')
    expect(h.sends).toHaveLength(0)
    noWhatsApp()
  })

  it('flow text, media and interactive prompts (as numbered text) go to the engine sender with origin flow', async () => {
    await flowSendText({ ...BASE, text: 'Olá!' })
    await engineSendMedia({ ...BASE, kind: 'image', link: 'https://x/chat-media/a.png', caption: 'legenda' })
    await engineSendInteractiveButtons({
      ...BASE,
      bodyText: 'Escolha:',
      buttons: [
        { id: 'a', title: 'Vendas' },
        { id: 'b', title: 'Suporte' },
      ],
      footerText: 'Digite o número',
    })
    await engineSendInteractiveList({
      ...BASE,
      bodyText: 'Menu',
      buttonLabel: 'Ver',
      sections: [{ title: 'S', rows: [{ id: '1', title: 'Um' }, { id: '2', title: 'Dois' }] }],
    })
    expect(h.sends.map((s) => s.origin)).toEqual(['flow', 'flow', 'flow', 'flow'])
    expect(h.sends[0].content).toEqual({ kind: 'text', text: 'Olá!' })
    expect(h.sends[1].content).toMatchObject({ kind: 'media', mediaType: 'image', caption: 'legenda' })
    expect((h.sends[2].content as { text: string }).text).toBe('Escolha:\n\n1. Vendas\n2. Suporte\n\n_Digite o número_')
    expect((h.sends[3].content as { text: string }).text).toBe('Menu\n\n1. Um\n2. Dois')
    noWhatsApp()
  })

  it('WhatsApp channels never reach the Instagram / Messenger sender', async () => {
    h.channel = 'qr'
    h.gateway.mockResolvedValue({ message_id: 'B-1' })
    await engineSendText({ ...BASE, text: 'oi' })
    await flowSendText({ ...BASE, text: 'oi' })
    expect(h.sends).toHaveLength(0)
    expect(h.gateway).toHaveBeenCalledTimes(2)
  })
})

describe('AI auto-reply on Instagram / Messenger', () => {
  const NOW = new Date('2026-10-31T12:00:00Z')
  const agent = { enabled: true, mode: 'auto', paused_at: null, business_hours: { enabled: false } as never, ignore_groups: true, max_auto_replies_per_day: 20 }
  const input = (channel: string | null, last: string | null): EligibilityInput =>
    ({ now: NOW, agent, contact: null, conversation: { status: 'open', archived_at: null, ai_paused_until: null, channel, last_customer_message_at: last } }) as EligibilityInput
  const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString()

  it('is eligible inside the 24 h window and stops with meta_window_closed outside it', () => {
    for (const channel of ['instagram', 'messenger']) {
      expect(checkEligibility(input(channel, hoursAgo(2)))).toEqual({ ok: true })
      expect(checkEligibility(input(channel, hoursAgo(25)))).toMatchObject({ ok: false, reason: 'meta_window_closed' })
      expect(checkEligibility(input(channel, null))).toMatchObject({ ok: false, reason: 'meta_window_closed' })
    }
    // QR still has no window
    expect(checkEligibility(input('qr', null))).toEqual({ ok: true })
  })

  const agents = [
    { id: 'default', account_id: 'acct-1', enabled: true, mode: 'auto', is_default: true, channels: [], tag_ids: [], created_at: '1' },
    { id: 'ig-only', account_id: 'acct-1', enabled: true, mode: 'auto', is_default: false, channels: ['instagram'], tag_ids: [], created_at: '2' },
  ]

  it('an agent whose channels include instagram answers there; the default agent (channels empty = not channel-specific) answers everywhere else', async () => {
    const db = makeFakeDb({ ai_agents: agents, contact_tags: [] }) as never
    expect((await resolveConversationAgent(db, 'acct-1', 'c-1', 'instagram'))?.id).toBe('ig-only')
    expect((await resolveConversationAgent(db, 'acct-1', 'c-1', 'messenger'))?.id).toBe('default')
    expect((await resolveConversationAgent(db, 'acct-1', 'c-1', 'official'))?.id).toBe('default')
  })

  it('the agent form accepts the new channels and still refuses unknown ones', async () => {
    const { parseAgentInput } = await import('@/lib/ai/agents')
    const ok = parseAgentInput({ name: 'x', instructions: 'y', channels: ['instagram', 'messenger', 'qr'] }, false)
    expect(ok.ok).toBe(true)
    const bad = parseAgentInput({ name: 'x', instructions: 'y', channels: ['telegram'] }, false)
    expect(bad.ok).toBe(false)
  })
})
