import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  connection: null as Record<string, unknown> | null,
  inserted: [] as Record<string, unknown>[],
  insertError: null as { code: string } | null,
  updates: [] as Record<string, unknown>[],
  claim: vi.fn(async () => ({ id: 'claimed-1' }) as { id: string } | null),
  waSend: vi.fn(),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => `plain-${v}` }))
vi.mock('@/lib/whatsapp/phone-echo', () => ({ claimEchoedRow: (...a: unknown[]) => (h.claim as (...x: unknown[]) => unknown)(...a) }))
vi.mock('@/lib/whatsapp/meta-api', () => ({ sendTextMessage: h.waSend, sendMediaMessage: h.waSend, sendTemplateMessage: h.waSend }))
vi.mock('@/lib/whatsapp/qr-gateway', () => ({ sendViaGateway: h.waSend }))

import { isWithinMessagingWindow, sendManualMessagingReply, type ManualSendInput } from './manual-send'

const admin = {
  from: () => {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      maybeSingle: async () => ({ data: h.connection, error: null }),
    }
    return b
  },
} as never

const db = {
  from: (table: string) => {
    let update: Record<string, unknown> | null = null
    const b: Record<string, unknown> = {
      insert: (row: Record<string, unknown>) => {
        h.inserted.push(row)
        return b
      },
      update: (p: Record<string, unknown>) => ((update = p), b),
      select: () => b,
      eq: () => b,
      single: async () => (h.insertError ? { data: null, error: h.insertError } : { data: { id: `row-${h.inserted.length}` }, error: null }),
      then: (f: (v: unknown) => unknown) => {
        if (update && table === 'conversations') h.updates.push(update)
        return Promise.resolve({ data: null, error: null }).then(f)
      },
    }
    return b
  },
} as never

const NOW = Date.parse('2026-10-27T12:00:00Z')
const hoursAgo = (n: number) => new Date(NOW - n * 3_600_000).toISOString()

function input(over: Partial<ManualSendInput> & { channel?: 'instagram' | 'messenger'; lastAt?: string | null } = {}): ManualSendInput {
  const channel = over.channel ?? 'instagram'
  return {
    db,
    admin,
    accountId: 'acct-1',
    userId: 'user-1',
    conversation: {
      id: 'conv-1',
      channel,
      last_customer_message_at: over.lastAt === undefined ? hoursAgo(1) : over.lastAt,
      contact: { instagram_id: 'IGSID', messenger_id: 'PSID' },
    },
    messageType: 'text',
    contentText: 'olá',
    mediaUrl: null,
    publicMediaUrl: null,
    replyToMessageId: null,
    now: NOW,
    ...over,
  }
}

const fetchMock = vi.fn()
const ok = (id: string) => new Response(JSON.stringify({ recipient_id: 'x', message_id: id }), { status: 200 })

