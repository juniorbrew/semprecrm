import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ------------------------------------------------------------
// POST /api/whatsapp/send — channel branch (migration 026).
//
//   conversation.channel === 'qr'  → gateway /send, messages.channel='qr'
//   conversation.channel official  → Meta (unchanged)
//   template on a QR conversation  → 400
//   gateway down / env unset       → 503
// ------------------------------------------------------------

const h = vi.hoisted(() => ({
  state: {
    conversation: {
      id: 'conv-1',
      account_id: 'acct-1',
      channel: 'qr',
      contact: { id: 'c-1', phone: '+55 11 99999-0000' },
    } as Record<string, unknown>,
    inserted: [] as Record<string, unknown>[],
  },
  meta: {
    sendTextMessage: vi.fn(async () => ({ messageId: 'wamid.META' })),
    sendTemplateMessage: vi.fn(async () => ({ messageId: 'wamid.TPL' })),
    sendMediaMessage: vi.fn(async () => ({ messageId: 'wamid.MEDIA' })),
  },
}))

vi.mock('@/lib/whatsapp/meta-api', () => h.meta)
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: () => 'token',
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
  RATE_LIMITS: { send: {} },
}))
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => {
      const b: Record<string, unknown> = {
        update: () => b,
        eq: () => b,
        then: (onF: (v: unknown) => unknown) =>
          Promise.resolve({ data: null, error: null }).then(onF),
      }
      return b
    },
  }),
}))

function builder(table: string) {
  const ops = { type: 'select' as string, payload: undefined as Record<string, unknown> | undefined }
  const b: Record<string, unknown> = {
    select: () => b,
    insert: (p: Record<string, unknown>) => ((ops.type = 'insert'), (ops.payload = p), b),
    update: (p: Record<string, unknown>) => ((ops.type = 'update'), (ops.payload = p), b),
    eq: () => b,
    maybeSingle: () => Promise.resolve(resolve()),
    single: () => Promise.resolve(resolve()),
    then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(onF, onR),
  }
  function resolve() {
    if (table === 'profiles') return { data: { account_id: 'acct-1' }, error: null }
    if (table === 'conversations') {
      if (ops.type === 'update') return { data: null, error: null }
      return { data: h.state.conversation, error: null }
    }
    if (table === 'whatsapp_config') {
      return { data: { id: 'cfg', phone_number_id: '123', access_token: 'enc' }, error: null }
    }
    if (table === 'messages' && ops.type === 'insert') {
      const row = { id: `m-${h.state.inserted.length + 1}`, ...ops.payload }
      h.state.inserted.push(row)
      return { data: row, error: null }
    }
    if (table === 'message_templates') return { data: null, error: null }
    return { data: null, error: null }
  }
  return b
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from: (table: string) => builder(table),
  }),
}))

import { POST } from './route'

const fetchMock = vi.fn()

function request(body: unknown) {
  return new Request('http://localhost/api/whatsapp/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function gatewayOk(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  h.state.conversation = {
    id: 'conv-1',
    account_id: 'acct-1',
    channel: 'qr',
    contact: { id: 'c-1', phone: '+55 11 99999-0000' },
  }
  h.state.inserted = []
  process.env.WA_GATEWAY_URL = 'http://gateway.test:3201'
  process.env.WA_GATEWAY_SECRET = 'shh'
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})

afterEach(() => vi.unstubAllGlobals())

