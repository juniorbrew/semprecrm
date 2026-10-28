import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { copyMessagingMedia, isAllowedMetaMediaUrl, storeMessagingAvatar } from './media'
import { fetchMessagingProfile, MessagingApiError, sendMessagingMessage } from './graph'
import { parseMessagingWebhook } from './parse'
import { verifyMessagingSignature } from './signature'

const sign = (body: string, secret: string) =>
  'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')

describe('verifyMessagingSignature', () => {
  const body = '{"object":"instagram"}'
  it('accepts the Messenger app secret and the Instagram app secret', () => {
    const env = { META_APP_SECRET: 'fb-secret', INSTAGRAM_APP_SECRET: 'ig-secret' }
    expect(verifyMessagingSignature(body, sign(body, 'fb-secret'), env)).toBe(true)
    expect(verifyMessagingSignature(body, sign(body, 'ig-secret'), env)).toBe(true)
  })
  it('rejects a wrong, missing or malformed signature', () => {
    const env = { META_APP_SECRET: 'fb-secret', INSTAGRAM_APP_SECRET: 'ig-secret' }
    expect(verifyMessagingSignature(body, sign(body, 'other'), env)).toBe(false)
    expect(verifyMessagingSignature(body, null, env)).toBe(false)
    expect(verifyMessagingSignature(body, 'abc', env)).toBe(false)
    expect(verifyMessagingSignature(body + ' ', sign(body, 'fb-secret'), env)).toBe(false)
  })
  it('fails closed when no secret is configured', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(verifyMessagingSignature(body, sign(body, ''), {})).toBe(false)
    spy.mockRestore()
  })
  it('works with only one of the two secrets configured', () => {
    expect(verifyMessagingSignature(body, sign(body, 'ig-secret'), { INSTAGRAM_APP_SECRET: 'ig-secret' })).toBe(true)
    expect(verifyMessagingSignature(body, sign(body, 'ig-secret'), { META_APP_SECRET: 'fb-secret' })).toBe(false)
  })
})

const envelope = (object: string, messaging: unknown[], id = object === 'page' ? 'PG1' : 'IG1') => ({ object, entry: [{ id, time: 1, messaging }] })

describe('parseMessagingWebhook', () => {
  it('parses a text message and resolves the business from recipient.id', () => {
    const [e] = parseMessagingWebhook(
      envelope('instagram', [
        { sender: { id: 'IGSID' }, recipient: { id: 'IG1' }, timestamp: 1700000000000, message: { mid: 'm1', text: 'oi' } },
      ]),
    )
    expect(e).toMatchObject({
      kind: 'instagram', businessId: 'IG1', customerId: 'IGSID', echo: false, mid: 'm1', text: 'oi', timestamp: 1700000000000,
    })
  })

  it('maps object=page to messenger and keeps media attachments', () => {
    const [e] = parseMessagingWebhook(
      envelope('page', [
        {
          sender: { id: 'PSID' }, recipient: { id: 'PG1' }, timestamp: 5,
          message: { mid: 'm2', attachments: [{ type: 'image', payload: { url: 'https://scontent.fbcdn.net/a.jpg' } }] },
        },
      ]),
    )
    expect(e.kind).toBe('messenger')
    expect(e.attachments).toEqual([{ type: 'image', url: 'https://scontent.fbcdn.net/a.jpg', title: null }])
    expect(e.text).toBeNull()
  })

  it('treats is_echo as the business talking: sender is the business, recipient the customer', () => {
    const [e] = parseMessagingWebhook(
      envelope('instagram', [
        { sender: { id: 'IG1' }, recipient: { id: 'IGSID' }, timestamp: 9, message: { mid: 'm3', text: 'olá', is_echo: true } },
      ]),
    )
    expect(e).toMatchObject({ echo: true, businessId: 'IG1', customerId: 'IGSID' })
  })

  it('keeps story mentions and reply context', () => {
    const [e] = parseMessagingWebhook(
      envelope('instagram', [
        {
          sender: { id: 'IGSID' }, recipient: { id: 'IG1' }, timestamp: 9,
          message: { mid: 'm4', reply_to: { mid: 'm0' }, attachments: [{ type: 'story_mention', payload: { url: 'https://lookaside.fbsbx.com/s' } }] },
        },
      ]),
    )
    expect(e.replyToMid).toBe('m0')
    expect(e.attachments[0].type).toBe('story_mention')
  })

  it('skips an event whose business id is not the entry id', () => {
    expect(
      parseMessagingWebhook(
        envelope('instagram', [{ sender: { id: 'C' }, recipient: { id: 'OTHER' }, timestamp: 1, message: { mid: 'm', text: 'x' } }]),
      ),
    ).toEqual([])
  })

  it('ignores reactions, reads, deliveries, unsends, empty messages and foreign objects', () => {
    expect(
      parseMessagingWebhook(
        envelope('instagram', [
          { sender: { id: 'a' }, recipient: { id: 'b' }, reaction: { mid: 'm', action: 'react', emoji: '❤' } },
          { sender: { id: 'a' }, recipient: { id: 'b' }, read: { mid: 'm' } },
          { sender: { id: 'a' }, recipient: { id: 'b' }, delivery: { mids: ['m'] } },
          { sender: { id: 'a' }, recipient: { id: 'b' }, message: { mid: 'm', is_deleted: true } },
          { sender: { id: 'a' }, recipient: { id: 'b' }, message: { mid: 'm' } },
        ]),
      ),
    ).toEqual([])
    expect(parseMessagingWebhook({ object: 'whatsapp_business_account', entry: [] })).toEqual([])
    expect(parseMessagingWebhook(null)).toEqual([])
    expect(parseMessagingWebhook('x')).toEqual([])
  })
})