beforeEach(() => {
  h.connection = { id: 'ch-1', account_id: 'acct-1', kind: 'instagram', external_id: 'IG1', status: 'active', access_token: 'ct' }
  h.inserted = []
  h.updates = []
  h.insertError = null
  h.claim.mockClear()
  h.waSend.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.unstubAllGlobals())

describe('isWithinMessagingWindow', () => {
  it('is 24 h from the customer message, and closed without one', () => {
    expect(isWithinMessagingWindow(hoursAgo(23.9), NOW)).toBe(true)
    expect(isWithinMessagingWindow(hoursAgo(24.1), NOW)).toBe(false)
    expect(isWithinMessagingWindow(null, NOW)).toBe(false)
    expect(isWithinMessagingWindow('garbage', NOW)).toBe(false)
  })
})

describe('sendManualMessagingReply', () => {
  it('Instagram text: calls graph.instagram.com with the account token, stores the row on the instagram channel', async () => {
    fetchMock.mockResolvedValueOnce(ok('mid.out'))
    const r = await sendManualMessagingReply(input())
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ success: true, whatsapp_message_id: 'mid.out', channel: 'instagram' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://graph.instagram.com/v21.0/IG1/messages')
    expect(init.headers.Authorization).toBe('Bearer plain-ct')
    expect(JSON.parse(init.body)).toMatchObject({ recipient: { id: 'IGSID' }, message: { text: 'olá' } })
    expect(h.inserted[0]).toMatchObject({ sender_type: 'agent', sender_id: 'user-1', channel: 'instagram', message_id: 'mid.out', content_text: 'olá' })
    expect(h.updates[0]).toMatchObject({ last_message_text: 'olá' })
  })

  it('Messenger image: sends the attachment to the page, then the caption as text', async () => {
    h.connection = { ...h.connection, kind: 'messenger', external_id: 'PG1' }
    fetchMock.mockResolvedValueOnce(ok('mid.img')).mockResolvedValueOnce(ok('mid.cap'))
    const r = await sendManualMessagingReply(
      input({ channel: 'messenger', messageType: 'image', contentText: 'legenda', mediaUrl: '/supabase/storage/v1/object/public/chat-media/account-acct-1/a.png', publicMediaUrl: 'https://app.test/supabase/storage/v1/object/public/chat-media/account-acct-1/a.png' }),
    )
    expect(r.status).toBe(200)
    expect(fetchMock.mock.calls[0][0]).toBe('https://graph.facebook.com/v21.0/PG1/messages')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).message.attachment).toMatchObject({ type: 'image', payload: { url: 'https://app.test/supabase/storage/v1/object/public/chat-media/account-acct-1/a.png' } })
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).message).toEqual({ text: 'legenda' })
    expect(h.inserted.map((x) => x.content_type)).toEqual(['image', 'text'])
    expect(h.inserted[0]).toMatchObject({ channel: 'messenger', content_text: null })
  })

  it('refuses after 24 h without calling Meta', async () => {
    const r = await sendManualMessagingReply(input({ lastAt: hoursAgo(25) }))
    expect(r).toMatchObject({ status: 409, body: { code: 'window_closed' } })
    expect(String(r.body.error)).toMatch(/24 h/)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(h.inserted).toHaveLength(0)
  })

  it('refuses a conversation with no customer message at all', async () => {
    expect((await sendManualMessagingReply(input({ lastAt: null }))).body.code).toBe('window_closed')
  })

  it('refuses templates (they do not exist on these channels)', async () => {
    const r = await sendManualMessagingReply(input({ messageType: 'template' }))
    expect(r).toMatchObject({ status: 400, body: { code: 'template_not_supported' } })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses when the account has no active connection', async () => {
    h.connection = null
    expect((await sendManualMessagingReply(input())).body.code).toBe('channel_not_connected')
    h.connection = { id: 'c', account_id: 'acct-1', kind: 'instagram', external_id: 'IG1', status: 'expired', access_token: 'ct' }
    expect((await sendManualMessagingReply(input())).body.code).toBe('channel_expired')
    h.connection = { id: 'c', account_id: 'acct-1', kind: 'instagram', external_id: 'IG1', status: 'revoked', access_token: 'ct' }
    expect((await sendManualMessagingReply(input())).body.code).toBe('channel_not_connected')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps Meta\'s outside-the-window error to the same clear refusal, and other errors to 502', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'x', code: 10, error_subcode: 2534022 } }), { status: 400 }))
    expect((await sendManualMessagingReply(input())).body.code).toBe('window_closed')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'boom', code: 1 } }), { status: 500 }))
    const r = await sendManualMessagingReply(input())
    expect(r).toMatchObject({ status: 502, body: { code: 'send_failed' } })
    expect(h.inserted).toHaveLength(0)
  })

  it('plain code 10 is a permission problem, 190 a dead token; the Meta text never reaches the client', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'user 1784 blocked', code: 10 } }), { status: 400 }))
    const denied = await sendManualMessagingReply(input())
    expect(denied).toMatchObject({ status: 403, body: { code: 'permission_denied' } })
    expect(JSON.stringify(denied.body)).not.toContain('1784')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'x', code: 190 } }), { status: 401 }))
    expect((await sendManualMessagingReply(input())).body.code).toBe('channel_expired')
  })

  it('logs code / subcode only, never the Meta message', async () => {
    const logged: unknown[] = []
    vi.mocked(console.error).mockImplementation((...a: unknown[]) => void logged.push(...a))
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'IGSID 999 is bad', code: 100, error_subcode: 5 } }), { status: 400 }))
    await sendManualMessagingReply(input())
    expect(JSON.stringify(logged)).toContain('code 100')
    expect(JSON.stringify(logged)).not.toContain('IGSID 999')
  })

  it('refuses text over the channel limit before calling Meta (Instagram bytes, Messenger characters)', async () => {
    const ig = await sendManualMessagingReply(input({ contentText: 'é'.repeat(501) }))
    expect(ig).toMatchObject({ status: 400, body: { code: 'text_too_long' } })
    const ok1 = 'é'.repeat(500)
    fetchMock.mockResolvedValueOnce(ok('m1'))
    expect((await sendManualMessagingReply(input({ contentText: ok1 }))).status).toBe(200)
    h.connection = { ...h.connection, kind: 'messenger', external_id: 'PG1' }
    expect((await sendManualMessagingReply(input({ channel: 'messenger', contentText: 'a'.repeat(2001) }))).body.code).toBe('text_too_long')
    fetchMock.mockResolvedValueOnce(ok('m2'))
    expect((await sendManualMessagingReply(input({ channel: 'messenger', contentText: 'é'.repeat(2000) }))).status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('Meta accepted but the DB insert failed: still a success (with a warning), so the agent does not resend', async () => {
    fetchMock.mockResolvedValueOnce(ok('mid.out'))
    h.insertError = { code: '08006' }
    const r = await sendManualMessagingReply(input())
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ success: true, warning: 'not_saved', whatsapp_message_id: 'mid.out', message_id: null })
  })

  it('when the echo of this mid was stored first, takes that row over', async () => {
    fetchMock.mockResolvedValueOnce(ok('mid.out'))
    h.insertError = { code: '23505' }
    const r = await sendManualMessagingReply(input())
    expect(r.status).toBe(200)
    expect(h.claim).toHaveBeenCalledWith(db, 'conv-1', 'mid.out', expect.objectContaining({ channel: 'instagram' }))
    expect(r.body.message_id).toBe('claimed-1')
  })

  it('never touches a WhatsApp transport', async () => {
    fetchMock.mockResolvedValueOnce(ok('m'))
    await sendManualMessagingReply(input())
    await sendManualMessagingReply(input({ lastAt: hoursAgo(30) }))
    await sendManualMessagingReply(input({ messageType: 'template' }))
    expect(h.waSend).not.toHaveBeenCalled()
  })
})
