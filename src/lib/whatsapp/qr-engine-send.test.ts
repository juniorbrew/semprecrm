import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  conversationChannel,
  engineSendViaQr,
  mimeFromUrl,
  renderInteractiveAsText,
  renderTemplateBody,
} from './qr-engine-send'

// ------------------------------------------------------------
// Engine-side QR helpers: the text fallbacks for templates and
// interactive prompts, and the gateway send + persistence.
// ------------------------------------------------------------

describe('renderInteractiveAsText', () => {
  it('numbers the options and keeps header/footer', () => {
    expect(
      renderInteractiveAsText({
        headerText: 'Atendimento',
        bodyText: 'Como podemos ajudar?',
        options: ['Vendas', 'Suporte', 'Financeiro'],
        footerText: 'Responda com o número',
      }),
    ).toBe(
      '*Atendimento*\n\nComo podemos ajudar?\n\n1. Vendas\n2. Suporte\n3. Financeiro\n\n_Responda com o número_',
    )
  })

  it('works with body only', () => {
    expect(renderInteractiveAsText({ bodyText: 'Oi', options: [] })).toBe('Oi')
  })
})

describe('renderTemplateBody', () => {
  it('substitutes positional params and blanks missing ones', () => {
    expect(renderTemplateBody('Olá {{1}}, seu pedido {{2}} saiu. {{3}}', ['Ana', '#9'])).toBe(
      'Olá Ana, seu pedido #9 saiu. ',
    )
  })
})

describe('mimeFromUrl', () => {
  it('reads the extension and falls back per kind', () => {
    expect(mimeFromUrl('image', 'https://x/a.png')).toBe('image/png')
    expect(mimeFromUrl('document', 'https://x/a?b=1', 'nota.pdf')).toBe('application/pdf')
    expect(mimeFromUrl('audio', 'https://x/voice')).toBe('audio/ogg')
    expect(mimeFromUrl('document', 'https://x/blob')).toBe('application/octet-stream')
  })
})

function makeDb(state: {
  channel?: string | null
  contact?: { id: string; phone: string } | null
  inserted: Record<string, unknown>[]
  updates: Record<string, unknown>[]
}) {
  function builder(table: string) {
    const ops = { type: 'select' as string, payload: undefined as Record<string, unknown> | undefined }
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: Record<string, unknown>) => ((ops.type = 'insert'), (ops.payload = p), b),
      update: (p: Record<string, unknown>) => ((ops.type = 'update'), (ops.payload = p), b),
      eq: () => b,
      limit: () => b,
      maybeSingle: () => Promise.resolve(resolve()),
      then: (onF: (v: unknown) => unknown) => Promise.resolve(resolve()).then(onF),
    }
    function resolve() {
      if (table === 'conversations' && ops.type === 'select') {
        return { data: state.channel === undefined ? null : { channel: state.channel }, error: null }
      }
      if (table === 'conversations' && ops.type === 'update') {
        state.updates.push(ops.payload ?? {})
        return { data: null, error: null }
      }
      if (table === 'contacts') return { data: state.contact ?? null, error: null }
      if (table === 'messages' && ops.type === 'insert') {
        state.inserted.push(ops.payload ?? {})
        return { data: null, error: null }
      }
      return { data: null, error: null }
    }
    return b
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from: (t: string) => builder(t) } as any
}

describe('conversationChannel', () => {
  it('returns qr / official and defaults to official', async () => {
    expect(await conversationChannel(makeDb({ channel: 'qr', inserted: [], updates: [] }), 'c')).toBe('qr')
    expect(await conversationChannel(makeDb({ channel: 'official', inserted: [], updates: [] }), 'c')).toBe('official')
    expect(await conversationChannel(makeDb({ channel: null, inserted: [], updates: [] }), 'c')).toBe('official')
    expect(await conversationChannel(makeDb({ inserted: [], updates: [] }), 'c')).toBe('official')
  })
})

describe('engineSendViaQr', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    process.env.WA_GATEWAY_URL = 'http://gateway.test:3201'
    process.env.WA_GATEWAY_SECRET = 'shh'
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('sends through the gateway and persists a bot row on the qr channel', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message_id: 'B-1' }), { status: 200 }),
    )
    const state = {
      contact: { id: 'c-1', phone: '+55 (11) 99999-0000' },
      inserted: [] as Record<string, unknown>[],
      updates: [] as Record<string, unknown>[],
    }
    const res = await engineSendViaQr(makeDb(state), {
      accountId: 'acct-1',
      conversationId: 'conv-1',
      contactId: 'c-1',
      text: 'Bem-vindo!',
      contentType: 'text',
    })
    expect(res).toEqual({ whatsapp_message_id: 'B-1' })
    expect(fetchMock.mock.calls[0][0]).toBe('http://gateway.test:3201/sessions/acct-1/send')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ to: '5511999990000', text: 'Bem-vindo!' })
    expect(state.inserted[0]).toMatchObject({
      sender_type: 'bot',
      content_type: 'text',
      content_text: 'Bem-vindo!',
      message_id: 'B-1',
      channel: 'qr',
    })
    expect(state.updates[0]).toMatchObject({ last_message_text: 'Bem-vindo!' })
  })

  it('refuses a contact outside the account', async () => {
    const state = { contact: null, inserted: [], updates: [] }
    await expect(
      engineSendViaQr(makeDb(state), {
        accountId: 'acct-1',
        conversationId: 'conv-1',
        contactId: 'c-x',
        text: 'x',
        contentType: 'text',
      }),
    ).rejects.toThrow(/contact not found/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces a gateway outage as an error without persisting', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const state = { contact: { id: 'c-1', phone: '5511999990000' }, inserted: [], updates: [] }
    await expect(
      engineSendViaQr(makeDb(state), {
        accountId: 'acct-1',
        conversationId: 'conv-1',
        contactId: 'c-1',
        text: 'x',
        contentType: 'text',
      }),
    ).rejects.toThrow(/gateway/i)
    expect(state.inserted).toHaveLength(0)
  })
})