const fetchMock = vi.fn()
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

describe('sendMessagingMessage', () => {
  it('Instagram text goes to graph.instagram.com with the token in the header', async () => {
    fetchMock.mockResolvedValueOnce(ok({ recipient_id: 'IGSID', message_id: 'mid.1' }))
    const r = await sendMessagingMessage({ kind: 'instagram', businessId: 'IG1', token: 'TKN', recipientId: 'IGSID' }, { text: 'oi' })
    expect(r.messageId).toBe('mid.1')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://graph.instagram.com/v26.0/IG1/messages')
    expect(url).not.toContain('TKN')
    expect(init.headers.Authorization).toBe('Bearer TKN')
    expect(JSON.parse(init.body)).toEqual({ recipient: { id: 'IGSID' }, messaging_type: 'RESPONSE', message: { text: 'oi' } })
  })

  it('Messenger image goes to graph.facebook.com/{page}/messages as an attachment', async () => {
    fetchMock.mockResolvedValueOnce(ok({ recipient_id: 'PSID', message_id: 'mid.2' }))
    await sendMessagingMessage(
      { kind: 'messenger', businessId: 'PG1', token: 'TKN', recipientId: 'PSID' },
      { mediaKind: 'image', url: 'https://x.test/a.png' },
    )
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://graph.facebook.com/v26.0/PG1/messages')
    expect(JSON.parse(init.body).message).toEqual({
      attachment: { type: 'image', payload: { url: 'https://x.test/a.png', is_reusable: false } },
    })
  })

  it('surfaces Meta errors and recognises the closed 24 h window', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'outside window', code: 10, error_subcode: 2534022 } }), { status: 400 }),
    )
    const err = await sendMessagingMessage(
      { kind: 'messenger', businessId: 'PG1', token: 'TKN', recipientId: 'PSID' },
      { text: 'x' },
    ).catch((e) => e)
    expect(err).toBeInstanceOf(MessagingApiError)
    expect(err.outsideWindow).toBe(true)
    expect(err.message).not.toContain('TKN')
  })
})

describe('fetchMessagingProfile', () => {
  it('reads name and photo for Instagram', async () => {
    fetchMock.mockResolvedValueOnce(ok({ name: 'Ana Souza', username: 'ana', profile_pic: 'https://scontent.cdninstagram.com/p.jpg' }))
    expect(await fetchMessagingProfile('instagram', 'TKN', 'IGSID')).toEqual({
      name: 'Ana Souza', pictureUrl: 'https://scontent.cdninstagram.com/p.jpg',
    })
    expect(fetchMock.mock.calls[0][0]).toContain('graph.instagram.com/v26.0/IGSID?fields=')
  })
  it('joins first and last name for Messenger', async () => {
    fetchMock.mockResolvedValueOnce(ok({ first_name: 'Bia', last_name: 'Lima', profile_pic: 'https://p' }))
    expect((await fetchMessagingProfile('messenger', 'TKN', 'PSID'))?.name).toBe('Bia Lima')
  })
  it('tells the caller when the token is dead (190) so the connection can be flagged', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onInvalid = vi.fn()
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 190, message: 'x' } }), { status: 401 }))
    expect(await fetchMessagingProfile('messenger', 'TKN', 'PSID', onInvalid)).toBeNull()
    expect(onInvalid).toHaveBeenCalledOnce()
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 1, message: 'x' } }), { status: 500 }))
    await fetchMessagingProfile('messenger', 'TKN', 'PSID', onInvalid)
    expect(onInvalid).toHaveBeenCalledOnce()
    spy.mockRestore()
  })

  it('returns null instead of throwing when Graph fails', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockRejectedValueOnce(new Error('boom'))
    expect(await fetchMessagingProfile('instagram', 'TKN', 'IGSID')).toBeNull()
    spy.mockRestore()
  })
})

