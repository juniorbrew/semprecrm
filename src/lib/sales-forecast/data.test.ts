import { describe, expect, it, vi } from 'vitest'

import { fetchSalesForecast, loadForecastDeals, loadForecastStages } from './data'

describe('fetchSalesForecast', () => {
  it('calls the RPC and coerces numerics', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ month: '2026-11-01', assigned_to: 'p1', won_value: '100.00', weighted_value: '280.5', best_case_value: '1300.00', open_count: '2', overdue_count: 1, overdue_value: '200.00', other_currency_count: 2 }],
      error: null,
    })
    const rows = await fetchSalesForecast({ rpc } as never, 'acc', null, '2026-11-01', 3)
    expect(rpc).toHaveBeenCalledWith('sales_forecast', { p_account_id: 'acc', p_pipeline_id: null, p_month: '2026-11-01', p_months: 3 })
    expect(rows).toEqual([{ month: '2026-11-01', assigned_to: 'p1', won_value: 100, weighted_value: 280.5, best_case_value: 1300, open_count: 2, overdue_count: 1, overdue_value: 200, other_currency_count: 2 }])
  })
  it('keeps the no-date and unassigned nulls', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ month: null, assigned_to: null, won_value: 0, weighted_value: 30, best_case_value: 300, open_count: 1, overdue_count: 0, overdue_value: 0, other_currency_count: 0 }], error: null })
    const rows = await fetchSalesForecast({ rpc } as never, 'acc', 'pl', '2026-11-01')
    expect(rows[0]).toMatchObject({ month: null, assigned_to: null })
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_pipeline_id: 'pl', p_months: 3 })
  })
  it('throws the database error', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: new Error('nope') })
    await expect(fetchSalesForecast({ rpc } as never, 'acc', null, '2026-11-01')).rejects.toThrow('nope')
  })
})

/** A recording stand-in for a PostgREST builder: every call is logged; await gives the page for the last range(). */
function fakeDb(pages: Record<string, unknown[][]>, log: string[][] = []) {
  const from = (table: string) => ({
    select: (cols: string) => {
      const calls: string[] = [`${table}:${cols.slice(0, 12)}`]
      const b: Record<string, unknown> = {}
      const chain = (name: string) => (...args: unknown[]) => {
        calls.push(`${name}(${args.map(String).join(',')})`)
        return b
      }
      for (const n of ['eq', 'is', 'lt', 'gte', 'order']) b[n] = chain(n)
      b.range = (a: number, z: number) => {
        calls.push(`range(${a},${z})`)
        return b
      }
      b.then = (resolve: (v: unknown) => unknown) => {
        log.push(calls)
        const kind = calls.includes('eq(status,won)') ? 'won' : 'open'
        const idx = log.filter((c) => c.includes(`eq(status,${kind})`)).length - 1
        return resolve({ data: pages[kind]?.[idx] ?? [], error: null })
      }
      return b
    },
  })
  return { from } as never
}

describe('loadForecastDeals', () => {
  const tz = 'America/Sao_Paulo'
  it('current month: open deals up to the end of the month (overdue included) and won deals closed in it, in the account zone', async () => {
    const log: string[][] = []
    const db = fakeDb({ open: [[{ id: 'o' }]], won: [[{ id: 'w' }]] }, log)
    const deals = await loadForecastDeals(db, 'acc', 'pl', { month: '2026-11-01', currentMonth: '2026-11-01', timezone: tz })
    expect(deals.map((d) => d.id)).toEqual(['o', 'w'])
    const open = log.find((c) => c.includes('eq(status,open)'))!
    expect(open).toContain('lt(expected_close_date,2026-12-01)')
    expect(open.some((c) => c.startsWith('gte(expected_close_date'))).toBe(false)
    expect(open).toContain('eq(pipeline_id,pl)')
    const won = log.find((c) => c.includes('eq(status,won)'))!
    expect(won).toContain('gte(closed_at,2026-11-01T03:00:00.000Z)')
    expect(won).toContain('lt(closed_at,2026-12-01T03:00:00.000Z)')
  })
  it('a later month is bounded on both sides; the no-date column asks for null dates and no won deals', async () => {
    const log: string[][] = []
    await loadForecastDeals(fakeDb({}, log), 'acc', null, { month: '2026-12-01', currentMonth: '2026-11-01', timezone: tz })
    const open = log.find((c) => c.includes('eq(status,open)'))!
    expect(open).toContain('gte(expected_close_date,2026-12-01)')
    expect(open).toContain('lt(expected_close_date,2027-01-01)')
    expect(open.some((c) => c.startsWith('eq(pipeline_id'))).toBe(false)
    const none: string[][] = []
    await loadForecastDeals(fakeDb({}, none), 'acc', null, { month: null, currentMonth: '2026-11-01', timezone: tz })
    expect(none).toHaveLength(1)
    expect(none[0]).toContain('is(expected_close_date,null)')
  })
  it('pages through the 1000-row cap instead of truncating', async () => {
    const full = Array.from({ length: 1000 }, (_, i) => ({ id: `a${i}` }))
    const log: string[][] = []
    const deals = await loadForecastDeals(fakeDb({ open: [full, [{ id: 'last' }]] }, log), 'acc', null, { month: null, currentMonth: '2026-11-01', timezone: tz })
    expect(deals).toHaveLength(1001)
    expect(log.map((c) => c.find((x) => x.startsWith('range')))).toEqual(['range(0,999)', 'range(1000,1999)'])
  })
})

describe('loadForecastStages', () => {
  it('all pipelines are scoped to the account through the pipelines join', async () => {
    const log: string[][] = []
    const db = {
      from: (t: string) => ({
        select: (c: string) => {
          const calls = [`${t}:${c}`]
          const b = { eq: (a: string, v: string) => (calls.push(`eq(${a},${v})`), log.push(calls), Promise.resolve({ data: [{ id: 's' }], error: null })) }
          return b
        },
      }),
    } as never
    expect(await loadForecastStages(db, 'acc', null)).toHaveLength(1)
    expect(log[0]).toEqual(['pipeline_stages:*, pipelines!inner(account_id)', 'eq(pipelines.account_id,acc)'])
    await loadForecastStages(db, 'acc', 'pl')
    expect(log[1]).toEqual(['pipeline_stages:*', 'eq(pipeline_id,pl)'])
  })
})
