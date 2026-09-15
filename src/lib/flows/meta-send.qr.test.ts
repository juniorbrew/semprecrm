import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ------------------------------------------------------------
// flows/meta-send + automations/meta-send on a QR conversation:
// every sender must route through the gateway instead of Meta, and
// interactive prompts / templates degrade to plain text.
// ------------------------------------------------------------

const h = vi.hoisted(() => ({
  state: {
    channel: 'qr' as string,
    inserted: [] as Record<string, unknown>[],
    templateBody: 'Olá {{1}}, bem-vindo!' as string | null,
  },
  meta: {
    sendTextMessage: vi.fn(async () => ({ messageId: 'META' })),
    sendTemplateMessage: vi.fn(async () => ({ messageId: 'META' })),
    sendMediaMessage: vi.fn(async () => ({ messageId: 'META' })),
    sendInteractiveButtons: vi.fn(async () => ({ messageId: 'META' })),
    sendInteractiveList: vi.fn(async () => ({ messageId: 'META' })),
  },
}))

vi.mock('@/lib/whatsapp/meta-api', () => h.meta)
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'token' }))

function makeAdmin() {
  function builder(table: string) {
    const ops = { type: 'select' as string, payload: undefined as Record<string, unknown> | undefined }
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: Record<string, unknown>) => ((ops.type = 'insert'), (ops.payload = p), b),
      update: (p: Record<string, unknown>) => ((ops.type = 'update'), (ops.payload = p), b),
      eq: () => b,
      limit: () => b,
      maybeSingle: () => Promise.resolve(resolve()),
      single: () => Promise.resolve(resolve()),
      then: (onF: (v: unknown) => unknown) => Promise.resolve(resolve()).then(onF),
    }
    function resolve() {
      if (table === 'conversations' && ops.type === 'select') {
        return { data: { channel: h.state.channel }, error: null }
      }
      if (table === 'contacts') return { data: { id: 'c-1', phone: '5511999990000' }, error: null }
      if (table === 'whatsapp_config') {
        return { data: { phone_number_id: '123', access_token: 'enc' }, error: null }
      }
      if (table === 'message_templates') {
        return { data: h.state.templateBody ? { body_text: h.state.templateBody } : null, error: null }
      }
      if (table === 'messages' && ops.type === 'insert') {
        h.state.inserted.push(ops.payload ?? {})
        return { data: null, error: null }
      }
      return { data: null, error: null }
    }
    return b
  }
  return { from: (t: string) => builder(t) }
}
vi.mock('./admin-client', () => ({ supabaseAdmin: () => makeAdmin() }))
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => makeAdmin() }))

import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
  engineSendMedia,
  engineSendText,
} from './meta-send'
import { engineSendTemplate as automationSendTemplate } from '@/lib/automations/meta-send'

const fetchMock = vi.fn()
const BASE = { accountId: 'acct-1', userId: 'u-1', conversationId: 'conv-1', contactId: 'c-1' }

function gatewayBody() {
  return JSON.parse(fetchMock.mock.calls[0][1].body)
}

beforeEach(() => {
  h.state.channel = 'qr'
  h.state.inserted = []
  h.state.templateBody = 'Olá {{1}}, bem-vindo!'
  process.env.WA_GATEWAY_URL = 'http://gateway.test:3201'
  process.env.WA_GATEWAY_SECRET = 'shh'
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ message_id: 'B-1' }), { status: 200 }))
})
afterEach(() => vi.unstubAllGlobals())

describe('flows senders on a QR conversation', () => {
  it('text goes through the gateway', async () => {
    const r = await engineSendText({ ...BASE, text: 'oi' })
    expect(r.whatsapp_message_id).toBe('B-1')
    expect(gatewayBody()).toEqual({ to: '5511999990000', text: 'oi' })
    expect(h.meta.sendTextMessage).not.toHaveBeenCalled()
    expect(h.state.inserted[0]).toMatchObject({ channel: 'qr', sender_type: 'bot' })
  })

  it('buttons degrade to a numbered list', async () => {
    await engineSendInteractiveButtons({
      ...BASE,
      bodyText: 'Escolha:',
      buttons: [
        { id: 'a', title: 'Vendas' },
        { id: 'b', title: 'Suporte' },
      ],
      footerText: 'Digite o número',
    })
    expect(gatewayBody().text).toBe('Escolha:\n\n1. Vendas\n2. Suporte\n\n_Digite o número_')
    expect(h.meta.sendInteractiveButtons).not.toHaveBeenCalled()
    expect(h.state.inserted[0]).toMatchObject({ content_type: 'text', channel: 'qr' })
  })

  it('lists flatten every section row', async () => {
    await engineSendInteractiveList({
      ...BASE,
      bodyText: 'Menu',
      buttonLabel: 'Ver',
      sections: [
        { title: 'A', rows: [{ id: '1', title: 'Um' }] },
        { title: 'B', rows: [{ id: '2', title: 'Dois' }, { id: '3', title: 'Três' }] },
      ],
    })
    expect(gatewayBody().text).toBe('Menu\n\n1. Um\n2. Dois\n3. Três')
  })

  it('media carries a mimetype', async () => {
    await engineSendMedia({ ...BASE, kind: 'image', link: 'https://x/a.jpg', caption: 'foto' })
    expect(gatewayBody()).toEqual({
      to: '5511999990000',
      media: { url: 'https://x/a.jpg', mimetype: 'image/jpeg', caption: 'foto' },
    })
    expect(h.state.inserted[0]).toMatchObject({ content_type: 'image', media_url: 'https://x/a.jpg' })
  })

  it('official conversations still go to Meta', async () => {
    h.state.channel = 'official'
    const r = await engineSendText({ ...BASE, text: 'oi' })
    expect(r.whatsapp_message_id).toBe('META')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(h.meta.sendTextMessage).toHaveBeenCalledTimes(1)
  })
})

describe('automation template on a QR conversation', () => {
  it('renders the template body as text', async () => {
    await automationSendTemplate({ ...BASE, templateName: 'welcome', params: ['Ana'] })
    expect(gatewayBody()).toEqual({ to: '5511999990000', text: 'Olá Ana, bem-vindo!' })
    expect(h.meta.sendTemplateMessage).not.toHaveBeenCalled()
    expect(h.state.inserted[0]).toMatchObject({ content_type: 'text', template_name: 'welcome', channel: 'qr' })
  })

  it('fails loudly when the template body is unknown locally', async () => {
    h.state.templateBody = null
    await expect(
      automationSendTemplate({ ...BASE, templateName: 'ghost' }),
    ).rejects.toThrow(/not found locally/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
