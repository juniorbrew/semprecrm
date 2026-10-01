import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/automations/meta-send', () => ({ engineSendText: vi.fn() }))

import { runCsatCron } from './csat-cron'
import { makeFakeDb } from './csat-fake-db'

const NOW = new Date('2026-09-30T12:00:00Z')
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString()

function setup(over: { conv?: Record<string, unknown>; contact?: Record<string, unknown>; settings?: Record<string, unknown> | null; extra?: Record<string, unknown[]> } = {}) {
  const { db, state } = makeFakeDb({
    csat_jobs: [{ id: 1, account_id: 'acc', conversation_id: 'conv-1', service_count: 1, run_at: minutesAgo(1), attempts: 0 }],
    conversations: [
      {
        id: 'conv-1',
        account_id: 'acc',
        user_id: 'owner',
        contact_id: 'k1',
        status: 'closed',
        service_count: 1,
        resolution: 'resolved',
        category_id: 'cat-1',
        team_id: 'team-1',
        priority: 'high',
        assigned_agent_id: 'agent-1',
        channel: 'official',
        last_customer_message_at: minutesAgo(30),
        ...over.conv,
      },
    ],
    contacts: [{ id: 'k1', account_id: 'acc', phone: '5511999990000', opted_out_at: null, anonymized_at: null, ...over.contact }],
    csat_settings: over.settings === null ? [] : [{ account_id: 'acc', enabled: true, message_text: 'Como foi?', ...over.settings }],
    ...over.extra,
  })
  const send = vi.fn(async () => ({ whatsapp_message_id: 'wamid-out' }))
  const run = (now = NOW) => runCsatCron(db, now, send as never)
  return { state, send, run }
}

