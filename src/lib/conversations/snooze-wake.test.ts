import { beforeEach, describe, expect, it, vi } from 'vitest'

const notifySpy = vi.hoisted(() => vi.fn(async () => ({ users: 1, sent: 1, failed: 0, removed: 0, configured: true })))
const configured = vi.hoisted(() => ({ value: true }))
vi.mock('@/lib/push/notify', () => ({ notifySnoozeWoke: notifySpy }))
vi.mock('@/lib/push/send', () => ({ isPushConfigured: () => configured.value }))

import { runSnoozeWake, WAKE_BATCH, WAKE_MAX_BATCHES, type WokenRow } from './snooze-wake'

const row = (i: number): WokenRow => ({
  conversation_id: `c${i}`,
  account_id: 'acc',
  contact_id: 'ct',
  assigned_agent_id: i % 2 ? 'ag' : null,
  snoozed_by: 'sn',
  snooze_note: 'nota',
})
const rows = (n: number) => Array.from({ length: n }, (_, i) => row(i))

function db(batches: { data?: WokenRow[]; error?: { code?: string; message: string } }[]) {
  const rpc = vi.fn(async () => batches.shift() ?? { data: [], error: null })
  return { rpc } as unknown as Parameters<typeof runSnoozeWake>[0] & { rpc: typeof rpc }
}

describe('runSnoozeWake', () => {
  beforeEach(() => {
    configured.value = true
  })

  it('wakes one batch, pushes each woken conversation with its recipients data', async () => {
    const d = db([{ data: rows(2) }])
    const now = new Date('2026-10-04T12:00:00Z')
    expect(await runSnoozeWake(d, now)).toEqual({ woken: 2, notified: 2, errors: 0 })
    expect(d.rpc).toHaveBeenCalledTimes(1)
    expect(d.rpc).toHaveBeenCalledWith('conversation_snooze_wake_due', { p_now: now.toISOString(), p_limit: WAKE_BATCH })
    expect(notifySpy).toHaveBeenCalledWith(d, {
      accountId: 'acc',
      conversationId: 'c1',
      contactId: 'ct',
      assigneeUserId: 'ag',
      snoozedBy: 'sn',
      snoozeNote: 'nota',
    })
  })

  it('loops while batches come back full, capped per call', async () => {
    const d = db([{ data: rows(WAKE_BATCH) }, { data: rows(3) }])
    expect((await runSnoozeWake(d)).woken).toBe(WAKE_BATCH + 3)
    expect(d.rpc).toHaveBeenCalledTimes(2)

    const full = db(Array.from({ length: WAKE_MAX_BATCHES + 5 }, () => ({ data: rows(WAKE_BATCH) })))
    expect((await runSnoozeWake(full)).woken).toBe(WAKE_BATCH * WAKE_MAX_BATCHES)
    expect(full.rpc).toHaveBeenCalledTimes(WAKE_MAX_BATCHES)
  })

  it('treats a missing function as nothing to do, counts other errors and keeps earlier batches', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await runSnoozeWake(db([{ error: { code: 'PGRST202', message: 'not found' } }]))).toEqual({
      woken: 0,
      notified: 0,
      errors: 0,
    })
    const d = db([{ data: rows(WAKE_BATCH) }, { error: { code: '57014', message: 'timeout' } }])
    expect(await runSnoozeWake(d)).toEqual({ woken: WAKE_BATCH, notified: WAKE_BATCH, errors: 1 })
    expect(err).toHaveBeenCalledTimes(1)
    err.mockRestore()
  })

  it('skips pushes when push is not configured or nothing woke; a push with no delivery is not counted', async () => {
    configured.value = false
    expect(await runSnoozeWake(db([{ data: rows(2) }]))).toEqual({ woken: 2, notified: 0, errors: 0 })
    configured.value = true
    expect(await runSnoozeWake(db([{ data: [] }]))).toEqual({ woken: 0, notified: 0, errors: 0 })
    expect(notifySpy).not.toHaveBeenCalled()
    notifySpy.mockResolvedValueOnce({ users: 0, sent: 0, failed: 0, removed: 0, configured: true })
    expect(await runSnoozeWake(db([{ data: rows(2) }]))).toEqual({ woken: 2, notified: 1, errors: 0 })
  })
})
