import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ------------------------------------------------------------
// The automatic sender for Instagram / Messenger (part C): window, module, connection,
// limits, interactive-as-text, token errors and what gets persisted. Meta is a stubbed fetch.
// ------------------------------------------------------------

type Row = Record<string, unknown>
const h = vi.hoisted(() => ({
  conversation: null as Row | null,
  connection: null as Row | null,
  modules: new Set<string>(),
  inserted: [] as Row[],
  insertError: null as { code: string; message?: string } | null,
  convUpdates: [] as Row[],
  expired: [] as Row[],
  claim: vi.fn(async () => ({ id: 'claimed' }) as { id: string } | null),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => `plain-${v}` }))
vi.mock('@/lib/plans-server', () => ({ accountHasModule: async (_d: unknown, _a: string, m: string) => h.modules.has(m) }))
vi.mock('@/lib/whatsapp/phone-echo', () => ({ claimEchoedRow: () => h.claim() }))

import { engineSendMessaging, MessagingSkipError, templateSkip, type EngineMessagingSendInput } from './engine-send'
import { renderInteractiveAsText } from '@/lib/whatsapp/qr-engine-send'

const NOW = Date.parse('2026-10-31T12:00:00Z')
const hoursAgo = (n: number) => new Date(NOW - n * 3_600_000).toISOString()

const db = {
  from(table: string) {
    let update: Row | null = null
    let insert: Row | null = null
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      update: (p: Row) => ((update = p), b),
      insert: (p: Row) => ((insert = p), b),
      maybeSingle: async () => ({ data: table === 'conversations' ? h.conversation : h.connection, error: null }),
      then: (f: (v: unknown) => unknown) => {
        if (insert && table === 'messages') h.inserted.push(insert)
        if (update && table === 'conversations') h.convUpdates.push(update)
        if (update && table === 'meta_messaging_channels') h.expired.push(update)
        return Promise.resolve({ error: insert && h.insertError ? h.insertError : null }).then(f)
      },
    }
    return b
  },
} as never

const conv = (over: Row = {}) => ({
  id: 'conv-1',
  channel: 'instagram',
  last_customer_message_at: hoursAgo(1),
  contact: { instagram_id: 'IGSID', messenger_id: 'PSID', anonymized_at: null },
  ...over,
})
const input = (over: Partial<EngineMessagingSendInput> = {}): EngineMessagingSendInput => ({
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'c-1',
  content: { kind: 'text', text: 'olá' },
  origin: 'automation',
  now: NOW,
  ...over,
})

const fetchMock = vi.fn()
const ok = (id: string) => new Response(JSON.stringify({ recipient_id: 'x', message_id: id }), { status: 200 })
const skipCode = (p: Promise<unknown>) => p.then(() => 'sent', (e) => (e instanceof MessagingSkipError ? e.code : `error:${(e as Error).message}`))

