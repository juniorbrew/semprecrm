// Sales forecast data access (migration 106): the typed face of
// sales_forecast(). Called from the browser with the user's session; RLS and
// the function decide who reads what.

import type { SupabaseClient } from '@supabase/supabase-js'

import { DEAL_BOARD_SELECT, DEAL_BOARD_SELECT_FALLBACK } from '@/lib/pipelines/load-deals'
import type { Deal } from '@/types'

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

/**
 * The deals behind the forecast numbers: every open deal plus the ones won
 * since `wonSince` (ISO instant, a day before the first month so the account
 * time zone never cuts one off; the exact month is decided by dealsOfColumn).
 * ponytail: one page of rows (PostgREST max-rows, 1000); paginate if an account
 * ever has more open deals than that.
 */
export async function loadForecastDeals(
  db: Pick<SupabaseClient, 'from'>,
  accountId: string,
  pipelineId: string | null,
  wonSince: string,
): Promise<Deal[]> {
  const run = async (select: string) => {
    let q = db.from('deals').select(select).eq('account_id', accountId)
    if (pipelineId) q = q.eq('pipeline_id', pipelineId)
    return q.or(`status.eq.open,and(status.eq.won,closed_at.gte.${wonSince})`).order('created_at', { ascending: false })
  }
  const first = await run(DEAL_BOARD_SELECT)
  if (!first.error) return (first.data ?? []) as unknown as Deal[]
  const second = await run(DEAL_BOARD_SELECT_FALLBACK)
  if (second.error) throw second.error
  return (second.data ?? []) as unknown as Deal[]
}
