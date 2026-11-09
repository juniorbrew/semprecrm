import { describe, expect, it } from 'vitest'

import { parseQrMessageBody } from './qr-inbound-body'

const BASE = { account_id: 'acct-1', message_id: 'M1', from: '5511999990000', type: 'text', text: 'oi' }

describe('parseQrMessageBody — chat_jid (migration 091)', () => {
  it('keeps a 1:1 chat jid, phone or LID', () => {
    expect(parseQrMessageBody({ ...BASE, chat_jid: '5511999990000@s.whatsapp.net' })?.chatJid).toBe(
      '5511999990000@s.whatsapp.net',
    )
    expect(parseQrMessageBody({ ...BASE, chat_jid: '123456789012@lid' })?.chatJid).toBe('123456789012@lid')
  })

  it('drops anything else (groups, junk, missing)', () => {
    expect(parseQrMessageBody({ ...BASE, chat_jid: '1203-45@g.us' })?.chatJid).toBeNull()
    expect(parseQrMessageBody({ ...BASE, chat_jid: "x'; drop table" })?.chatJid).toBeNull()
    expect(parseQrMessageBody(BASE)?.chatJid).toBeNull()
  })
})

describe('parseQrMessageBody — ad from the gateway (migration 109)', () => {
  it('turns the forwarded Click-to-WhatsApp fields into an origin', () => {
    const body = parseQrMessageBody({
      ...BASE,
      ad: { title: 'Promoção sofás', source_type: 'ad', source_id: '120210000000009', source_url: 'https://fb.me/x', ctwa_clid: 'AfX' },
    })
    expect(body?.origin).toMatchObject({ channel: 'whatsapp_qr', kind: 'ad', adId: '120210000000009', headline: 'Promoção sofás', clickId: 'AfX' })
  })

  it('an old gateway (no ad field), junk or an empty ad carry no origin and the message still parses', () => {
    for (const ad of [undefined, null, 'x', 5, [], {}]) {
      const body = parseQrMessageBody({ ...BASE, ad })
      expect(body?.origin, JSON.stringify(ad)).toBeNull()
      expect(body?.messageId).toBe('M1')
    }
  })

  it('giant ad texts are clamped', () => {
    const body = parseQrMessageBody({ ...BASE, ad: { source_type: 'ad', title: 't'.repeat(10_000) } })
    expect(body?.origin?.headline).toHaveLength(300)
  })
})
