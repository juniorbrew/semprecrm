import { describe, expect, it, vi } from 'vitest'

// notify.ts pulls in send.ts → web-push; keep the test network-free.
vi.mock('web-push', () => ({
  default: { sendNotification: vi.fn(), setVapidDetails: vi.fn() },
  WebPushError: class extends Error {},
}))

const sendSpy = vi.hoisted(() => vi.fn(async () => ({ users: 0, sent: 0, failed: 0, removed: 0, configured: true })))
vi.mock('./send', async (importOriginal) => ({ ...(await importOriginal<typeof import('./send')>()), sendPushToUsers: sendSpy }))

import { makeFakeDb } from '@/lib/ai/fake-db.test-helper'
import { _resetFocusForTests, setConversationFocus } from './focus'
import {
  assignedPushBody,
  chatPushBody,
  inboundPushBody,
  inboundRecipients,
  notifyAccountAdmins,
  notifyManagerAlert,
  notifySlaBreached,
  notifySnoozeWoke,
  pushLine,
  type ProfileLite,
} from './notify'

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

describe('notifySnoozeWoke (snooze wake push)', () => {
  const profiles = () => [
    { user_id: 'ag', account_id: 'acc', account_role: 'agent', notification_prefs: {} },
    { user_id: 'sn', account_id: 'acc', account_role: 'agent', notification_prefs: {} },
    { user_id: 'vw', account_id: 'acc', account_role: 'viewer', notification_prefs: {} },
    { user_id: 'off', account_id: 'acc', account_role: 'agent', notification_prefs: { snooze_woke: false } },
    { user_id: 'x', account_id: 'other', account_role: 'owner', notification_prefs: {} },
  ]
  const db = () =>
    makeFakeDb({
      profiles: profiles(),
      contacts: [{ id: 'ct', account_id: 'acc', name: 'Maria‮\u0007 Silva', phone: '+5511999990000' }],
    })
  const base = { accountId: 'acc', conversationId: 'cv', contactId: 'ct', snoozeNote: null }

  it('goes to the assignee only, with the contact name (no phone), deep link and per-conversation tag', async () => {
    _resetFocusForTests()
    const d = db()
    await notifySnoozeWoke(d as never, { ...base, assigneeUserId: 'ag', snoozedBy: 'sn', snoozeNote: 'ligar\n de novo' })
    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(sendSpy).toHaveBeenCalledWith(d, ['ag'], {
      title: 'Voltou do adiar: Maria Silva',
      body: 'ligar de novo',
      url: '/inbox?c=cv',
      tag: 'conversation:cv',
    })
    expect(JSON.stringify(sendSpy.mock.calls)).not.toContain('99999')
  })

  it('unassigned → whoever snoozed it (if still agent+); neither → nobody', async () => {
    _resetFocusForTests()
    await notifySnoozeWoke(db() as never, { ...base, assigneeUserId: null, snoozedBy: 'sn' })
    expect((sendSpy.mock.calls[0] as unknown[])[1]).toEqual(['sn'])
    expect((sendSpy.mock.calls[0] as unknown[])[2]).toMatchObject({ body: 'O tempo de adiar terminou.' })
    sendSpy.mockClear()
    await notifySnoozeWoke(db() as never, { ...base, assigneeUserId: null, snoozedBy: 'vw' })
    await notifySnoozeWoke(db() as never, { ...base, assigneeUserId: null, snoozedBy: null })
    await notifySnoozeWoke(db() as never, { ...base, assigneeUserId: null, snoozedBy: 'x' })
    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('honours the snooze_woke opt-out and skips a user focused on the conversation', async () => {
    _resetFocusForTests()
    await notifySnoozeWoke(db() as never, { ...base, assigneeUserId: 'off', snoozedBy: null })
    setConversationFocus('ag', 'cv')
    await notifySnoozeWoke(db() as never, { ...base, assigneeUserId: 'ag', snoozedBy: null })
    expect(sendSpy).not.toHaveBeenCalled()
    _resetFocusForTests()
  })

  it('falls back to "Conversa" without a contact name and never throws', async () => {
    _resetFocusForTests()
    await notifySnoozeWoke(db() as never, { ...base, contactId: null, assigneeUserId: 'ag', snoozedBy: null })
    expect((sendSpy.mock.calls[0] as unknown[])[2]).toMatchObject({ title: 'Voltou do adiar: Conversa' })
    const broken = { from: () => { throw new Error('db down') } }
    await expect(
      notifySnoozeWoke(broken as never, { ...base, assigneeUserId: 'ag', snoozedBy: null }),
    ).resolves.toMatchObject({ sent: 0 })
  })

  it('pushLine strips control / bidi characters and clamps', () => {
    expect(pushLine('a\u0000b‏ c', 80)).toBe('a b c')
    expect(pushLine('x'.repeat(200), 80)).toBe('x'.repeat(79) + '…')
    expect(pushLine(null, 80)).toBe('')
  })
})

/** User ids handed to sendPushToUsers by its first call. */
const recipientsOfFirstSend = () => (sendSpy.mock.calls[0] as unknown as [unknown, string[]])[1]

describe('inboundRecipients (who hears a customer message)', () => {
  const p = (user_id: string, account_role: string, extra: Partial<ProfileLite> = {}): ProfileLite => ({
    user_id,
    account_id: 'acc',
    account_role,
    availability: 'available',
    notification_prefs: {},
    ...extra,
  })
  const team = [
    p('owner', 'owner'),
    p('admin', 'admin', { availability: 'away' }),
    p('ana', 'agent'),
    p('bia', 'agent', { availability: 'away' }),
    p('vic', 'viewer'),
  ]

  it('assigned: only the assignee', () => {
    expect(inboundRecipients(team, 'ana')).toEqual(['ana'])
  })

  it('unassigned, "available" (default): every available agent+', () => {
    expect(inboundRecipients(team, null)).toEqual(['owner', 'ana'])
    expect(inboundRecipients(team, null, 'available')).toEqual(['owner', 'ana'])
  })

  it('unassigned, "managers": owners and admins, whatever their availability', () => {
    expect(inboundRecipients(team, null, 'managers')).toEqual(['owner', 'admin'])
  })

  it('unassigned, "none": nobody', () => {
    expect(inboundRecipients(team, null, 'none')).toEqual([])
  })

  it('each person can still turn new-message pushes off', () => {
    const muted = team.map((x) => (x.user_id === 'ana' ? { ...x, notification_prefs: { inbound_message: false } } : x))
    expect(inboundRecipients(muted, 'ana')).toEqual([])
    expect(inboundRecipients(muted, null)).toEqual(['owner'])
  })

  it('managers with "copy of every message" hear every conversation, once', () => {
    const watching = team.map((x) =>
      x.account_role === 'owner' || x.account_role === 'admin' || x.user_id === 'ana'
        ? { ...x, notification_prefs: { manager_all_messages: true } }
        : x,
    )
    // The agent's flag is ignored: the copy is a manager-only alert.
    expect(inboundRecipients(watching, 'bia')).toEqual(['bia', 'owner', 'admin'])
    expect(inboundRecipients(watching, null, 'none')).toEqual(['owner', 'admin'])
    expect(inboundRecipients(watching, null, 'managers')).toEqual(['owner', 'admin'])
  })
})

describe('notifySlaBreached (team deadline for managers)', () => {
  const profiles = [
    { user_id: 'owner', account_id: 'acc', account_role: 'owner', notification_prefs: { manager_sla_team: true } },
    { user_id: 'admin', account_id: 'acc', account_role: 'admin', notification_prefs: {} },
    { user_id: 'ana', account_id: 'acc', account_role: 'agent', notification_prefs: { manager_sla_team: true } },
  ]

  it('assigned: the assignee plus the managers who opted in', async () => {
    sendSpy.mockClear()
    const db = makeFakeDb({ profiles, conversations: [{ id: 'c1', account_id: 'acc' }] })
    await notifySlaBreached(db as never, { accountId: 'acc', conversationId: 'c1', assigneeUserId: 'ana', kind: 'first_response' })
    expect(recipientsOfFirstSend()).toEqual(['ana', 'owner'])
  })

  it('unassigned: every owner and admin, as before', async () => {
    sendSpy.mockClear()
    const db = makeFakeDb({ profiles, conversations: [{ id: 'c1', account_id: 'acc' }] })
    await notifySlaBreached(db as never, { accountId: 'acc', conversationId: 'c1', assigneeUserId: null, kind: 'first_response' })
    expect(recipientsOfFirstSend()).toEqual(['owner', 'admin'])
  })
})

describe('notifyManagerAlert (customer waiting / nobody assigned)', () => {
  const now = new Date('2026-11-02T15:00:00Z')
  const since = new Date('2026-11-02T14:48:00Z')
  const db = () =>
    makeFakeDb({
      profiles: [
        { user_id: 'owner', account_id: 'acc', account_role: 'owner', full_name: 'Dona', notification_prefs: { manager_waiting: true } },
        { user_id: 'admin', account_id: 'acc', account_role: 'admin', notification_prefs: { manager_unassigned: true } },
        { user_id: 'ana', account_id: 'acc', account_role: 'agent', full_name: 'Ana', notification_prefs: { manager_waiting: true } },
      ],
      contacts: [{ id: 'k1', account_id: 'acc', name: 'Marina', phone: '5511999990000' }],
    })

  it('waiting: the opted-in managers, with who is waiting, for how long and with whom', async () => {
    sendSpy.mockClear()
    await notifyManagerAlert(db() as never, {
      accountId: 'acc', conversationId: 'c1', contactId: 'k1', assigneeUserId: 'ana', kind: 'waiting', since, now,
    })
    const [, recipients, payload] = sendSpy.mock.calls[0] as unknown as [unknown, string[], { title: string; body: string; url: string }]
    expect(recipients).toEqual(['owner'])
    expect(payload.title).toBe('Cliente esperando resposta')
    expect(payload.body).toBe('Marina · 12 min · Ana')
    expect(payload.url).toBe('/inbox?c=c1')
  })

  it('unassigned: only the managers who turned that one on', async () => {
    sendSpy.mockClear()
    await notifyManagerAlert(db() as never, {
      accountId: 'acc', conversationId: 'c1', contactId: 'k1', assigneeUserId: null, kind: 'unassigned', since, now,
    })
    expect(recipientsOfFirstSend()).toEqual(['admin'])
  })

  it('nobody opted in: nothing is sent', async () => {
    sendSpy.mockClear()
    const quiet = makeFakeDb({ profiles: [{ user_id: 'owner', account_id: 'acc', account_role: 'owner', notification_prefs: {} }] })
    await notifyManagerAlert(quiet as never, {
      accountId: 'acc', conversationId: 'c1', contactId: null, assigneeUserId: null, kind: 'waiting', since, now,
    })
    expect(sendSpy).not.toHaveBeenCalled()
  })
})
