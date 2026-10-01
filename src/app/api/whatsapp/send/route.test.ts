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
    // Local message_templates rows (wacrm #483 persistence tests).
    templates: [] as Record<string, unknown>[],
    convUpdates: [] as Record<string, unknown>[],
    // Papel de quem chama (requireRole lê do profile). Enviar exige 'agent'.
    role: 'agent' as string,
    /** The contact's live conversation other than this one (migration 060). */
    activeOther: null as Record<string, unknown> | null,
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
    from: (table: string) => {
      // The WhatsApp token is read with the service role (migration 076).
      if (table === 'whatsapp_config') return builder(table)
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
  const ops = {
    type: 'select' as string,
    payload: undefined as Record<string, unknown> | undefined,
    neq: false,
  }
  const b: Record<string, unknown> = {
    select: () => b,
    neq: () => ((ops.neq = true), b),
    order: () => b,
    limit: () => b,
    insert: (p: Record<string, unknown>) => ((ops.type = 'insert'), (ops.payload = p), b),
    update: (p: Record<string, unknown>) => ((ops.type = 'update'), (ops.payload = p), b),
    eq: () => b,
    maybeSingle: () => Promise.resolve(resolve()),
    single: () => Promise.resolve(resolve()),
    then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(onF, onR),
  }
  function resolve() {
    if (table === 'profiles') {
      return {
        data: { account_id: 'acct-1', account_role: h.state.role, account: { id: 'acct-1', name: 'Acme' } },
        error: null,
      }
    }
    if (table === 'conversations') {
      if (ops.type === 'update') {
        h.state.convUpdates.push(ops.payload ?? {})
        return { data: null, error: null }
      }
      if (ops.neq) return { data: h.state.activeOther ? [h.state.activeOther] : [], error: null }
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
    if (table === 'message_templates') return { data: h.state.templates, error: null }
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
  h.state.templates = []
  h.state.convUpdates = []
  h.state.role = 'agent'
  h.state.activeOther = null
  process.env.WA_GATEWAY_URL = 'http://gateway.test:3201'
  process.env.WA_GATEWAY_SECRET = 'shh'
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://sb.test')
  vi.stubEnv('SUPABASE_INTERNAL_URL', 'http://kong.internal:8000')
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  h.meta.sendMediaMessage.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

const OWN_MEDIA = 'https://sb.test/storage/v1/object/public/chat-media/account-acct-1/1-foto.png'

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
        media_url: OWN_MEDIA,
        content_text: 'legenda',
      }),
    )
    expect(res.status).toBe(200)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      to: '5511999990000',
      media: {
        // rebuilt on the internal storage route the gateway allowlists
        url: 'http://kong.internal:8000/storage/v1/object/public/chat-media/account-acct-1/1-foto.png',
        mimetype: 'image/png',
        caption: 'legenda',
      },
    })
    // the row keeps the stored form
    expect(h.state.inserted[0]).toMatchObject({ content_type: 'image', channel: 'qr', media_url: OWN_MEDIA })
  })

  it.each([
    './.env',
    '//etc/passwd',
    '/etc/passwd',
    'file:///etc/passwd',
    'data:image/png;base64,AAAA',
    'http://127.0.0.1:3201/health',
    'http://169.254.169.254/latest/meta-data/',
    'https://evil.example/foto.png',
    'https://sb.test@evil.example/storage/v1/object/public/chat-media/account-acct-1/x.png',
    'https://sb.test/storage/v1/object/public/chat-media/account-acct-1/../../../rest/v1/x',
    'https://sb.test/storage/v1/object/public/chat-media/account-OUTRA/1-foto.png',
  ])('400 for media_url %s, gateway never called, nothing stored', async (media_url) => {
    const res = await POST(request({ conversation_id: 'conv-1', message_type: 'document', media_url }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'invalid_media_url' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(h.meta.sendMediaMessage).not.toHaveBeenCalled()
    expect(h.state.inserted).toHaveLength(0)
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

  it('media link sent to Meta is rebuilt from the validated object path', async () => {
    h.state.conversation.channel = 'official'
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '/supabase')
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://www.semprecrm.com.br')
    const stored = '/supabase/storage/v1/object/public/chat-media/account-acct-1/1-a.pdf'
    const res = await POST(request({ conversation_id: 'conv-1', message_type: 'document', media_url: stored }))
    expect(res.status).toBe(200)
    expect(h.meta.sendMediaMessage).toHaveBeenCalledWith(
      expect.objectContaining({ link: `https://www.semprecrm.com.br${stored}` }),
    )
  })

  it('backslash traversal is refused on the Meta channel too', async () => {
    h.state.conversation.channel = 'official'
    const res = await POST(
      request({
        conversation_id: 'conv-1',
        message_type: 'document',
        media_url: 'https://sb.test/storage/v1/object/public/chat-media/account-acct-1/a\\..\\..\\..\\x',
      }),
    )
    expect(res.status).toBe(400)
    expect(h.meta.sendMediaMessage).not.toHaveBeenCalled()
  })

  it('treats a row without channel (pre-026) as official', async () => {
    delete h.state.conversation.channel
    const res = await POST(request({ conversation_id: 'conv-1', message_type: 'text', content_text: 'oi' }))
    expect(res.status).toBe(200)
    expect(h.meta.sendTextMessage).toHaveBeenCalledTimes(1)
  })
})

// Portado do wacrm (GHSA-8fv4-vgcc-p8vm, #448): enviar chega ao cliente ANTES de
// qualquer gravação, então o papel é conferido na rota.
describe('POST /api/whatsapp/send — papel mínimo', () => {
  it('visualizador é recusado (403) e nada sai pelo gateway nem pela Meta', async () => {
    h.state.role = 'viewer'
    const res = await POST(request({ conversation_id: 'conv-1', message_type: 'text', content_text: 'oi' }))
    expect(res.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(h.meta.sendTextMessage).not.toHaveBeenCalled()
    expect(h.state.inserted).toHaveLength(0)
  })

  it('atendente envia normalmente', async () => {
    h.state.role = 'agent'
    fetchMock.mockResolvedValueOnce(gatewayOk({ message_id: 'BAILEYS-1' }))
    const res = await POST(request({ conversation_id: 'conv-1', message_type: 'text', content_text: 'oi' }))
    expect(res.status).toBeLessThan(300)
  })
})

// wacrm #483 — template sends persist the substituted body so the inbox
// bubble and the conversation preview are never empty.
describe('POST /api/whatsapp/send — template persistence', () => {
  const TEMPLATE = {
    id: 'tpl-1',
    user_id: 'user-1',
    account_id: 'acct-1',
    name: 'pedido_enviado',
    language: 'pt_BR',
    category: 'UTILITY',
    status: 'APPROVED',
    body_text: 'Olá {{1}}, seu pedido {{2}} saiu para entrega.',
  }

  beforeEach(() => {
    h.state.conversation.channel = 'official'
    h.meta.sendTemplateMessage.mockClear()
  })

  it('stores the substituted body when the caller sends no text', async () => {
    h.state.templates = [TEMPLATE]
    const res = await POST(
      request({
        conversation_id: 'conv-1',
        message_type: 'template',
        template_name: 'pedido_enviado',
        template_language: 'pt_BR',
        template_params: ['Maria', '#42'],
      }),
    )
    expect(res.status).toBe(200)
    expect(h.state.inserted[0]).toMatchObject({
      content_type: 'template',
      content_text: 'Olá Maria, seu pedido #42 saiu para entrega.',
      template_name: 'pedido_enviado',
    })
    expect(h.state.convUpdates.at(-1)).toMatchObject({
      last_message_text: 'Olá Maria, seu pedido #42 saiu para entrega.',
    })
  })

  it('reads body values from the structured params shape too', async () => {
    h.state.templates = [TEMPLATE]
    await POST(
      request({
        conversation_id: 'conv-1',
        message_type: 'template',
        template_name: 'pedido_enviado',
        template_language: 'pt_BR',
        template_message_params: { body: ['João', '#7'] },
      }),
    )
    expect(h.state.inserted[0]).toMatchObject({
      content_text: 'Olá João, seu pedido #7 saiu para entrega.',
    })
  })

  it("keeps the composer's pre-rendered text", async () => {
    h.state.templates = [TEMPLATE]
    await POST(
      request({
        conversation_id: 'conv-1',
        message_type: 'template',
        template_name: 'pedido_enviado',
        template_language: 'pt_BR',
        template_params: ['Maria', '#42'],
        content_text: 'texto do compositor',
      }),
    )
    expect(h.state.inserted[0]).toMatchObject({ content_text: 'texto do compositor' })
  })

  it("sends the local row's language when the caller names none", async () => {
    h.state.templates = [{ ...TEMPLATE, language: 'en' }]
    await POST(
      request({
        conversation_id: 'conv-1',
        message_type: 'template',
        template_name: 'pedido_enviado',
        template_params: ['Ann', '#1'],
      }),
    )
    expect(h.meta.sendTemplateMessage).toHaveBeenCalledWith(
      expect.objectContaining({ language: 'en' }),
    )
    expect(h.state.inserted[0]).toMatchObject({
      content_text: 'Olá Ann, seu pedido #1 saiu para entrega.',
    })
  })

  it('refuses a webhook stub template (needs_sync) with 409 and sends nothing', async () => {
    h.state.templates = [{ ...TEMPLATE, body_text: '', needs_sync: true }]
    const res = await POST(
      request({
        conversation_id: 'conv-1',
        message_type: 'template',
        template_name: 'pedido_enviado',
        template_language: 'pt_BR',
      }),
    )
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'template_needs_sync' })
    expect(h.meta.sendTemplateMessage).not.toHaveBeenCalled()
    expect(h.state.inserted).toHaveLength(0)
  })

  it('leaves content_text null when there is no local template row', async () => {
    await POST(
      request({
        conversation_id: 'conv-1',
        message_type: 'template',
        template_name: 'desconhecido',
        template_language: 'pt_BR',
      }),
    )
    expect(h.state.inserted[0]).toMatchObject({ content_text: null })
    expect(h.state.convUpdates.at(-1)).toMatchObject({ last_message_text: '[template]' })
  })
})

describe('POST /api/whatsapp/send — resolved conversation (migration 060)', () => {
  it('409 with the current conversation when the contact has a newer live one; nothing sent', async () => {
    h.state.conversation = { ...h.state.conversation, status: 'closed', contact_id: 'c-1' }
    h.state.activeOther = { id: 'conv-2', status: 'open' }
    const res = await POST(request({ conversation_id: 'conv-1', message_type: 'text', content_text: 'oi' }))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body).toMatchObject({ code: 'newer_conversation', current_conversation_id: 'conv-2' })
    expect(body.error).toMatch(/conversa em andamento/)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(h.state.inserted).toHaveLength(0)
  })

  it('a resolved conversation with no newer one still sends as before', async () => {
    h.state.conversation = { ...h.state.conversation, status: 'closed', contact_id: 'c-1' }
    fetchMock.mockResolvedValueOnce(gatewayOk({ message_id: 'B-9' }))
    const res = await POST(request({ conversation_id: 'conv-1', message_type: 'text', content_text: 'oi' }))
    expect(res.status).toBe(200)
    expect(h.state.inserted).toHaveLength(1)
  })
})
