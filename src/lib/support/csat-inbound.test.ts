import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/automations/event-queue', () => ({ drainAutomationEvents: vi.fn(async () => ({ processed: 0, failed: 0 })) }))
vi.mock('@/lib/automations/meta-send', () => ({ engineSendText: vi.fn(async () => ({ whatsapp_message_id: 'x' })) }))

import { CSAT_COMMENT_PROMPT } from './csat'
import { tryConsumeCsat, type CsatInboundInput } from './csat-inbound'
import { makeFakeDb } from './csat-fake-db'

const NOW = new Date('2026-09-30T12:00:00Z')
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString()

function setup(opts: { sentHoursAgo?: number; status?: string; ask?: boolean; conversations?: CsatInboundInput['conversations']; extra?: Record<string, unknown> } = {}) {
  const { db, state } = makeFakeDb({
    csat_responses: [
      {
        id: 'r1',
        account_id: 'acc',
        contact_id: 'k1',
        conversation_id: 'conv-1',
        status: opts.status ?? 'sent',
        sent_at: hoursAgo(opts.sentHoursAgo ?? 1),
        ...opts.extra,
      },
    ],
    csat_settings: [{ account_id: 'acc', enabled: true, ask_comment: opts.ask ?? true, thanks_text: 'Valeu!' }],
  })
  const send = vi.fn(async () => ({ whatsapp_message_id: 'w' }))
  const drain = vi.fn(async () => ({ processed: 0, failed: 0 }))
  const input = (text: string | null, over: Partial<CsatInboundInput> = {}): CsatInboundInput => ({
    accountId: 'acc',
    contactId: 'k1',
    conversations: opts.conversations ?? [{ id: 'conv-1', status: 'closed' }],
    type: 'text',
    text,
    messageId: `wamid-${Math.random()}`,
    createdAt: NOW.toISOString(),
    channel: 'official',
    userId: 'owner',
    ...over,
  })
  const run = (text: string | null, over: Partial<CsatInboundInput> = {}) =>
    tryConsumeCsat(db, input(text, over), NOW, { send: send as never, drain: drain as never })
  return { db, state, send, drain, run }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('tryConsumeCsat — the score', () => {
  it('a lone score is consumed: recorded, stored in the closed conversation, thanked, automations drained', async () => {
    const { state, send, drain, run } = setup()
    const out = await run('5')
    expect(out).toEqual({ consumed: true, conversationId: 'conv-1', kind: 'score', score: 5 })
    expect(state.tables.csat_responses[0]).toMatchObject({ status: 'answered', score: 5, comment_requested_at: NOW.toISOString() })
    expect(state.tables.messages).toEqual([
      expect.objectContaining({ conversation_id: 'conv-1', sender_type: 'customer', content_text: '5', status: 'delivered', channel: 'official' }),
    ])
    expect(state.tables.conversation_events).toEqual([expect.objectContaining({ event_type: 'csat_answered', payload: { score: 5 } })])
    await flush()
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', contactId: 'k1', origin: 'csat', text: `Valeu!\n\n${CSAT_COMMENT_PROMPT}` }),
    )
    expect(drain).toHaveBeenCalledWith({ accountId: 'acc' })
  })

  it('no comment question when the account turned it off', async () => {
    const { send, state, run } = setup({ ask: false })
    await run('4')
    await flush()
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: 'Valeu!' }))
    expect(state.tables.csat_responses[0].comment_requested_at).toBeNull()
  })

  it.each([['quanto custa o frete?'], ['5 mas demorou'], ['10'], ['obrigado'], ['']])('%j is NOT consumed and the survey keeps waiting', async (text) => {
    const { state, send, run } = setup()
    expect(await run(text)).toEqual({ consumed: false })
    expect(state.tables.csat_responses[0].status).toBe('sent')
    expect(state.tables.messages ?? []).toEqual([])
    await flush()
    expect(send).not.toHaveBeenCalled()
  })

  it('media and other non-text kinds are never consumed', async () => {
    const { run } = setup()
    expect(await run('5', { type: 'image' })).toEqual({ consumed: false })
    expect(await run(null)).toEqual({ consumed: false })
  })

  it('after 48 h the survey is over: a "5" is a normal message', async () => {
    const { state, run } = setup({ sentHoursAgo: 49 })
    expect(await run('5')).toEqual({ consumed: false })
    expect(state.tables.csat_responses[0].status).toBe('sent')
  })

  it('is not consumed while the contact has a live conversation (a "5" there belongs to that chat)', async () => {
    const { state, run } = setup({ conversations: [{ id: 'conv-2', status: 'open' }, { id: 'conv-1', status: 'closed' }] })
    expect(await run('5')).toEqual({ consumed: false })
    expect(state.tables.csat_responses[0].status).toBe('sent')
  })

  it('is not consumed when the surveyed conversation was reopened (no longer closed)', async () => {
    const { run } = setup({ conversations: [{ id: 'conv-1', status: 'pending' }] })
    expect(await run('5')).toEqual({ consumed: false })
  })

  it('the same reply delivered twice records ONE answer (the second finds nothing to update)', async () => {
    const { state, send, run } = setup({ ask: false })
    await run('5')
    const second = await run('5')
    expect(second).toEqual({ consumed: false })
    expect(state.tables.csat_responses[0].score).toBe(5)
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('a missing table / read error carries on as a normal message', async () => {
    const { db } = makeFakeDb({})
    const broken = { ...db, from: () => { throw new Error('boom') } }
    await expect(tryConsumeCsat(broken as never, { accountId: 'a', contactId: 'k', conversations: [{ id: 'c', status: 'closed' }], type: 'text', text: '5', messageId: 'm', createdAt: NOW.toISOString(), channel: 'qr', userId: 'u' }, NOW)).rejects.toThrow()
    const empty = setup({ conversations: [{ id: 'other', status: 'closed' }] })
    expect(await empty.run('5')).toEqual({ consumed: false })
  })

  it('a failed thanks message never undoes the score', async () => {
    const { state, send, run } = setup()
    send.mockRejectedValueOnce(new Error('window closed'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const out = await run('5')
    await flush()
    expect(out).toMatchObject({ consumed: true, kind: 'score' })
    expect(state.tables.csat_responses[0].status).toBe('answered')
    spy.mockRestore()
  })
})

describe('tryConsumeCsat — the comment', () => {
  const answered = { status: 'answered', extra: { score: 4, comment_requested_at: hoursAgo(0.1), comment_received_at: null } }

  it('the next text is stored as the comment, once', async () => {
    const { state, send, run } = setup(answered)
    expect(await run('A Joana foi muito atenciosa')).toEqual({ consumed: true, conversationId: 'conv-1', kind: 'comment' })
    expect(state.tables.csat_responses[0]).toMatchObject({ comment: 'A Joana foi muito atenciosa', comment_received_at: NOW.toISOString() })
    expect(state.tables.messages).toHaveLength(1)
    await flush()
    expect(send).not.toHaveBeenCalled()
    // The question is closed: the next message is a normal one.
    expect(await run('mais uma coisa')).toEqual({ consumed: false })
  })

  it('"não" / "pular" / a repeated score close the question without storing a comment', async () => {
    for (const text of ['não', 'pular', '5']) {
      const { state, run } = setup(answered)
      expect(await run(text)).toMatchObject({ consumed: true, kind: 'declined' })
      expect(state.tables.csat_responses[0].comment).toBeNull()
      expect(state.tables.csat_responses[0].comment_received_at).toBe(NOW.toISOString())
    }
  })

  it('a question is a new request, not a comment', async () => {
    const { state, run } = setup(answered)
    expect(await run('E o meu reembolso, quando sai?')).toEqual({ consumed: false })
    expect(state.tables.csat_responses[0].comment_received_at).toBeNull()
  })

  it('after 24 h the comment question is over', async () => {
    const { run } = setup({ status: 'answered', extra: { score: 4, comment_requested_at: hoursAgo(25), comment_received_at: null } })
    expect(await run('tarde demais')).toEqual({ consumed: false })
  })

  it('an answered survey that never asked for a comment consumes nothing', async () => {
    const { run } = setup({ status: 'answered', extra: { score: 4, comment_requested_at: null } })
    expect(await run('oi')).toEqual({ consumed: false })
  })
})
