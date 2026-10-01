import { describe, expect, it, vi } from 'vitest'

// notify.ts pulls in send.ts → web-push; keep the test network-free.
vi.mock('web-push', () => ({
  default: { sendNotification: vi.fn(), setVapidDetails: vi.fn() },
  WebPushError: class extends Error {},
}))

const sendSpy = vi.hoisted(() => vi.fn(async () => ({ users: 0, sent: 0, failed: 0, removed: 0, configured: true })))
vi.mock('./send', async (importOriginal) => ({ ...(await importOriginal<typeof import('./send')>()), sendPushToUsers: sendSpy }))

import { makeFakeDb } from '@/lib/ai/fake-db.test-helper'
import { assignedPushBody, chatPushBody, inboundPushBody, notifyAccountAdmins } from './notify'

describe('notifyAccountAdmins (security / spend notices)', () => {
  it('pushes to every owner and admin of the account, whatever their notification prefs', async () => {
    const db = makeFakeDb({
      profiles: [
        { user_id: 'o', account_id: 'acc', account_role: 'owner', notification_prefs: { sla_breached: false } },
        { user_id: 'a', account_id: 'acc', account_role: 'admin', notification_prefs: {} },
        { user_id: 'g', account_id: 'acc', account_role: 'agent', notification_prefs: {} },
        { user_id: 'x', account_id: 'other', account_role: 'owner', notification_prefs: {} },
      ],
    })
    const payload = { title: 'T', body: 'B', url: '/settings?tab=ai' }
    await notifyAccountAdmins(db as never, 'acc', payload)
    expect(sendSpy).toHaveBeenCalledWith(db, ['o', 'a'], payload)
  })
})

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
