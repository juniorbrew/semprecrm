import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  notify: vi.fn(async () => ({ users: 1, sent: 1, failed: 0, removed: 0, configured: true })),
  configured: true,
}))

vi.mock('@/lib/push/notify', () => ({ notifySlaBreached: h.notify }))
vi.mock('@/lib/push/send', () => ({ isPushConfigured: () => h.configured }))

import { runSlaTick, type SlaTickRow } from './sla-cron'

const row = (over: Partial<SlaTickRow> = {}): SlaTickRow => ({
  conversation_id: 'c1',
  account_id: 'acc',
  contact_id: 'k1',
  assigned_agent_id: 'u1',
  stage: 'breached',
  kind: 'first_response',
  ...over,
})

/**
 * sla_tick() returns only the events it just created (unique index in SQL),
 * so the second call of a pair returns nothing: that is the idempotency
 * contract the cron relies on.
 */
function db(calls: SlaTickRow[][]) {
  const rpc = vi.fn(async () => ({ data: calls.shift() ?? [], error: null }))
  return { rpc } as never
}

describe('runSlaTick', () => {
  beforeEach(() => {
    h.notify.mockClear()
    h.configured = true
  })

  it('counts warnings without pushing, and pushes once per breach to the assignee', async () => {
    const out = await runSlaTick(db([[row({ stage: 'warning' }), row({ conversation_id: 'c2' }), row({ conversation_id: 'c3', assigned_agent_id: null, kind: 'resolution' })]]))
    expect(out).toEqual({ warnings: 1, breaches: 2, notified: 2 })
    expect(h.notify).toHaveBeenCalledTimes(2)
    expect(h.notify).toHaveBeenNthCalledWith(1, expect.anything(), { accountId: 'acc', conversationId: 'c2', assigneeUserId: 'u1', kind: 'first_response' })
    // Unassigned: the notifier gets null and addresses the admins.
    expect(h.notify).toHaveBeenNthCalledWith(2, expect.anything(), { accountId: 'acc', conversationId: 'c3', assigneeUserId: null, kind: 'resolution' })
  })

  it('a repeated tick finds nothing new: no second push', async () => {
    const d = db([[row()], []])
    expect((await runSlaTick(d)).breaches).toBe(1)
    expect(await runSlaTick(d)).toEqual({ warnings: 0, breaches: 0, notified: 0 })
    expect(h.notify).toHaveBeenCalledTimes(1)
  })

  it('passes the clock to the database function', async () => {
    const d = db([[]])
    await runSlaTick(d, new Date('2026-03-02T15:00:00Z'))
    expect((d as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc).toHaveBeenCalledWith('sla_tick', { p_now: '2026-03-02T15:00:00.000Z' })
  })

  it('without VAPID keys the events are still recorded, only the push is skipped', async () => {
    h.configured = false
    const out = await runSlaTick(db([[row()]]))
    expect(out).toEqual({ warnings: 0, breaches: 1, notified: 0 })
    expect(h.notify).not.toHaveBeenCalled()
  })

  it('reads a missing function (migration not applied) or an error as nothing to do', async () => {
    const missing = { rpc: async () => ({ data: null, error: { code: '42883', message: 'function sla_tick does not exist' } }) } as never
    expect(await runSlaTick(missing)).toEqual({ warnings: 0, breaches: 0, notified: 0 })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const broken = { rpc: async () => ({ data: null, error: { code: 'XX000', message: 'boom' } }) } as never
    expect(await runSlaTick(broken)).toEqual({ warnings: 0, breaches: 0, notified: 0 })
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
