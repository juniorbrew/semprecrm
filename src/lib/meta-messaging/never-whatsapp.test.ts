import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ------------------------------------------------------------
// An Instagram / Messenger conversation must never reach a WhatsApp
// transport (Meta Cloud API or the QR gateway): every automatic sender
// refuses it with ChannelNotSupportedError.
// ------------------------------------------------------------

const h = vi.hoisted(() => ({
  channel: 'instagram' as string,
  /** A complete setup: contact id, open window, active connection. */
  complete: false,
  inserted: [] as Record<string, unknown>[],
  meta: {
    sendTextMessage: vi.fn(async () => ({ messageId: 'META' })),
    sendTemplateMessage: vi.fn(async () => ({ messageId: 'META' })),
    sendMediaMessage: vi.fn(async () => ({ messageId: 'META' })),
    sendInteractiveButtons: vi.fn(async () => ({ messageId: 'META' })),
    sendInteractiveList: vi.fn(async () => ({ messageId: 'META' })),
  },
}))

vi.mock('@/lib/plans-server', () => ({ accountIsWritable: async () => true, accountHasModule: async () => true }))
vi.mock('@/lib/whatsapp/meta-api', () => h.meta)
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'token' }))

function makeAdmin() {
  function builder(table: string) {
    let type = 'select'
    let payload: Record<string, unknown> | undefined
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: Record<string, unknown>) => ((type = 'insert'), (payload = p), b),
      update: () => ((type = 'update'), b),
      eq: () => b,
      limit: () => b,
      maybeSingle: () => Promise.resolve(resolve()),
      single: () => Promise.resolve(resolve()),
      then: (onF: (v: unknown) => unknown) => Promise.resolve(resolve()).then(onF),
    }
    function resolve() {
      if (h.complete && table === 'conversations' && type === 'select') {
        return {
          data: {
            id: 'conv-1',
            channel: h.channel,
            last_customer_message_at: new Date().toISOString(),
            contact: { instagram_id: 'IGSID', messenger_id: 'PSID', anonymized_at: null },
          },
          error: null,
        }
      }
      if (h.complete && table === 'meta_messaging_channels') {
        return { data: { id: 'ch-1', account_id: 'acct-1', kind: h.channel, external_id: 'BIZ1', status: 'active', access_token: 'ct' }, error: null }
      }
      if (table === 'conversations' && type === 'select') return { data: { id: 'conv-1', channel: h.channel }, error: null }
      if (table === 'contacts') return { data: { id: 'c-1', phone: '5511999990000' }, error: null }
      if (table === 'whatsapp_config') return { data: { phone_number_id: '123', access_token: 'enc' }, error: null }
      if (table === 'messages' && type === 'insert') h.inserted.push(payload ?? {})
      return { data: null, error: null }
    }
    return b
  }
  return { from: (t: string) => builder(t) }
}
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => makeAdmin() }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => makeAdmin() }))

import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
  engineSendMedia,
  engineSendText as flowSendText,
} from '@/lib/flows/meta-send'
import { engineSendTemplate, engineSendText } from '@/lib/automations/meta-send'
import { assertWhatsAppChannel, ChannelNotSupportedError } from './channels'
import { MessagingSkipError } from './skip'
import { conversationChannel } from '@/lib/whatsapp/qr-engine-send'

const fetchMock = vi.fn()
const BASE = { accountId: 'acct-1', userId: 'u-1', conversationId: 'conv-1', contactId: 'c-1' }

beforeEach(() => {
  h.complete = false
  h.inserted = []
  process.env.WA_GATEWAY_URL = 'http://gateway.test:3201'
  process.env.WA_GATEWAY_SECRET = 'shh'
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  Object.values(h.meta).forEach((m) => m.mockClear())
})
afterEach(() => vi.unstubAllGlobals())

describe('conversationChannel / assertWhatsAppChannel', () => {
  it('returns the real channel instead of mapping everything else to official', async () => {
    for (const channel of ['official', 'qr', 'instagram', 'messenger']) {
      h.channel = channel
      expect(await conversationChannel(makeAdmin() as never, 'conv-1')).toBe(channel)
    }
  })

  it('refuses Instagram / Messenger and passes the WhatsApp channels through', () => {
    expect(() => assertWhatsAppChannel('instagram')).toThrow(ChannelNotSupportedError)
    expect(() => assertWhatsAppChannel('messenger')).toThrow(/messenger/)
    expect(assertWhatsAppChannel('official')).toBe('official')
    expect(assertWhatsAppChannel('qr')).toBe('qr')
  })
})

describe.each(['instagram', 'messenger'])('automatic senders on a %s conversation', (channel) => {
  // Part C: they go to the Instagram / Messenger sender (here refused: this fake conversation has no
  // contact identity), and never to a WhatsApp primitive.
  it('never call Meta WhatsApp, the QR gateway or write a message', async () => {
    h.channel = channel
    const sends = [
      () => engineSendText({ ...BASE, text: 'oi' }),
      () => engineSendTemplate({ ...BASE, templateName: 't', language: 'pt_BR' }),
      () => flowSendText({ ...BASE, text: 'oi' }),
      () => engineSendMedia({ ...BASE, kind: 'image', link: 'https://sb.test/x.jpg' }),
      () => engineSendInteractiveButtons({ ...BASE, bodyText: 'x', buttons: [{ id: 'a', title: 'A' }] }),
      () =>
        engineSendInteractiveList({
          ...BASE,
          bodyText: 'x',
          buttonLabel: 'v',
          sections: [{ title: 'A', rows: [{ id: '1', title: 'Um' }] }],
        }),
    ]
    for (const send of sends) await expect(send()).rejects.toBeInstanceOf(MessagingSkipError)
    expect(fetchMock).not.toHaveBeenCalled()
    for (const m of Object.values(h.meta)) expect(m).not.toHaveBeenCalled()
    expect(h.inserted).toHaveLength(0)
  })
})

describe.each([['instagram', 'graph.instagram.com'], ['messenger', 'graph.facebook.com']])(
  'a complete %s setup (contact id, open window, connection)',
  (channel, host) => {
    it('the automatic senders talk only to that Graph API: never the WhatsApp Cloud API, the QR gateway or a WhatsApp primitive', async () => {
      h.channel = channel
      h.complete = true
      fetchMock.mockImplementation(async () => new Response(JSON.stringify({ recipient_id: 'x', message_id: 'mid.ok' }), { status: 200 }))
      await engineSendText({ ...BASE, text: 'oi' })
      await flowSendText({ ...BASE, text: 'oi' })
      await engineSendInteractiveButtons({ ...BASE, bodyText: 'x', buttons: [{ id: 'a', title: 'A' }] })
      await engineSendInteractiveList({ ...BASE, bodyText: 'x', buttonLabel: 'v', sections: [{ title: 'A', rows: [{ id: '1', title: 'Um' }] }] })
      expect(fetchMock).toHaveBeenCalledTimes(4)
      for (const [url] of fetchMock.mock.calls) {
        const u = new URL(String(url))
        expect(u.hostname).toBe(host)
        expect(u.pathname).toMatch(/^\/v[\d.]+\/BIZ1\/messages$/)
        expect(String(url)).not.toMatch(/gateway\.test|whatsapp|3201/i)
      }
      for (const m of Object.values(h.meta)) expect(m).not.toHaveBeenCalled()
      expect(h.inserted.every((r) => r.channel === channel)).toBe(true)
      expect(h.inserted).toHaveLength(4)
    })
  },
)
