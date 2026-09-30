import { describe, expect, it } from 'vitest'

import { aggregateSlaCompliance, loadSlaCompliance, type SlaComplianceRow } from './sla-compliance'

const NOW = Date.parse('2026-09-30T12:00:00Z')
const SINCE = NOW - 30 * 86_400_000
const at = (h: number) => new Date(NOW + h * 3_600_000).toISOString()

const row = (over: Partial<SlaComplianceRow> = {}): SlaComplianceRow => ({
  status: 'open',
  first_response_at: null,
  first_response_due_at: null,
  resolution_due_at: null,
  resolved_at: null,
  ...over,
})

describe('aggregateSlaCompliance', () => {
  it('counts answered-in-time as met and answered-late / unanswered-past-due as missed', () => {
    const r = aggregateSlaCompliance(
      [
        row({ first_response_due_at: at(-5), first_response_at: at(-6) }), // met
        row({ first_response_due_at: at(-5), first_response_at: at(-4) }), // late
        row({ first_response_due_at: at(-5) }), // unanswered, past due
        row({ first_response_due_at: at(5) }), // still pending: not judged
      ],
      30,
      SINCE,
      NOW,
    )
    expect(r).toEqual({ period: 30, met: 1, missed: 2, percent: 33 })
  })

  it('judges the resolution of closed conversations and open ones past due', () => {
    const r = aggregateSlaCompliance(
      [
        row({ status: 'closed', resolution_due_at: at(-2), resolved_at: at(-3) }), // met
        row({ status: 'closed', resolution_due_at: at(-2), resolved_at: at(-1) }), // late
        row({ status: 'open', resolution_due_at: at(-1) }), // open past due
        row({ status: 'open', resolution_due_at: at(9) }), // pending
        row({ status: 'closed', resolution_due_at: at(-2), resolved_at: null }), // archived while open: no verdict
      ],
      30,
      SINCE,
      NOW,
    )
    expect(r).toMatchObject({ met: 1, missed: 2 })
  })

  it('one conversation can carry two verdicts', () => {
    const r = aggregateSlaCompliance(
      [row({ status: 'closed', first_response_due_at: at(-9), first_response_at: at(-10), resolution_due_at: at(-2), resolved_at: at(-3) })],
      30,
      SINCE,
      NOW,
    )
    expect(r).toEqual({ period: 30, met: 2, missed: 0, percent: 100 })
  })

  it('ignores verdicts that happened before the period and conversations without a policy', () => {
    const old = new Date(SINCE - 86_400_000).toISOString()
    const r = aggregateSlaCompliance(
      [row({ first_response_due_at: old, first_response_at: old }), row({ first_response_due_at: old }), row()],
      30,
      SINCE,
      NOW,
    )
    expect(r).toEqual({ period: 30, met: 0, missed: 0, percent: null })
  })
})

describe('loadSlaCompliance', () => {
  it('reads the account rows with a deadline inside the period', async () => {
    const calls: [string, ...unknown[]][] = []
    const b: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'or', 'limit']) {
      b[m] = (...a: unknown[]) => (calls.push([m, ...a]), b)
    }
    b.then = (ok: (v: unknown) => unknown) =>
      Promise.resolve({ data: [row({ first_response_due_at: at(-5), first_response_at: at(-6) })], error: null }).then(ok)
    const db = { from: () => b } as never
    const out = await loadSlaCompliance(db, 'acc', 7, new Date(NOW))
    expect(out).toMatchObject({ period: 7, met: 1, missed: 0, percent: 100 })
    expect(calls.find((c) => c[0] === 'eq')).toEqual(['eq', 'account_id', 'acc'])
    expect(String(calls.find((c) => c[0] === 'or')?.[1])).toMatch(/first_response_due_at\.gte\..*resolution_due_at\.gte\./)
  })

  it('throws the database error', async () => {
    const b: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'or', 'limit']) b[m] = () => b
    b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: new Error('boom') }).then(ok)
    await expect(loadSlaCompliance({ from: () => b } as never, 'acc', 30)).rejects.toThrow('boom')
  })
})
