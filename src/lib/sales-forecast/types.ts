// Sales forecast (migration 106). One row per month x seller from
// sales_forecast(); month null is the "no date" bucket. Money is in the
// account currency only; other-currency deals are counted, never summed.

export interface ForecastRow {
  /** 'YYYY-MM-01', or null for open deals without an expected close date. */
  month: string | null
  /** profiles.id of the seller (deals.assigned_to), null = unassigned. */
  assigned_to: string | null
  won_value: number
  /** Open deals x stage chance ("Previsto"). */
  weighted_value: number
  /** Won + full value of the open deals ("Melhor caso"). */
  best_case_value: number
  open_count: number
  overdue_count: number
  overdue_value: number
  other_currency_count: number
}

/** All sellers, only the unassigned ones, or one seller (profiles.id). */
export type SellerFilter = 'all' | 'none' | { id: string }

export interface ForecastColumn {
  /** 'YYYY-MM-01', or null for the "no date" column. */
  month: string | null
  won: number
  /** Open deals x chance. */
  expected: number
  /** Month forecast = won + expected. */
  forecast: number
  bestCase: number
  openCount: number
  overdueCount: number
  overdueValue: number
  otherCurrencyCount: number
}