describe('copyMessagingMedia', () => {
  const upload = vi.fn(async () => ({ error: null }))
  const db = { storage: { from: () => ({ upload }) } } as never
  beforeEach(() => {
    upload.mockClear()
    process.env.NEXT_PUBLIC_SUPABASE_URL = '/supabase'
  })

  it('only fetches Meta CDN hosts over https', () => {
    expect(isAllowedMetaMediaUrl('https://scontent-gru1-1.xx.fbcdn.net/a.jpg')).toBe(true)
    expect(isAllowedMetaMediaUrl('https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1')).toBe(true)
    expect(isAllowedMetaMediaUrl('http://scontent.fbcdn.net/a.jpg')).toBe(false)
    expect(isAllowedMetaMediaUrl('https://evil.test/fbcdn.net')).toBe(false)
    expect(isAllowedMetaMediaUrl('https://fbcdn.net.evil.test/a')).toBe(false)
    expect(isAllowedMetaMediaUrl('http://169.254.169.254/')).toBe(false)
  })

  it('copies the file into the account folder of chat-media', async () => {
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } }))
    const r = await copyMessagingMedia(db, 'acct-1', 'https://scontent.fbcdn.net/a.jpg', 'm1')
    expect(r?.mimeType).toBe('image/jpeg')
    expect(r?.url).toMatch(/^\/supabase\/storage\/v1\/object\/public\/chat-media\/account-acct-1\/meta\/\d+-m1\.jpg$/)
    expect(upload).toHaveBeenCalledOnce()
  })

  it('returns null (the message is kept without the file) on a foreign host, bad status or upload error', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await copyMessagingMedia(db, 'acct-1', 'https://evil.test/a.jpg', 'm1')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404 }))
    expect(await copyMessagingMedia(db, 'acct-1', 'https://scontent.fbcdn.net/a.jpg', 'm1')).toBeNull()
    spy.mockRestore()
  })
})

describe('media limits and types', () => {
  const upload = vi.fn(async () => ({ error: null }))
  const from = vi.fn(() => ({ upload }))
  const db = { storage: { from } } as never
  beforeEach(() => {
    upload.mockClear()
    from.mockClear()
    process.env.NEXT_PUBLIC_SUPABASE_URL = '/supabase'
  })

  it('aborts a download past 16 MB even without content-length', async () => {
    const chunk = new Uint8Array(4 * 1024 * 1024)
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 10) controller.enqueue(chunk)
        else controller.close()
      },
    })
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 200, headers: { 'content-type': 'video/mp4' } }))
    expect(await copyMessagingMedia(db, 'acct-1', 'https://video.fbcdn.net/v.mp4', 'm1')).toBeNull()
    expect(upload).not.toHaveBeenCalled()
    expect(sent).toBeLessThan(10)
  })

  it('stores only types the chat-media bucket accepts; others become a placeholder upstream', async () => {
    for (const type of ['image/gif', 'text/html', 'application/x-msdownload', 'video/quicktime', '']) {
      fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': type } }))
      expect(await copyMessagingMedia(db, 'acct-1', 'https://x.fbcdn.net/a', 'm1'), type).toBeNull()
    }
    expect(upload).not.toHaveBeenCalled()
  })

  it('profile photo goes to contact-avatars at account-<id>/<contact-id> with upsert (no external id in the path)', async () => {
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1, 2]), { status: 200, headers: { 'content-type': 'image/jpeg' } }))
    const url = await storeMessagingAvatar(db, 'acct-1', 'Contact-1', 'https://scontent.cdninstagram.com/p.jpg')
    expect(from).toHaveBeenCalledWith('contact-avatars')
    expect(upload).toHaveBeenCalledWith('account-acct-1/contact-1', expect.anything(), expect.objectContaining({ upsert: true, contentType: 'image/jpeg' }))
    expect(url).toMatch(/^\/supabase\/storage\/v1\/object\/public\/contact-avatars\/account-acct-1\/contact-1\?v=\d+$/)
  })

  it('refuses an avatar over 1 MB or of another type', async () => {
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(1024 * 1024 + 1), { status: 200, headers: { 'content-type': 'image/jpeg' } }))
    expect(await storeMessagingAvatar(db, 'a', 'c', 'https://x.fbcdn.net/p.jpg')).toBeNull()
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': 'image/gif' } }))
    expect(await storeMessagingAvatar(db, 'a', 'c', 'https://x.fbcdn.net/p.gif')).toBeNull()
  })
})
