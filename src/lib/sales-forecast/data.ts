// Sales forecast data access (migration 106): the typed face of
// sales_forecast(). Called from the browser with the user's session; RLS and
// the function decide who reads what.

import type { SupabaseClient } from '@supabase/supabase-js'

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
