import { describe, expect, it, vi } from 'vitest'

// notify.ts pulls in send.ts → web-push; keep the test network-free.
vi.mock('web-push', () => ({
  default: { sendNotification: vi.fn(), setVapidDetails: vi.fn() },
  WebPushError: class extends Error {},
}))

import { assignedPushBody, chatPushBody, inboundPushBody } from './notify'

describe('inboundPushBody (WhatsApp inbound push preview)', () => {
  it('passes text through, collapsing whitespace', () => {
    expect(inboundPushBody('  olá\n  tudo bem? ')).toBe('olá tudo bem?')
  })

  it('turns a media placeholder into a translated label', () => {
    expect(inboundPushBody('[image]')).toBe('📎 Imagem')
    expect(inboundPushBody('[audio]')).toBe('📎 Áudio')
  })

  it('leaves unknown placeholders alone', () => {
    expect(inboundPushBody('[whatever]')).toBe('[whatever]')
  })
})

describe('chatPushBody (internal chat push preview)', () => {
  it('uses the text when there is one, collapsing whitespace', () => {
    expect(chatPushBody('  olá\n\n  time ', null)).toBe('olá time')
    // Text wins even when an attachment rides along.
    expect(chatPushBody('veja', { path: 'a/b.png', mime: 'image/png' })).toBe('veja')
  })

  it('falls back to the attachment placeholder (pt-BR, same wording as the thread preview)', () => {
    expect(chatPushBody('', { path: 'a/b.ogg', mime: 'audio/ogg', name: 'voice.ogg', size: 10 })).toBe('🎤 Áudio')
    expect(chatPushBody(null, { path: 'a/b.pdf', mime: 'application/pdf', name: 'doc.pdf', size: 10 })).toBe('📎 Anexo')
    expect(chatPushBody('', { path: 'a/b.png', mime: 'image/png' })).toBe('📎 Anexo')
  })

  it('is empty for a deleted / malformed row', () => {
    expect(chatPushBody('', null)).toBe('')
    expect(chatPushBody('', { mime: 'image/png' })).toBe('')
  })
})

describe('assignedPushBody (transfer push)', () => {
  it('appends the normalised transfer reason', () => {
    expect(assignedPushBody('Maria', 'Ana', '  fatura vencida ')).toBe('Maria · por Ana — fatura vencida')
    expect(assignedPushBody('Maria', null, 'urgente')).toBe('Maria — urgente')
  })

  it('is unchanged without a reason and clamps a long one', () => {
    expect(assignedPushBody('Maria', 'Ana')).toBe('Maria · por Ana')
    expect(assignedPushBody('Maria', 'Ana', '   ')).toBe('Maria · por Ana')
    expect(assignedPushBody('M', null, 'x'.repeat(500))).toBe('M — ' + 'x'.repeat(200))
  })
})
