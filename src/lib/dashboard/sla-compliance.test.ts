import { describe, expect, it, vi } from 'vitest'

import { complianceResult, loadSlaCompliance } from './sla-compliance'

// The verdict rules and the exact counting are SQL (sla_compliance) and covered by
// supabase/tests/support_sla_teams.sql; here: the percent and the RPC contract.
describe('complianceResult', () => {
  it('rounds to a whole percent and is null when nothing was judged', () => {
    expect(complianceResult(30, 1, 2)).toEqual({ period: 30, met: 1, missed: 2, percent: 33 })
    expect(complianceResult(7, 2, 0).percent).toBe(100)
    expect(complianceResult(90, 0, 4).percent).toBe(0)
    expect(complianceResult(30, 0, 0)).toEqual({ period: 30, met: 0, missed: 0, percent: null })
  })
})

describe('loadSlaCompliance', () => {
  const NOW = new Date('2026-09-30T12:00:00Z')

  it('asks the database for the exact counts of the period (no row sampling)', async () => {
    const rpc = vi.fn<(name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: null }>>(async () => ({ data: [{ met: '120000', missed: 30000 }], error: null }))
    const out = await loadSlaCompliance({ rpc } as never, 'acc', 7, NOW)
    expect(out).toEqual({ period: 7, met: 120000, missed: 30000, percent: 80 })
    expect(rpc).toHaveBeenCalledTimes(1)
    const [name, args] = rpc.mock.calls[0] as unknown as [string, { p_account_id: string; p_since: string; p_now: string }]
    expect(name).toBe('sla_compliance')
    expect(args.p_account_id).toBe('acc')
    expect(args.p_now).toBe(NOW.toISOString())
    expect(Date.parse(args.p_since)).toBeLessThanOrEqual(NOW.getTime() - 5 * 86_400_000)
    expect(Date.parse(args.p_since)).toBeGreaterThan(NOW.getTime() - 8 * 86_400_000)
  })

  it('an empty answer is zero verdicts', async () => {
    expect(await loadSlaCompliance({ rpc: async () => ({ data: [], error: null }) } as never, 'acc', 30, NOW)).toMatchObject({ met: 0, missed: 0, percent: null })
    expect(await loadSlaCompliance({ rpc: async () => ({ data: null, error: null }) } as never, 'acc', 30, NOW)).toMatchObject({ percent: null })
  })

  it('throws the database error', async () => {
    await expect(loadSlaCompliance({ rpc: async () => ({ data: null, error: new Error('boom') }) } as never, 'acc', 30, NOW)).rejects.toThrow('boom')
  })
})
