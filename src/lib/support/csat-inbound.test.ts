import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/automations/event-queue', () => ({ drainAutomationEvents: vi.fn(async () => ({ processed: 0, failed: 0 })) }))
vi.mock('@/lib/automations/meta-send', () => ({ engineSendText: vi.fn(async () => ({ whatsapp_message_id: 'x' })) }))

import { CSAT_COMMENT_PROMPT } from './csat'
import { tryConsumeCsat, type CsatInboundInput } from './csat-inbound'
import { makeFakeDb } from './csat-fake-db'

const NOW = new Date('2026-09-30T12:00:00Z')
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString()
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString()

interface Opts {
  sentHoursAgo?: number
  status?: string
  ask?: boolean
  conversations?: CsatInboundInput['conversations']
  extra?: Record<string, unknown>
  /** Outbound messages of the contact, oldest first (default: the survey itself). */
  outbound?: Record<string, unknown>[]
  flowRuns?: Record<string, unknown>[]
}

function setup(opts: Opts = {}) {
  const { db, state } = makeFakeDb({
    csat_responses: [
      {
        id: 'r1',
        account_id: 'acc',
        contact_id: 'k1',
        conversation_id: 'conv-1',
        status: opts.status ?? 'sent',
        score: null,
        sent_at: hoursAgo(opts.sentHoursAgo ?? 1),
        ...opts.extra,
      },
    ],
    csat_settings: [{ account_id: 'acc', enabled: true, ask_comment: opts.ask ?? true, thanks_text: 'Valeu!' }],
    messages: opts.outbound ?? [{ id: 'm-survey', conversation_id: 'conv-1', sender_type: 'bot', origin: 'csat', created_at: hoursAgo(1) }],
    flow_runs: opts.flowRuns ?? [],
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
  const stored = () => (state.tables.messages ?? []).filter((m) => m.sender_type === 'customer')
  return { db, state, send, drain, run, stored }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('tryConsumeCsat: the score', () => {
  it('a lone score is consumed: recorded, stored (origin csat) in the closed conversation, thanked, automations drained', async () => {
    const { state, send, drain, run, stored } = setup()
    const out = await run('5')
    expect(out).toEqual({ consumed: true, conversationId: 'conv-1', kind: 'score', score: 5 })
    expect(state.tables.csat_responses[0]).toMatchObject({ status: 'answered', score: 5 })
    expect(stored()).toEqual([expect.objectContaining({ conversation_id: 'conv-1', origin: 'csat', content_text: '5', status: 'delivered' })])
    expect(state.tables.conversation_events).toEqual([expect.objectContaining({ event_type: 'csat_answered', payload: { score: 5 } })])
    await flush()
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'conv-1', origin: 'csat', text: `Valeu!\n\n${CSAT_COMMENT_PROMPT}` }))
    expect(drain).toHaveBeenCalledWith({ accountId: 'acc' })
  })

  it('the comment question only counts once it was really SENT', async () => {
    const ok = setup()
    await ok.run('4')
    await flush()
    expect(ok.state.tables.csat_responses[0].comment_requested_at).toBeTruthy()

    const failed = setup()
    failed.send.mockRejectedValueOnce(new Error('window closed'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const out = await failed.run('4')
    await flush()
    spy.mockRestore()
    expect(out).toMatchObject({ consumed: true, kind: 'score' })
    expect(failed.state.tables.csat_responses[0]).toMatchObject({ status: 'answered', score: 4 })
    expect(failed.state.tables.csat_responses[0].comment_requested_at ?? null).toBeNull()
    // No question went out, so the next message is no comment.
    expect(await failed.run('foi rápido')).toEqual({ consumed: false })
  })

  it('no comment question when the account turned it off', async () => {
    const { send, state, run } = setup({ ask: false })
    await run('4')
    await flush()
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: 'Valeu!' }))
    expect(state.tables.csat_responses[0].comment_requested_at ?? null).toBeNull()
  })

  it.each([['quanto custa o frete?'], ['uma'], ['preciso de ajuda com meu pedido'], ['']])('%j is NOT consumed and the survey keeps waiting', async (text) => {
    const { state, send, run, stored } = setup()
    expect(await run(text)).toEqual({ consumed: false })
    expect(state.tables.csat_responses[0].status).toBe('sent')
    expect(stored()).toEqual([])
    await flush()
    expect(send).not.toHaveBeenCalled()
  })

  it.each([['obrigado'], ['ótimo'], ['10'], ['nota 10'], ['valeu'], ['👍👍'], ['Muito obrigada!']])(
    'a polite non-score reply %j is stored only: no reopen, no flow, the survey keeps waiting',
    async (text) => {
      const { state, send, run, stored } = setup()
      expect(await run(text)).toEqual({ consumed: true, conversationId: 'conv-1', kind: 'polite' })
      expect(stored()).toEqual([expect.objectContaining({ origin: 'csat', content_text: text })])
      expect(state.tables.csat_responses[0].status).toBe('sent')
      await flush()
      expect(send).not.toHaveBeenCalled()
    },
  )

  it('"5 mas demorou": records the score AND the comment, thanks, but flows normally (not consumed, not stored twice)', async () => {
    const { state, send, run, stored } = setup()
    expect(await run('5 mas demorou')).toEqual({ consumed: false })
    expect(state.tables.csat_responses[0]).toMatchObject({ status: 'answered', score: 5, comment: 'mas demorou' })
    expect(state.tables.csat_responses[0].comment_received_at).toBeTruthy()
    expect(stored()).toEqual([])
    await flush()
    // The thanks only: the comment was already given.
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: 'Valeu!' }))
  })

  it('a score with a question is a normal message and records nothing', async () => {
    const { state, run } = setup()
    expect(await run('5 mas e o meu pedido, quando chega?')).toEqual({ consumed: false })
    expect(state.tables.csat_responses[0].status).toBe('sent')
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

  it('is not consumed while the contact has a live conversation', async () => {
    const { state, run } = setup({ conversations: [{ id: 'conv-2', status: 'open' }, { id: 'conv-1', status: 'closed' }] })
    expect(await run('5')).toEqual({ consumed: false })
    expect(state.tables.csat_responses[0].status).toBe('sent')
  })

  it('is not consumed when the surveyed conversation was reopened', async () => {
    const { run } = setup({ conversations: [{ id: 'conv-1', status: 'pending' }] })
    expect(await run('5')).toEqual({ consumed: false })
  })

  it('is not consumed when something else was sent after the survey (a flow menu, a broadcast)', async () => {
    const { run, state } = setup({
      outbound: [
        { id: 'm1', conversation_id: 'conv-1', sender_type: 'bot', origin: 'csat', created_at: hoursAgo(1) },
        { id: 'm2', conversation_id: 'conv-1', sender_type: 'bot', origin: 'flow', created_at: minutesAgo(10) },
      ],
    })
    expect(await run('1')).toEqual({ consumed: false })
    expect(state.tables.csat_responses[0].status).toBe('sent')
  })

  it('is not consumed while a flow run is active for the contact', async () => {
    const { run } = setup({ flowRuns: [{ id: 'f1', account_id: 'acc', contact_id: 'k1', status: 'active' }] })
    expect(await run('2')).toEqual({ consumed: false })
  })

  it('the same reply delivered twice records ONE answer, and the loser stops as a duplicate (no ghost conversation)', async () => {
    const { state, send, run, stored } = setup({ ask: false })
    const first = await run('5', { messageId: 'dup-1' })
    expect(first).toMatchObject({ consumed: true })
    // Redelivery: the survey is no longer waiting, but the message IS stored -> stop.
    const second = await run('5', { messageId: 'dup-1' })
    expect(second).toEqual({ consumed: false }) // the pipeline's own dedupe handles stored ids first
    expect(state.tables.csat_responses[0].score).toBe(5)
    expect(stored()).toHaveLength(1)
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('a concurrent delivery that loses the race but finds its message stored is a duplicate: consumed, nothing else', async () => {
    const { db, state, run } = setup()
    // The winner already answered and stored this very provider message.
    state.tables.messages.push({ id: 'won', conversation_id: 'conv-1', sender_type: 'customer', message_id: 'race-1', origin: 'csat' })
    const realRpc = db.rpc
    db.rpc = async (name: string, args: Record<string, unknown>) => (name === 'csat_record_answer' ? { data: [], error: null } : realRpc(name, args))
    expect(await run('5', { messageId: 'race-1' })).toMatchObject({ consumed: true, kind: 'score' })
    // A different message that loses the race is a normal one.
    expect(await run('5', { messageId: 'other' })).toEqual({ consumed: false })
  })

  it('any error falls through as a normal message (never lost)', async () => {
    const { db } = makeFakeDb({})
    const broken = { ...db, from: () => { throw new Error('boom') } }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const out = await tryConsumeCsat(broken as never, { accountId: 'a', contactId: 'k', conversations: [{ id: 'c', status: 'closed' }], type: 'text', text: '5', messageId: 'm', createdAt: NOW.toISOString(), channel: 'qr', userId: 'u' }, NOW)
    spy.mockRestore()
    expect(out).toEqual({ consumed: false })
  })

  it('if storing the consumed answer fails, the message is not consumed (it flows)', async () => {
    const { state, run } = setup({ ask: false })
    state.failInsert = { messages: { code: 'XX000', message: 'disk full' } }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await run('5')).toEqual({ consumed: false })
    spy.mockRestore()
  })

  it('a missing survey for this contact carries on as a normal message', async () => {
    const { run } = setup({ conversations: [{ id: 'other', status: 'closed' }] })
    expect(await run('5')).toEqual({ consumed: false })
  })

  it('a failed thanks message never undoes the score', async () => {
    const { state, send, run } = setup()
    send.mockRejectedValueOnce(new Error('window closed'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const out = await run('5')
    await flush()
    spy.mockRestore()
    expect(out).toMatchObject({ consumed: true, kind: 'score' })
    expect(state.tables.csat_responses[0].status).toBe('answered')
  })
})

describe('tryConsumeCsat: the comment (10 minutes, short, never a request)', () => {
  const asked = (over: Record<string, unknown> = {}, minutes = 2) => ({
    status: 'answered',
    outbound: [{ id: 'm-thanks', conversation_id: 'conv-1', sender_type: 'bot', origin: 'csat', created_at: minutesAgo(minutes) }],
    extra: { score: 4, comment_requested_at: minutesAgo(minutes), comment_received_at: null, ...over },
  })

  it('a short neutral text is stored as the comment, once, store only', async () => {
    const { state, send, run, stored } = setup(asked())
    expect(await run('A Joana foi muito atenciosa')).toEqual({ consumed: true, conversationId: 'conv-1', kind: 'comment' })
    expect(state.tables.csat_responses[0]).toMatchObject({ comment: 'A Joana foi muito atenciosa' })
    expect(stored()).toEqual([expect.objectContaining({ origin: 'csat' })])
    await flush()
    expect(send).not.toHaveBeenCalled()
    // The question is closed: the next message is a normal one.
    expect(await run('mais uma coisa')).toEqual({ consumed: false })
  })

  it('"não" / "pular" / a repeated score only close the question', async () => {
    for (const text of ['não', 'pular', '5', 'nada']) {
      const { state, run } = setup(asked())
      expect(await run(text)).toMatchObject({ consumed: true, kind: 'declined' })
      expect(state.tables.csat_responses[0].comment).toBeNull()
      expect(state.tables.csat_responses[0].comment_received_at).toBe(NOW.toISOString())
    }
  })

  it.each([
    ['E o meu reembolso, quando sai?'],
    ['a'.repeat(201)],
  ])('%j is a normal message and records nothing', async (text) => {
    const { state, run } = setup(asked())
    expect(await run(text)).toEqual({ consumed: false })
    expect(state.tables.csat_responses[0].comment_received_at).toBeNull()
  })

  it.each([['preciso da segunda via do boleto'], ['quero cancelar'], ['meu pedido não chegou'], ['isso não funciona']])(
    'a request such as %j is recorded as the comment AND flows normally (stored once, by the pipeline)',
    async (text) => {
      const { state, run, stored } = setup(asked())
      expect(await run(text)).toEqual({ consumed: false })
      expect(state.tables.csat_responses[0]).toMatchObject({ comment: text })
      expect(stored()).toEqual([])
    },
  )

  it('after a score of 1-2 the comment is recorded and flows (an unhappy customer may be asking for help)', async () => {
    const { state, run, stored } = setup(asked({ score: 2 }))
    expect(await run('muito demorado')).toEqual({ consumed: false })
    expect(state.tables.csat_responses[0].comment).toBe('muito demorado')
    expect(stored()).toEqual([])
  })

  it('after 10 minutes the comment question is over', async () => {
    const { run } = setup(asked({}, 11))
    expect(await run('tarde demais')).toEqual({ consumed: false })
  })

  it('an answered survey whose question never went out consumes nothing', async () => {
    const { run } = setup({ status: 'answered', extra: { score: 4, comment_requested_at: null } })
    expect(await run('oi')).toEqual({ consumed: false })
  })
})
