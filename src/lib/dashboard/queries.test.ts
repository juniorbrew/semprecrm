import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { loadConversationsSeries, loadPipelineDonut, loadResponseTime } from './queries'
import { lastNDayKeys } from './date-utils'

type Rpc = (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>

function db(rpc: Rpc, stages: unknown[] = []): SupabaseClient {
  const from = () => ({ select: () => ({ order: () => Promise.resolve({ data: stages, error: null }) }) })
  return { rpc: vi.fn(rpc), from } as unknown as SupabaseClient
}

afterEach(() => vi.useRealTimers())

describe('dashboard loaders (migration 084 RPCs)', () => {
  it('series: seeds every day of the range and sends the browser zone', async () => {
    const keys = lastNDayKeys(7)
    const client = db(async () => ({ data: [{ day: keys[2], incoming: 4, outgoing: 1 }], error: null }))
    const series = await loadConversationsSeries(client, 7)

    expect(series).toHaveLength(7)
    expect(series.map((p) => p.day)).toEqual(keys)
    expect(series[2]).toEqual({ day: keys[2], incoming: 4, outgoing: 1 })
    expect(series.filter((p) => p.incoming + p.outgoing === 0)).toHaveLength(6)
    expect(client.rpc).toHaveBeenCalledWith('dashboard_message_series', {
      p_start: expect.any(String),
      p_tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
  })

  it('series: an RPC error is thrown, not shown as an empty chart', async () => {
    const client = db(async () => ({ data: null, error: new Error('boom') }))
    await expect(loadConversationsSeries(client, 30)).rejects.toThrow('boom')
  })

  it('donut: joins the per-stage sums (numeric arrives as a string) and hides empty stages', async () => {
    const client = db(
      async () => ({ data: [{ stage_id: 's1', deal_count: 2, total_value: '150.50' }], error: null }),
      [
        { id: 's1', name: 'Novo', color: '' },
        { id: 's2', name: 'Proposta', color: '#fff' },
      ],
    )
    const donut = await loadPipelineDonut(client)
    expect(donut.stages).toEqual([{ id: 's1', name: 'Novo', color: '#64748b', dealCount: 2, totalValue: 150.5 }])
    expect(donut.totalValue).toBe(150.5)
  })

  it('response time: averages the sums, nulls for empty days and weeks', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 8, 15)) // Thursday, local
    const client = db(async () => ({
      data: {
        buckets: [
          { dow: 0, sum_minutes: 30, samples: 2 },
          { dow: 3, sum_minutes: 40, samples: 1 },
        ],
        this_week: { sum_minutes: 40, samples: 1 },
        last_week: { sum_minutes: 0, samples: 0 },
      },
      error: null,
    }))
    const rt = await loadResponseTime(client)

    expect(rt.buckets.map((b) => b.avgMinutes)).toEqual([15, null, null, 40, null, null, null])
    expect(rt.buckets.map((b) => b.samples)).toEqual([2, 0, 0, 1, 0, 0, 0])
    expect(rt.thisWeekAvg).toBe(40)
    expect(rt.lastWeekAvg).toBeNull()
    const args = (client.rpc as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(new Date(args.p_this_week_start)).toEqual(new Date(2026, 9, 5)) // local Monday
    expect(new Date(args.p_last_week_start)).toEqual(new Date(2026, 8, 28))
    expect(new Date(args.p_start)).toEqual(new Date(2026, 8, 25))
  })
})