describe('runCsatCron', () => {
  it('sends the survey as origin csat, snapshots the conversation and logs csat_sent', async () => {
    const { state, send, run } = setup()
    const out = await run()
    expect(out).toMatchObject({ claimed: 1, sent: 1, skipped: 0, errors: 0 })
    expect(send).toHaveBeenCalledWith({ accountId: 'acc', userId: 'owner', conversationId: 'conv-1', contactId: 'k1', text: 'Como foi?', origin: 'csat' })
    expect(state.tables.csat_responses).toEqual([
      expect.objectContaining({
        conversation_id: 'conv-1',
        contact_id: 'k1',
        status: 'sent',
        team_id: 'team-1',
        category_id: 'cat-1',
        priority: 'high',
        assigned_agent_id: 'agent-1',
        message_id: 'wamid-out',
      }),
    ])
    expect(state.tables.conversation_events).toEqual([expect.objectContaining({ event_type: 'csat_sent', conversation_id: 'conv-1' })])
    expect(state.tables.csat_jobs[0]).toMatchObject({ result: 'sent', processed_at: NOW.toISOString() })
  })

  it('is idempotent: a repeated tick sends nothing more', async () => {
    const { send, run } = setup()
    await run()
    const again = await run(new Date(NOW.getTime() + 60_000))
    expect(again).toMatchObject({ claimed: 0, sent: 0 })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('a second job for the same conversation (reopened and resolved again) never sends a second survey', async () => {
    const { state, send, run } = setup({
      extra: { csat_responses: [{ id: 'old', conversation_id: 'conv-1', contact_id: 'zzz', status: 'answered', score: 5, sent_at: minutesAgo(5000) }] },
    })
    const out = await run()
    expect(out).toMatchObject({ sent: 0, skipped: 1 })
    expect(state.tables.csat_jobs[0].result).toBe('duplicate')
    expect(send).not.toHaveBeenCalled()
  })

  it('does not claim a job that is not due yet', async () => {
    const { send, state, run } = setup()
    state.tables.csat_jobs[0].run_at = new Date(NOW.getTime() + 60_000).toISOString()
    expect(await run()).toMatchObject({ claimed: 0 })
    expect(send).not.toHaveBeenCalled()
  })

  describe('skips, with the reason', () => {
    it.each([
      ['reopened before the send', { conv: { status: 'open' } }, 'reopened', false],
      ['reopened and resolved again', { conv: { service_count: 2 } }, 'reopened', false],
      ['survey turned off', { settings: { enabled: false } }, 'disabled', false],
      ['no settings row', { settings: null }, 'disabled', false],
      ['excluded resolution', { conv: { resolution: 'duplicate' } }, 'resolution_excluded', false],
      ['other category', { settings: { only_categories: ['cat-9'] } }, 'category_excluded', false],
      ['opted-out contact', { contact: { opted_out_at: '2026-09-01T00:00:00Z' } }, 'opted_out', true],
      ['anonymised contact', { contact: { anonymized_at: '2026-09-01T00:00:00Z' } }, 'opted_out', true],
      ['no customer message', { conv: { last_customer_message_at: null } }, 'no_customer_message', true],
      ['Meta window closed', { conv: { last_customer_message_at: minutesAgo(25 * 60) } }, 'window_closed', true],
    ])('%s -> %s', async (_label, over, reason, leavesRow) => {
      const { state, send, run } = setup(over as never)
      const out = await run()
      expect(out).toMatchObject({ sent: 0, skipped: 1, errors: 0 })
      expect(send).not.toHaveBeenCalled()
      expect(state.tables.csat_jobs[0]).toMatchObject({ result: reason, processed_at: NOW.toISOString() })
      // Conversation-state skips leave no row (it may be surveyed after another resolve); the rest are recorded.
      const rows = state.tables.csat_responses ?? []
      expect(rows.length).toBe(leavesRow ? 1 : 0)
      if (leavesRow) expect(rows[0]).toMatchObject({ status: 'skipped', skip_reason: reason })
    })

    it('QR conversations have no 24 h window', async () => {
      const { send, run } = setup({ conv: { channel: 'qr', last_customer_message_at: minutesAgo(25 * 60) } })
      expect(await run()).toMatchObject({ sent: 1 })
      expect(send).toHaveBeenCalled()
    })

    it('per-contact cooldown counts surveys really sent (not skipped ones)', async () => {
      const sent = { id: 'p', conversation_id: 'conv-0', contact_id: 'k1', status: 'answered', sent_at: minutesAgo(3 * 24 * 60) }
      const a = setup({ extra: { csat_responses: [sent] } })
      expect(await a.run()).toMatchObject({ sent: 0, skipped: 1 })
      expect(a.state.tables.csat_jobs[0].result).toBe('cooldown')

      const b = setup({ extra: { csat_responses: [{ ...sent, status: 'skipped' }] } })
      expect(await b.run()).toMatchObject({ sent: 1 })

      const c = setup({ extra: { csat_responses: [{ ...sent, sent_at: minutesAgo(8 * 24 * 60) }] } })
      expect(await c.run()).toMatchObject({ sent: 1 })
    })
  })

  it('a failed send removes the reservation and releases the job for another try', async () => {
    const { state, send, run } = setup()
    send.mockRejectedValueOnce(new Error('WhatsApp not configured'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const out = await run()
    spy.mockRestore()
    expect(out).toMatchObject({ sent: 0, errors: 1 })
    expect(state.tables.csat_responses).toEqual([])
    expect(state.tables.csat_jobs[0]).toMatchObject({ claimed_at: null, attempts: 1 })
    expect(state.tables.csat_jobs[0].processed_at).toBeUndefined()
    // The next tick claims it again and succeeds.
    expect(await run()).toMatchObject({ sent: 1, errors: 0 })
    expect(send).toHaveBeenCalledTimes(2)
    expect(state.tables.csat_responses).toHaveLength(1)
  })

  describe('expiry', () => {
    it('surveys unanswered after 48 h expire, answered / recent ones do not', async () => {
      const { state, run } = setup({
        extra: {
          csat_responses: [
            { id: 'a', conversation_id: 'c-a', contact_id: 'x', status: 'sent', sent_at: minutesAgo(49 * 60) },
            { id: 'b', conversation_id: 'c-b', contact_id: 'y', status: 'sent', sent_at: minutesAgo(47 * 60) },
            { id: 'c', conversation_id: 'c-c', contact_id: 'z', status: 'answered', score: 5, sent_at: minutesAgo(100 * 60) },
          ],
        },
      })
      state.tables.csat_jobs = []
      const out = await run()
      expect(out.expired).toBe(1)
      expect(state.tables.csat_responses.map((r) => [r.id, r.status])).toEqual([
        ['a', 'expired'],
        ['b', 'sent'],
        ['c', 'answered'],
      ])
      // Again: nothing left to expire.
      expect((await run()).expired).toBe(0)
    })
  })

  it('a missing migration (no csat functions) is a quiet no-op', async () => {
    const out = await runCsatCron({ rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }) } as never, NOW)
    expect(out).toEqual({ claimed: 0, sent: 0, skipped: 0, errors: 0, expired: 0 })
  })
})

describe('runCsatCron: reserved, uncertain, active, recent, burst (review round)', () => {
  it('the row is reserved first and only flips to sent after the send succeeded', async () => {
    const { state, send, run } = setup()
    let seenDuringSend: unknown = null
    send.mockImplementationOnce(async () => {
      seenDuringSend = state.tables.csat_responses.map((r) => r.status)
      return { whatsapp_message_id: 'wamid-out' }
    })
    await run()
    expect(seenDuringSend).toEqual(['reserved'])
    expect(state.tables.csat_responses[0]).toMatchObject({ status: 'sent', message_id: 'wamid-out' })
  })

  it('an UNCERTAIN send keeps the reservation, finishes the job as uncertain and is never retried', async () => {
    const { GatewayUnreachableError } = await import('@/lib/whatsapp/qr-gateway')
    const { state, send, run } = setup()
    send.mockRejectedValueOnce(new GatewayUnreachableError('timeout'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const out = await run()
    warn.mockRestore()
    expect(out).toMatchObject({ sent: 0, errors: 1 })
    expect(state.tables.csat_responses).toEqual([expect.objectContaining({ status: 'reserved', conversation_id: 'conv-1' })])
    expect(state.tables.csat_jobs[0]).toMatchObject({ result: 'uncertain', processed_at: NOW.toISOString() })
    // The next tick has nothing to claim and sends nothing.
    expect(await run(new Date(NOW.getTime() + 60_000))).toMatchObject({ claimed: 0 })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('a reservation that never became sent is not a survey sent (crash between reserve and send)', async () => {
    const { state, run } = setup()
    state.tables.csat_responses = [{ id: 'x', conversation_id: 'conv-0', contact_id: 'k1', status: 'reserved', sent_at: minutesAgo(5) }]
    // No cooldown from a reserved row: this conversation is surveyed.
    expect(await run()).toMatchObject({ sent: 1 })
  })

  it('cooldown counts expired surveys too (non-responders are not asked again)', async () => {
    const { state, run } = setup({ extra: { csat_responses: [{ id: 'p', conversation_id: 'conv-0', contact_id: 'k1', status: 'expired', sent_at: minutesAgo(3 * 24 * 60) }] } })
    expect(await run()).toMatchObject({ sent: 0, skipped: 1 })
    expect(state.tables.csat_jobs[0].result).toBe('cooldown')
  })

  it('the contact wrote again since the resolve: a live conversation, no survey, no row', async () => {
    const { state, send, run } = setup()
    state.tables.conversations.push({ id: 'conv-new', account_id: 'acc', contact_id: 'k1', status: 'open', created_at: minutesAgo(1), last_customer_message_at: minutesAgo(1) })
    expect(await run()).toMatchObject({ sent: 0, skipped: 1 })
    expect(state.tables.csat_jobs[0].result).toBe('contact_active')
    expect(state.tables.csat_responses ?? []).toEqual([])
    expect(send).not.toHaveBeenCalled()
  })

  it('the Meta window uses the contact\'s newest customer message across conversations', async () => {
    const { state, send, run } = setup({ conv: { last_customer_message_at: minutesAgo(26 * 60) } })
    state.tables.conversations.push({ id: 'conv-newer', account_id: 'acc', contact_id: 'k1', status: 'closed', created_at: minutesAgo(60), last_customer_message_at: minutesAgo(20) })
    expect(await run()).toMatchObject({ sent: 1 })
    expect(send).toHaveBeenCalled()
  })

  it('nobody attended the conversation: skipped (no_agent_message)', async () => {
    const { state, send, run } = setup({ conv: { last_agent_message_at: null } })
    expect(await run()).toMatchObject({ sent: 0, skipped: 1 })
    expect(state.tables.csat_responses[0]).toMatchObject({ status: 'skipped', skip_reason: 'no_agent_message' })
    expect(send).not.toHaveBeenCalled()
  })

  it('the customer wrote long before the close: stale, skipped', async () => {
    const { state, run } = setup({ conv: { channel: 'qr', last_customer_message_at: minutesAgo(80 * 60), resolved_at: minutesAgo(5) } })
    expect(await run()).toMatchObject({ sent: 0, skipped: 1 })
    expect(state.tables.csat_responses[0]).toMatchObject({ skip_reason: 'stale' })
  })

  it('burst cap: past 20 surveys in the last hour the job is put back, not lost and not an attempt', async () => {
    const recent = Array.from({ length: 20 }, (_, i) => ({ id: `b${i}`, account_id: 'acc', conversation_id: `cb${i}`, contact_id: `kb${i}`, status: 'sent', sent_at: minutesAgo(10) }))
    const { state, send, run } = setup({ extra: { csat_responses: recent } })
    expect(await run()).toMatchObject({ claimed: 1, sent: 0 })
    expect(send).not.toHaveBeenCalled()
    expect(state.tables.csat_jobs[0]).toMatchObject({ claimed_at: null, attempts: 0 })
    expect(Date.parse(state.tables.csat_jobs[0].run_at as string)).toBeGreaterThan(NOW.getTime())
    expect(state.tables.csat_jobs[0].processed_at).toBeUndefined()
    // An hour later the window has emptied and it goes out.
    expect(await run(new Date(NOW.getTime() + 2 * 3_600_000))).toMatchObject({ sent: 1 })
  })
})
