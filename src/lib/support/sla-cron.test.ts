import { beforeEach, describe, expect, it, vi } from 'vitest'

type PushResult = { users: number; sent: number; failed: number; removed: number; configured: boolean }
const ok: PushResult = { users: 1, sent: 1, failed: 0, removed: 0, configured: true }

const h = vi.hoisted(() => ({
  notify: vi.fn<(db: unknown, notice: Record<string, unknown>) => Promise<PushResult>>(async () => ({ users: 1, sent: 1, failed: 0, removed: 0, configured: true })),
  configured: true,
}))

vi.mock('@/lib/push/notify', () => ({ notifySlaBreached: h.notify }))
vi.mock('@/lib/push/send', () => ({ isPushConfigured: () => h.configured }))

import { PUSH_CONCURRENCY, PUSH_PER_TICK, runSlaTick, type SlaPendingPush, type SlaTickRow } from './sla-cron'

const tickRow = (over: Partial<SlaTickRow> = {}): SlaTickRow => ({
  event_id: 'e1',
  conversation_id: 'c1',
  account_id: 'acc',
  contact_id: 'k1',
  assigned_agent_id: 'u1',
  stage: 'breached',
  kind: 'first_response',
  ...over,
})
const owed = (n: number, over: Partial<SlaPendingPush> = {}): SlaPendingPush[] =>
  Array.from({ length: n }, (_, i) => ({ event_id: `e${i}`, conversation_id: `c${i}`, account_id: 'acc', assigned_agent_id: 'u1', kind: 'first_response' as const, ...over }))

/** A fake database: sla_tick (created rows), sla_pending_push (owed) and sla_mark_pushed. */
function db(opts: { ticks?: SlaTickRow[][]; owed?: SlaPendingPush[][] }) {
  const ticks = [...(opts.ticks ?? [])]
  const owedQ = [...(opts.owed ?? [])]
  const marked: string[][] = []
  const rpc = vi.fn(async (name: string, args?: Record<string, unknown>) => {
    if (name === 'sla_tick') return { data: ticks.shift() ?? [], error: null }
    if (name === 'sla_pending_push') return { data: owedQ.shift() ?? [], error: null }
    if (name === 'sla_mark_pushed') {
      marked.push(args!.p_event_ids as string[])
      return { data: (args!.p_event_ids as string[]).length, error: null }
    }
    throw new Error(name)
  })
  return { client: { rpc } as never, rpc, marked }
}

describe('runSlaTick', () => {
  beforeEach(() => {
    h.notify.mockReset()
    h.notify.mockImplementation(async () => ok)
    h.configured = true
  })

  it('counts warnings / breaches / errors and pushes each owed breach once, then marks it', async () => {
    const d = db({
      ticks: [[tickRow({ stage: 'warning', event_id: 'w' }), tickRow(), tickRow({ conversation_id: 'c2', event_id: 'e2' }), tickRow({ event_id: null, stage: 'error', conversation_id: 'bad' })]],
      owed: [owed(2, { assigned_agent_id: null, kind: 'resolution' })],
    })
    const out = await runSlaTick(d.client)
    expect(out).toEqual({ warnings: 1, breaches: 2, errors: 1, notified: 2, attempted: 2 })
    expect(h.notify).toHaveBeenNthCalledWith(1, expect.anything(), { accountId: 'acc', conversationId: 'c0', assigneeUserId: null, kind: 'resolution' })
    expect(d.marked).toEqual([['e0', 'e1']])
  })

  it('a repeated tick with nothing new and nothing owed pushes nothing', async () => {
    const d = db({ ticks: [[tickRow()], []], owed: [owed(1), []] })
    await runSlaTick(d.client)
    const again = await runSlaTick(d.client)
    expect(again).toEqual({ warnings: 0, breaches: 0, errors: 0, notified: 0, attempted: 0 })
    expect(h.notify).toHaveBeenCalledTimes(1)
  })

  it('a failed delivery is NOT marked, so the next tick offers it again', async () => {
    h.notify.mockImplementationOnce(async () => ({ users: 1, sent: 0, failed: 1, removed: 0, configured: true }))
    const d = db({ owed: [owed(2)] })
    const out = await runSlaTick(d.client)
    expect(out).toMatchObject({ attempted: 2, notified: 1 })
    expect(d.marked).toEqual([['e1']])
  })

  it('a thrown push is retried too; nobody to notify is final', async () => {
    h.notify
      .mockImplementationOnce(async () => {
        throw new Error('network')
      })
      .mockImplementationOnce(async () => ({ users: 0, sent: 0, failed: 0, removed: 0, configured: true }))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const d = db({ owed: [owed(2)] })
    await runSlaTick(d.client)
    expect(d.marked).toEqual([['e1']])
    spy.mockRestore()
  })

  it('bounds concurrency and the batch per tick', async () => {
    let inFlight = 0
    let peak = 0
    h.notify.mockImplementation(async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 2))
      inFlight -= 1
      return ok
    })
    const d = db({ owed: [owed(PUSH_PER_TICK + 40)] })
    const out = await runSlaTick(d.client)
    expect(out.attempted).toBe(PUSH_PER_TICK)
    expect(h.notify).toHaveBeenCalledTimes(PUSH_PER_TICK)
    expect(peak).toBe(PUSH_CONCURRENCY)
    expect(d.rpc).toHaveBeenCalledWith('sla_pending_push', { p_limit: PUSH_PER_TICK })
  })

  it('passes the clock to the database function', async () => {
    const d = db({ ticks: [[]] })
    await runSlaTick(d.client, new Date('2026-03-02T15:00:00Z'))
    expect(d.rpc).toHaveBeenCalledWith('sla_tick', { p_now: '2026-03-02T15:00:00.000Z' })
  })

  it('without VAPID keys the events are recorded and stay owed (no read, no mark)', async () => {
    h.configured = false
    const d = db({ ticks: [[tickRow()]], owed: [owed(1)] })
    const out = await runSlaTick(d.client)
    expect(out).toEqual({ warnings: 0, breaches: 1, errors: 0, notified: 0, attempted: 0 })
    expect(h.notify).not.toHaveBeenCalled()
    expect(d.rpc).not.toHaveBeenCalledWith('sla_pending_push', expect.anything())
  })

  it('reads a missing function (migration not applied) or an error as nothing to do', async () => {
    const missing = { rpc: async () => ({ data: null, error: { code: '42883', message: 'function sla_tick does not exist' } }) } as never
    expect(await runSlaTick(missing)).toMatchObject({ warnings: 0, breaches: 0, errors: 0 })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const broken = { rpc: async () => ({ data: null, error: { code: 'XX000', message: 'boom' } }) } as never
    expect(await runSlaTick(broken)).toMatchObject({ breaches: 0 })
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
