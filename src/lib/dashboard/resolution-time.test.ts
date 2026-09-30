import { describe, expect, it } from 'vitest'

import { aggregateResolutionTimes, loadResolutionTime } from './resolution-time'

const row = (created: string, resolved: string | null) => ({ created_at: created, resolved_at: resolved })

describe('aggregateResolutionTimes', () => {
  it('averages resolved_at - created_at and reports the median', () => {
    const r = aggregateResolutionTimes(
      [
        row('2026-09-01T10:00:00Z', '2026-09-01T10:10:00Z'), // 600 s
        row('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z'), // 3600 s
        row('2026-09-01T10:00:00Z', '2026-09-01T10:00:30Z'), // 30 s
      ],
      30,
    )
    expect(r).toEqual({ period: 30, count: 3, avgSeconds: 1410, medianSeconds: 600 })
  })

  it('ignores unresolved rows and impossible durations; empty -> nulls', () => {
    const r = aggregateResolutionTimes([row('2026-09-01T10:00:00Z', null), row('2026-09-02T10:00:00Z', '2026-09-01T10:00:00Z')], 7)
    expect(r).toEqual({ period: 7, count: 0, avgSeconds: null, medianSeconds: null })
  })
})

describe('loadResolutionTime', () => {
  it('reads this account resolved rows since the start of the period', async () => {
    const calls: [string, ...unknown[]][] = []
    const b: Record<string, unknown> = {}
    for (const m of ['select', 'not', 'gte', 'order', 'limit', 'eq']) {
      b[m] = (...args: unknown[]) => {
        calls.push([m, ...args])
        return b
      }
    }
    b.then = (ok: (v: unknown) => unknown) =>
      Promise.resolve({ data: [row('2026-09-01T10:00:00Z', '2026-09-01T10:01:00Z')], error: null }).then(ok)
    const db = { from: () => b }
    const r = await loadResolutionTime(db as never, 'acc', 7)
    expect(r.count).toBe(1)
    expect(calls).toContainEqual(['eq', 'account_id', 'acc'])
    expect(calls).toContainEqual(['not', 'resolved_at', 'is', null])
    expect(calls).toContainEqual(['eq', 'resolved_at_estimated', false])
    expect(calls.some((c) => c[0] === 'gte' && c[1] === 'resolved_at')).toBe(true)
  })
})