describe('POST /api/whatsapp/send — QR conversations', () => {
  it('sends text through the gateway and stores channel=qr with the gateway id', async () => {
    fetchMock.mockResolvedValueOnce(gatewayOk({ message_id: 'BAILEYS-1' }))

    const res = await POST(request({ conversation_id: 'conv-1', message_type: 'text', content_text: 'oi' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ success: true, whatsapp_message_id: 'BAILEYS-1', channel: 'qr' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://gateway.test:3201/sessions/acct-1/send')
    expect(init.headers['x-gateway-secret']).toBe('shh')
    expect(JSON.parse(init.body)).toEqual({ to: '5511999990000', text: 'oi' })

    expect(h.state.inserted[0]).toMatchObject({
      sender_type: 'agent',
      content_type: 'text',
      content_text: 'oi',
      message_id: 'BAILEYS-1',
      channel: 'qr',
      status: 'sent',
    })
    expect(h.meta.sendTextMessage).not.toHaveBeenCalled()
  })

  it('sends media with a mimetype and caption', async () => {
    fetchMock.mockResolvedValueOnce(gatewayOk({ message_id: 'B-2' }))
    const res = await POST(
      request({
        conversation_id: 'conv-1',
        message_type: 'image',
        media_url: 'https://x/chat-media/foto.png',
        content_text: 'legenda',
      }),
    )
    expect(res.status).toBe(200)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      to: '5511999990000',
      media: { url: 'https://x/chat-media/foto.png', mimetype: 'image/png', caption: 'legenda' },
    })
    expect(h.state.inserted[0]).toMatchObject({ content_type: 'image', channel: 'qr' })
  })

  it('400 for a template on a QR conversation', async () => {
    const res = await POST(
      request({ conversation_id: 'conv-1', message_type: 'template', template_name: 'hello' }),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('template_requires_official')
    expect(body.error).toMatch(/API oficial/)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(h.meta.sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('503 when the gateway is down, nothing stored', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const res = await POST(request({ conversation_id: 'conv-1', message_type: 'text', content_text: 'oi' }))
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ code: 'gateway_unreachable' })
    expect(h.state.inserted).toHaveLength(0)
  })

  it('409 not_connected surfaces the pt-BR reconnect toast', async () => {
    fetchMock.mockResolvedValueOnce(
      gatewayOk({ error: 'not_connected', message: 'session not connected' }, 409),
    )
    const res = await POST(request({ conversation_id: 'conv-1', message_type: 'text', content_text: 'oi' }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: 'WhatsApp desconectado. Reconecte em Configurações.',
      code: 'not_connected',
    })
    expect(h.state.inserted).toHaveLength(0)
  })

  it('422 not_on_whatsapp surfaces the pt-BR toast', async () => {
    fetchMock.mockResolvedValueOnce(
      gatewayOk({ error: 'not_on_whatsapp', message: 'number is not on WhatsApp' }, 422),
    )
    const res = await POST(request({ conversation_id: 'conv-1', message_type: 'text', content_text: 'oi' }))
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: 'Este número não está no WhatsApp.' })
  })

  it('502 send_failed passes through', async () => {
    fetchMock.mockResolvedValueOnce(gatewayOk({ error: 'send_failed', message: 'boom' }, 502))
    const res = await POST(request({ conversation_id: 'conv-1', message_type: 'text', content_text: 'oi' }))
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ code: 'send_failed' })
  })

  it('503 gateway_unconfigured when env is unset', async () => {
    delete process.env.WA_GATEWAY_SECRET
    const res = await POST(request({ conversation_id: 'conv-1', message_type: 'text', content_text: 'oi' }))
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ code: 'gateway_unconfigured' })
  })
})

describe('POST /api/whatsapp/send — official conversations (unchanged)', () => {
  it('goes to Meta and does not touch the gateway', async () => {
    h.state.conversation.channel = 'official'
    const res = await POST(request({ conversation_id: 'conv-1', message_type: 'text', content_text: 'oi' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ whatsapp_message_id: 'wamid.META' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(h.meta.sendTextMessage).toHaveBeenCalledTimes(1)
    expect(h.state.inserted[0]).toMatchObject({ message_id: 'wamid.META' })
    expect(h.state.inserted[0]).not.toHaveProperty('channel')
  })

  it('treats a row without channel (pre-026) as official', async () => {
    delete h.state.conversation.channel
    const res = await POST(request({ conversation_id: 'conv-1', message_type: 'text', content_text: 'oi' }))
    expect(res.status).toBe(200)
    expect(h.meta.sendTextMessage).toHaveBeenCalledTimes(1)
  })
})
