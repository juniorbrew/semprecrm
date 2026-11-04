import { describe, expect, it } from 'vitest'

import type { Deal, PipelineStage } from '@/types'

import { buildForecastColumns, dealsOfColumn, forecastOfMonth } from './columns'
import type { ForecastRow } from './types'

const row = (p: Partial<ForecastRow>): ForecastRow => ({
  month: '2026-11-01', assigned_to: 'p1', won_value: 0, weighted_value: 0, best_case_value: 0,
  open_count: 0, overdue_count: 0, overdue_value: 0, other_currency_count: 0, ...p,
})

describe('buildForecastColumns', () => {
  const rows = [
    row({ assigned_to: 'p1', won_value: 100, weighted_value: 280, best_case_value: 1100, open_count: 2, overdue_count: 1, overdue_value: 200, other_currency_count: 1 }),
    row({ assigned_to: 'p2', weighted_value: 180, best_case_value: 200, open_count: 1 }),
    row({ assigned_to: null, weighted_value: 10, best_case_value: 100, open_count: 1 }),
    row({ month: '2026-12-01', weighted_value: 450, best_case_value: 500, open_count: 1 }),
    row({ month: null, assigned_to: null, weighted_value: 30, best_case_value: 300, open_count: 1 }),
    row({ month: '2027-05-01', weighted_value: 999 }), // outside the window
  ]

  it('has the three months and the no-date column, forecast = won + expected', () => {
    const cols = buildForecastColumns(rows, '2026-11-01', 3)
    expect(cols.map((c) => c.month)).toEqual(['2026-11-01', '2026-12-01', '2027-01-01', null])
    expect(cols[0]).toMatchObject({ won: 100, expected: 470, forecast: 570, bestCase: 1400, openCount: 4, overdueCount: 1, overdueValue: 200, otherCurrencyCount: 1 })
    expect(cols[1]).toMatchObject({ won: 0, expected: 450, forecast: 450 })
    expect(cols[2]).toMatchObject({ forecast: 0, openCount: 0 }) // empty month is still a column
    expect(cols[3]).toMatchObject({ month: null, expected: 30, bestCase: 300, openCount: 1 })
  })

  it('filters by seller: one seller, unassigned only, everyone', () => {
    expect(buildForecastColumns(rows, '2026-11-01', 3, { id: 'p2' })[0]).toMatchObject({ expected: 180, openCount: 1 })
    expect(buildForecastColumns(rows, '2026-11-01', 3, 'none')[0]).toMatchObject({ expected: 10, openCount: 1 })
    expect(buildForecastColumns(rows, '2026-11-01', 3, 'none')[3]).toMatchObject({ expected: 30 })
    expect(buildForecastColumns(rows, '2026-11-01', 3, { id: 'nobody' })[0].forecast).toBe(0)
  })

  it('is all zeros without rows', () => {
    const cols = buildForecastColumns([], '2026-11-01', 3)
    expect(cols).toHaveLength(4)
    expect(cols.every((c) => c.forecast === 0 && c.openCount === 0)).toBe(true)
  })
})

describe('forecastOfMonth', () => {
  it('sums won + expected of the month, per seller or for all', () => {
    const rows = [row({ assigned_to: 'p1', won_value: 100, weighted_value: 50 }), row({ assigned_to: 'p2', won_value: 10, weighted_value: 5 })]
    expect(forecastOfMonth(rows, '2026-11-01')).toBe(165)
    expect(forecastOfMonth(rows, '2026-11-01', { id: 'p2' })).toBe(15)
    expect(forecastOfMonth(rows, '2026-12-01')).toBe(0)
  })
})

