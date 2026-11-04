// Sales forecast data access (migration 106): the typed face of
// sales_forecast(). Called from the browser with the user's session; RLS and
// the function decide who reads what.

import type { SupabaseClient } from '@supabase/supabase-js'

import { DEAL_BOARD_SELECT, DEAL_BOARD_SELECT_FALLBACK } from '@/lib/pipelines/load-deals'
import { fromZonedParts } from '@/lib/calendar/range'
import { shiftMonth } from '@/lib/sales-goals/pace'
import type { Deal, PipelineStage } from '@/types'

import type { ForecastRow } from './types'

type Client = Pick<SupabaseClient, 'rpc'>

/** pipelineId null = every pipeline of the account. months is clamped to 1..6 by the database. */
export async function fetchSalesForecast(
  db: Client,
  accountId: string,
  pipelineId: string | null,
  month: string,
  months = 3,
): Promise<ForecastRow[]> {
  const { data, error } = await db.rpc('sales_forecast', {
    p_account_id: accountId,
    p_pipeline_id: pipelineId,
    p_month: month,
    p_months: months,
  })
  if (error) throw error
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    month: (r.month as string | null) ?? null,
    assigned_to: (r.assigned_to as string | null) ?? null,
    won_value: Number(r.won_value),
    weighted_value: Number(r.weighted_value),
    best_case_value: Number(r.best_case_value),
    open_count: Number(r.open_count),
    overdue_count: Number(r.overdue_count),
    overdue_value: Number(r.overdue_value),
    other_currency_count: Number(r.other_currency_count),
  }))
}

const PAGE = 1000;

/** What a forecast column is made of: a month ('YYYY-MM-01') or null = deals without a date. */
export interface ForecastColumnQuery {
  month: string | null
  /** 'YYYY-MM-01' of the running month in the account time zone (overdue deals live there). */
  currentMonth: string
  timezone: string
}

/**
 * The deals behind ONE forecast column, read page by page (PostgREST caps a
 * response at 1000 rows, so a single request could truncate silently):
 *  - open deals whose expected close date is in the month (for the current
 *    month also every earlier date: overdue), or without a date for null;
 *  - won deals closed inside the month in the account time zone.
 * Same rules as sales_forecast() and dealsOfColumn().
 */
export async function loadForecastDeals(
  db: Pick<SupabaseClient, 'from'>,
  accountId: string,
  pipelineId: string | null,
  column: ForecastColumnQuery,
): Promise<Deal[]> {
  const nextMonth = column.month ? shiftMonth(column.month, 1) : null
  const [y, m] = (column.month ?? column.currentMonth).split('-').map(Number)
  const start = fromZonedParts({ year: y, month: m, day: 1 }, column.timezone).toISOString()
  const end = fromZonedParts({ year: y, month: m + 1, day: 1 }, column.timezone).toISOString()

  // The builder is untyped on purpose: the select string is dynamic and the filters are chained by branch.
  const page = async (select: string, kind: 'open' | 'won', from: number) => {
    let q = db.from('deals').select(select).eq('account_id', accountId)
    if (pipelineId) q = q.eq('pipeline_id', pipelineId)
    if (kind === 'open') {
      q = q.eq('status', 'open')
      if (!column.month) q = q.is('expected_close_date', null)
      else {
        q = q.lt('expected_close_date', nextMonth as string)
        if (column.month !== column.currentMonth) q = q.gte('expected_close_date', column.month)
      }
    } else {
      q = q.eq('status', 'won').gte('closed_at', start).lt('closed_at', end)
    }
    return q.order('created_at', { ascending: false }).order('id').range(from, from + PAGE - 1)
  }

  const readAll = async (select: string, kind: 'open' | 'won') => {
    const out: Deal[] = []
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await page(select, kind, from)
      if (error) throw error
      const rows = (data ?? []) as unknown as Deal[]
      out.push(...rows)
      if (rows.length < PAGE) return out
    }
  }

  const run = async (select: string) => {
    const open = await readAll(select, 'open')
    const won = column.month ? await readAll(select, 'won') : []
    return [...open, ...won]
  }
  try {
    return await run(DEAL_BOARD_SELECT)
  } catch (err) {
    console.error('[pipelines] forecast deal query with company failed, retrying without it:', err)
    return run(DEAL_BOARD_SELECT_FALLBACK)
  }
}

/** Stages of the pipeline, or of every pipeline of the account (scoped through pipelines.account_id). */
export async function loadForecastStages(
  db: Pick<SupabaseClient, 'from'>,
  accountId: string,
  pipelineId: string | null,
): Promise<PipelineStage[]> {
  const base = db.from('pipeline_stages')
  const { data, error } = pipelineId
    ? await base.select('*').eq('pipeline_id', pipelineId)
    : await base.select('*, pipelines!inner(account_id)').eq('pipelines.account_id', accountId)
  if (error) throw error
  return (data ?? []) as unknown as PipelineStage[]
}
