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
