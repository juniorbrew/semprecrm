// Pure builders for the forecast view: columns from the RPC rows and the
// deal lists behind each column. No React, no Supabase.

import { stageProbability } from '@/lib/pipelines/board'
import { zonedParts } from '@/lib/calendar/range'
import { shiftMonth } from '@/lib/sales-goals/pace'
import type { Deal, PipelineStage } from '@/types'

import type { ForecastColumn, ForecastRow, SellerFilter } from './types'

const matches = (r: Pick<ForecastRow, 'assigned_to'>, f: SellerFilter) =>
  f === 'all' ? true : f === 'none' ? r.assigned_to === null : r.assigned_to === f.id

const empty = (month: string | null): ForecastColumn => ({
  month, won: 0, expected: 0, forecast: 0, bestCase: 0, openCount: 0, overdueCount: 0, overdueValue: 0, otherCurrencyCount: 0,
})

/**
 * One column per month from `from` ('YYYY-MM-01'), then the "no date" column
 * (month null), always present. Rows of other months are ignored.
 */
export function buildForecastColumns(
  rows: readonly ForecastRow[],
  from: string,
  months: number,
  seller: SellerFilter = 'all',
): ForecastColumn[] {
  const cols = new Map<string | null, ForecastColumn>()
  for (let i = 0; i < months; i++) cols.set(shiftMonth(from, i), empty(shiftMonth(from, i)))
  cols.set(null, empty(null))
  for (const r of rows) {
    const c = cols.get(r.month)
    if (!c || !matches(r, seller)) continue
    c.won += r.won_value
    c.expected += r.weighted_value
    c.bestCase += r.best_case_value
    c.openCount += r.open_count
    c.overdueCount += r.overdue_count
    c.overdueValue += r.overdue_value
    c.otherCurrencyCount += r.other_currency_count
  }
  for (const c of cols.values()) c.forecast = c.won + c.expected
  return [...cols.values()]
}

/** Month forecast of one seller (or the whole team) for the goals card; 0 when there is no row. */
export function forecastOfMonth(rows: readonly ForecastRow[], month: string, seller: SellerFilter = 'all'): number {
  const c = buildForecastColumns(rows, month, 1, seller)[0]
  return c.forecast
}

export interface ForecastDeal {
  deal: Deal
  stageName: string
  /** 0-100 */
  chance: number
  /** The deal value counted in the numbers (0 for another currency). */
  value: number
  weighted: number
  /** Date shown: expected close (open) or closing day (won). */
  date: string | null
  overdue: boolean
  otherCurrency: boolean
}

/**
 * Deals behind one column, with the same rules as the database:
 * won -> month of closed_at in the account time zone; open -> month of the
 * expected close date, past months moved to the current one (overdue), no date
 * -> the null column. Lost deals never count. Sorted by weighted value, desc.
 */
export function dealsOfColumn(
  deals: readonly Deal[],
  stages: readonly PipelineStage[],
  column: string | null,
  opts: { currentMonth: string; timezone: string; currency: string; seller?: SellerFilter },
): ForecastDeal[] {
  const seller = opts.seller ?? 'all'
  const byPipeline = new Map<string, PipelineStage[]>()
  for (const s of stages) byPipeline.set(s.pipeline_id, [...(byPipeline.get(s.pipeline_id) ?? []), s])
  for (const list of byPipeline.values()) list.sort((a, b) => a.position - b.position)
  const stageById = new Map(stages.map((s) => [s.id, s]))

  const out: ForecastDeal[] = []
  for (const deal of deals) {
    if (!matches({ assigned_to: deal.assigned_to ?? null }, seller)) continue
    let month: string | null
    let overdue = false
    if (deal.status === 'won') {
      if (!deal.closed_at) continue
      const p = zonedParts(new Date(deal.closed_at), opts.timezone)
      month = `${p.year}-${String(p.month).padStart(2, '0')}-01`
    } else if (deal.status === 'open') {
      if (!deal.expected_close_date) month = null
      else {
        const m = `${deal.expected_close_date.slice(0, 7)}-01`
        overdue = m < opts.currentMonth
        month = overdue ? opts.currentMonth : m
      }
    } else continue
    if (month !== column) continue

    const stage = stageById.get(deal.stage_id)
    const chance = stage ? Math.round(stageProbability(stage, byPipeline.get(stage.pipeline_id) ?? []) * 10000) / 100 : 0
    const otherCurrency = (deal.currency ?? opts.currency) !== opts.currency
    const value = otherCurrency ? 0 : Number(deal.value || 0)
    out.push({
      deal,
      stageName: stage?.name ?? '',
      chance,
      value,
      weighted: deal.status === 'open' ? (value * chance) / 100 : value,
      date: deal.status === 'won' ? deal.closed_at ?? null : deal.expected_close_date ?? null,
      overdue,
      otherCurrency,
    })
  }
  return out.sort((a, b) => b.weighted - a.weighted)
}