describe('dealsOfColumn', () => {
  const stages = [
    { id: 's1', pipeline_id: 'pl', name: 'Novo', position: 0 },
    { id: 's2', pipeline_id: 'pl', name: 'Proposta', position: 1 },
    { id: 's3', pipeline_id: 'pl', name: 'Ganho', position: 2 },
  ] as PipelineStage[]
  const deal = (p: Partial<Deal>) => ({ id: p.title, stage_id: 's1', pipeline_id: 'pl', value: 100, currency: 'BRL', status: 'open', created_at: '2026-10-01T00:00:00Z', ...p }) as Deal
  const deals = [
    deal({ title: 'in-month', expected_close_date: '2026-11-20', assigned_to: 'p1' }),
    deal({ title: 'next', stage_id: 's2', expected_close_date: '2026-12-02', assigned_to: 'p1' }),
    deal({ title: 'overdue', stage_id: 's2', value: 200, expected_close_date: '2026-09-10', assigned_to: 'p2' }),
    deal({ title: 'nodate' }),
    deal({ title: 'usd', currency: 'USD', value: 999, expected_close_date: '2026-11-05' }),
    deal({ title: 'nocurrency', currency: undefined, value: 55, expected_close_date: '2026-11-07' }),
    deal({ title: 'lost', status: 'lost', expected_close_date: '2026-11-05' }),
    // closed 02:59 UTC on Dec 1 = Nov 30, 23:59 in Sao Paulo -> November
    deal({ title: 'won-edge', stage_id: 's3', status: 'won', closed_at: '2026-12-01T02:59:00Z', value: 70 }),
    deal({ title: 'won-dec', stage_id: 's3', status: 'won', closed_at: '2026-12-01T03:01:00Z', value: 80 }),
  ]
  const opts = { currentMonth: '2026-11-01', timezone: 'America/Sao_Paulo', currency: 'BRL' }

  it('current month: open dated deals, the overdue one (flagged), the won one by closed_at in the account zone; lost out', () => {
    const list = dealsOfColumn(deals, stages, '2026-11-01', opts)
    expect(list.map((d) => d.deal.title).sort()).toEqual(['in-month', 'nocurrency', 'overdue', 'usd', 'won-edge'])
    const overdue = list.find((d) => d.deal.title === 'overdue')!
    expect(overdue).toMatchObject({ overdue: true, chance: 90, weighted: 180 })
    expect(list.find((d) => d.deal.title === 'in-month')).toMatchObject({ chance: 10, weighted: 10, stageName: 'Novo', overdue: false })
    expect(list.find((d) => d.deal.title === 'won-edge')).toMatchObject({ weighted: 70 })
  })

  it('other currency is listed but adds nothing', () => {
    const usd = dealsOfColumn(deals, stages, '2026-11-01', opts).find((d) => d.deal.title === 'usd')!
    expect(usd).toMatchObject({ otherCurrency: true, value: 0, weighted: 0 })
  })

  it('a deal without a currency is another currency (not summed), as in the database', () => {
    const d = dealsOfColumn(deals, stages, '2026-11-01', opts).find((x) => x.deal.title === 'nocurrency')!
    expect(d).toMatchObject({ otherCurrency: true, value: 0, weighted: 0 })
  })

  it('orders stages by position, created_at, id like the database', () => {
    const tied = [
      { id: 'b', pipeline_id: 'pl', name: 'B', position: 0, created_at: '2026-01-02T00:00:00Z' },
      { id: 'a', pipeline_id: 'pl', name: 'A', position: 0, created_at: '2026-01-01T00:00:00Z' },
      { id: 'c', pipeline_id: 'pl', name: 'C', position: 0, created_at: '2026-01-02T00:00:00Z' },
    ] as PipelineStage[]
    const open = (stage_id: string) => deal({ title: stage_id, stage_id, expected_close_date: '2026-11-20' })
    const list = dealsOfColumn([open('a'), open('b'), open('c')], tied, '2026-11-01', opts)
    // a (first), b, c (last = 100%): 10 / 90 / 100
    expect(Object.fromEntries(list.map((d) => [d.deal.title, d.chance]))).toEqual({ a: 10, b: 90, c: 100 })
  })

  it('sorted by weighted value, then no date and next month', () => {
    expect(dealsOfColumn(deals, stages, '2026-11-01', opts)[0].deal.title).toBe('overdue')
    expect(dealsOfColumn(deals, stages, null, opts).map((d) => d.deal.title)).toEqual(['nodate'])
    expect(dealsOfColumn(deals, stages, '2026-12-01', opts).map((d) => d.deal.title).sort()).toEqual(['next', 'won-dec'])
  })

  it('respects the seller filter', () => {
    expect(dealsOfColumn(deals, stages, '2026-11-01', { ...opts, seller: { id: 'p2' } }).map((d) => d.deal.title)).toEqual(['overdue'])
    expect(dealsOfColumn(deals, stages, '2026-11-01', { ...opts, seller: 'none' }).map((d) => d.deal.title).sort()).toEqual(['nocurrency', 'usd', 'won-edge'])
  })

  it('uses the chance defined on the stage', () => {
    const custom = stages.map((s) => (s.id === 's1' ? { ...s, win_probability: 50 } : s))
    expect(dealsOfColumn(deals, custom, '2026-11-01', opts).find((d) => d.deal.title === 'in-month')).toMatchObject({ chance: 50, weighted: 50 })
  })
})
