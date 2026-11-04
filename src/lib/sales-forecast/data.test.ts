import { describe, expect, it, vi } from 'vitest'

import { fetchSalesForecast } from './data'

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