beforeEach(() => {
  h.conversation = conv()
  h.connection = { id: 'ch-1', account_id: 'acct-1', kind: 'instagram', external_id: 'IG1', status: 'active', access_token: 'ct' }
  h.modules = new Set(['channel_instagram', 'channel_messenger'])
  h.inserted = []
  h.convUpdates = []
  h.expired = []
  h.insertError = null
  h.claim.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => vi.unstubAllGlobals())

describe('engineSendMessaging', () => {
  it('sends text inside the window and persists a bot row with the engine origin, then updates the preview', async () => {
    fetchMock.mockResolvedValueOnce(ok('mid.1'))
    const r = await engineSendMessaging(db, input({ origin: 'flow' }))
    expect(r.whatsapp_message_id).toBe('mid.1')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/^https:\/\/graph\.instagram\.com\/v[\d.]+\/IG1\/messages$/)
    expect((init as RequestInit & { headers: Record<string, string> }).headers.Authorization).toBe('Bearer plain-ct')
    expect(JSON.parse(init.body)).toMatchObject({ recipient: { id: 'IGSID' }, message: { text: 'olá' } })
    expect(h.inserted).toEqual([
      expect.objectContaining({ conversation_id: 'conv-1', sender_type: 'bot', origin: 'flow', content_type: 'text', content_text: 'olá', message_id: 'mid.1', channel: 'instagram', status: 'sent' }),
    ])
    expect(h.inserted[0]).not.toHaveProperty('sender_id')
    expect(h.convUpdates[0]).toMatchObject({ last_message_text: 'olá' })
  })

  it('Messenger goes to the Page and a scheduled human message is stored as that agent (no origin)', async () => {
    h.conversation = conv({ channel: 'messenger' })
    h.connection = { ...h.connection, kind: 'messenger', external_id: 'PG1' }
    fetchMock.mockResolvedValueOnce(ok('mid.2'))
    await engineSendMessaging(db, input({ origin: undefined, agentId: 'agent-7' }))
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/graph\.facebook\.com\/v[\d.]+\/PG1\/messages$/)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).recipient.id).toBe('PSID')
    expect(h.inserted[0]).toMatchObject({ sender_type: 'agent', sender_id: 'agent-7', origin: null, channel: 'messenger' })
  })

  it('stores the api idempotency claim and leaves the preview alone for a survey', async () => {
    fetchMock.mockImplementation(async () => ok('mid.3'))
    await engineSendMessaging(db, input({ origin: 'api', apiRequestId: 'req-1' }))
    expect(h.inserted[0]).toMatchObject({ origin: 'api', api_request_id: 'req-1' })
    h.inserted = []
    h.convUpdates = []
    await engineSendMessaging(db, input({ origin: 'csat' }))
    expect(h.inserted[0]).toMatchObject({ origin: 'csat' })
    expect(h.convUpdates).toHaveLength(0)
  })

  it('outside the 24 h window (or with no customer message) is a SKIP and Meta is never called', async () => {
    h.conversation = conv({ last_customer_message_at: hoursAgo(25) })
    expect(await skipCode(engineSendMessaging(db, input()))).toBe('window_closed')
    h.conversation = conv({ last_customer_message_at: null })
    expect(await skipCode(engineSendMessaging(db, input()))).toBe('window_closed')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(h.inserted).toHaveLength(0)
  })

  it('module off, no connection and an expired connection are SKIPs with pt-BR text', async () => {
    h.modules = new Set(['channel_messenger'])
    expect(await skipCode(engineSendMessaging(db, input()))).toBe('module_off')
    h.modules = new Set(['channel_instagram'])
    h.connection = null
    expect(await skipCode(engineSendMessaging(db, input()))).toBe('channel_not_connected')
    h.connection = { id: 'ch-1', kind: 'instagram', external_id: 'IG1', status: 'expired', access_token: 'ct', account_id: 'acct-1' }
    const err = await engineSendMessaging(db, input()).catch((e) => e)
    expect(err).toBeInstanceOf(MessagingSkipError)
    expect(err.code).toBe('channel_expired')
    expect(err.message).toMatch(/Reconecte/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('enforces the per-channel text limit before calling Meta', async () => {
    expect(await skipCode(engineSendMessaging(db, input({ content: { kind: 'text', text: 'é'.repeat(501) } })))).toBe('text_too_long')
    h.conversation = conv({ channel: 'messenger' })
    h.connection = { ...h.connection, kind: 'messenger', external_id: 'PG1' }
    expect(await skipCode(engineSendMessaging(db, input({ content: { kind: 'text', text: 'a'.repeat(2001) } })))).toBe('text_too_long')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a token error flags the connection expired and SKIPs; a permission error SKIPs; a 5xx throws (retryable)', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 190, message: 'x' } }), { status: 401 }))
    expect(await skipCode(engineSendMessaging(db, input()))).toBe('channel_expired')
    expect(h.expired).toEqual([{ status: 'expired' }])
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 10, message: 'x' } }), { status: 400 }))
    expect(await skipCode(engineSendMessaging(db, input()))).toBe('permission_denied')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 10, error_subcode: 2534022, message: 'x' } }), { status: 400 }))
    expect(await skipCode(engineSendMessaging(db, input()))).toBe('window_closed')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 2, message: 'boom' } }), { status: 500 }))
    expect(await skipCode(engineSendMessaging(db, input()))).toMatch(/^error:O Instagram não aceitou/)
    expect(h.inserted).toHaveLength(0)
  })

  it('a send Meta accepted but the DB refused throws the "do not retry" marker; an echo that got there first is claimed', async () => {
    fetchMock.mockImplementation(async () => ok('mid.4'))
    h.insertError = { code: 'XX000' }
    await expect(engineSendMessaging(db, input())).rejects.toThrow(/sent to Meta but DB insert failed/)
    h.insertError = { code: '23505' }
    await expect(engineSendMessaging(db, input())).resolves.toMatchObject({ whatsapp_message_id: 'mid.4' })
    expect(h.claim).toHaveBeenCalledOnce()
  })

  it('interactive buttons / lists become the same numbered text as on the QR channel', async () => {
    fetchMock.mockResolvedValueOnce(ok('mid.5'))
    const text = renderInteractiveAsText({ bodyText: 'Escolha:', options: ['Vendas', 'Suporte'], footerText: 'Digite o número' })
    await engineSendMessaging(db, input({ content: { kind: 'text', text } }))
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).message.text).toBe('Escolha:\n\n1. Vendas\n2. Suporte\n\n_Digite o número_')
  })

  it('media goes as an attachment from the account\'s own storage, the caption as a second text, both persisted', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://db.example.com'
    process.env.NEXT_PUBLIC_SITE_URL = 'https://www.semprecrm.com.br'
    fetchMock.mockResolvedValueOnce(ok('mid.img')).mockResolvedValueOnce(ok('mid.cap'))
    const url = 'https://db.example.com/storage/v1/object/public/chat-media/account-acct-1/a.png'
    const r = await engineSendMessaging(db, input({ content: { kind: 'media', mediaType: 'image', url, caption: 'legenda' } }))
    expect(r.whatsapp_message_id).toBe('mid.img')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).message.attachment).toMatchObject({ type: 'image' })
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).message).toEqual({ text: 'legenda' })
    expect(h.inserted.map((x) => [x.content_type, x.content_text, x.media_url])).toEqual([
      ['image', null, url],
      ['text', 'legenda', null],
    ])
  })

  it('refuses media from another account\'s storage before calling Meta', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://db.example.com'
    const url = 'https://db.example.com/storage/v1/object/public/chat-media/account-OTHER/a.png'
    await expect(engineSendMessaging(db, input({ content: { kind: 'media', mediaType: 'image', url } }))).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a conversation of another account / contact, or a WhatsApp one, is not sent on', async () => {
    h.conversation = null
    await expect(engineSendMessaging(db, input())).rejects.toThrow(/conversation not found/)
    h.conversation = conv({ channel: 'qr' })
    await expect(engineSendMessaging(db, input())).rejects.toThrow(/not an Instagram/)
    h.conversation = conv({ contact: { instagram_id: null, messenger_id: 'PSID', anonymized_at: null } })
    expect(await skipCode(engineSendMessaging(db, input()))).toBe('contact_identity_missing')
    h.conversation = conv({ contact: { instagram_id: 'IGSID', anonymized_at: '2026-01-01' } })
    expect(await skipCode(engineSendMessaging(db, input()))).toBe('contact_identity_missing')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('templates are a SKIP with a reason', () => {
    const e = templateSkip('instagram')
    expect(e).toBeInstanceOf(MessagingSkipError)
    expect(e.code).toBe('template_unsupported')
    expect(e.message).toMatch(/Instagram/)
  })
})
