// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const h = vi.hoisted(() => ({
  auth: {
    accountId: 'acc-1' as string | null,
    defaultCurrency: 'BRL',
    preferences: { business_hours: { timezone: 'America/Sao_Paulo' } },
  },
  forecast: vi.fn(),
  deals: vi.fn(),
  stagesResult: { data: [] as unknown[], error: null as unknown },
  eqCalls: [] as string[],
}))

vi.mock('@/hooks/use-auth', () => ({ useAuth: () => h.auth }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => ({
      select: () => {
        if (table === 'profiles') {
          return { eq: () => Promise.resolve({ data: [{ id: 'p1', full_name: 'Ana' }, { id: 'p2', full_name: 'Beto' }], error: null }) }
        }
        const chain = {
          eq: (col: string, val: string) => {
            h.eqCalls.push(`${col}=${val}`)
            return chain
          },
          then: (resolve: (v: unknown) => unknown) => resolve(h.stagesResult),
        }
        return chain
      },
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
    }),
  }),
}))
vi.mock('@/lib/sales-forecast/data', () => ({ fetchSalesForecast: h.forecast, loadForecastDeals: h.deals }))
vi.mock('./deal-drawer', () => ({
  DealDrawer: ({ deal, pipelineId }: { deal: { title: string } | null; pipelineId: string }) =>
    deal ? <div role="dialog" aria-label="gaveta">{`${deal.title}@${pipelineId}`}</div> : null,
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { currentMonth, shiftMonth } from '@/lib/sales-goals/pace'
import { SalesForecast } from './sales-forecast'

const cur = currentMonth('America/Sao_Paulo')
const next = shiftMonth(cur, 1)
const pipeline = { id: 'pl-1', name: 'Vendas B2B' } as never

const frow = (p: Record<string, unknown>) => ({
  month: cur, assigned_to: 'p1', won_value: 0, weighted_value: 0, best_case_value: 0,
  open_count: 0, overdue_count: 0, overdue_value: 0, other_currency_count: 0, ...p,
})
const day = (month: string, d: string) => `${month.slice(0, 8)}${d}`
const deal = (p: Record<string, unknown>) => ({
  id: p.title, pipeline_id: 'pl-1', stage_id: 's1', value: 100, currency: 'BRL', status: 'open',
  contact_id: null, created_at: '2026-01-01T00:00:00Z', ...p,
})
const stages = [
  { id: 's1', pipeline_id: 'pl-1', name: 'Novo', position: 0 },
  { id: 's2', pipeline_id: 'pl-1', name: 'Ganho', position: 1 },
]

beforeEach(() => {
  h.auth.accountId = 'acc-1'
  h.forecast.mockReset()
  h.deals.mockReset()
  h.stagesResult = { data: stages, error: null }
  h.eqCalls.length = 0
  h.forecast.mockResolvedValue([
    frow({ assigned_to: 'p1', won_value: 100, weighted_value: 280, best_case_value: 1100, open_count: 2, overdue_count: 1, overdue_value: 200, other_currency_count: 1 }),
    frow({ assigned_to: 'p2', weighted_value: 180, best_case_value: 200, open_count: 1 }),
    frow({ month: next, assigned_to: 'p1', weighted_value: 450, best_case_value: 500, open_count: 1 }),
    frow({ month: null, assigned_to: null, weighted_value: 30, best_case_value: 300, open_count: 1 }),
  ])
  h.deals.mockResolvedValue([
    deal({ title: 'Proposta A', expected_close_date: day(cur, '20'), assigned_to: 'p1' }),
    deal({ title: 'Atrasado', stage_id: 's1', value: 200, expected_close_date: '2020-01-10', assigned_to: 'p2' }),
    deal({ title: 'Em dólar', currency: 'USD', value: 999, expected_close_date: day(cur, '05'), assigned_to: 'p1' }),
    deal({ title: 'Sem prazo', expected_close_date: undefined, assigned_to: null }),
  ])
})
afterEach(cleanup)

const columnOf = (title: RegExp) => screen.getAllByRole('button', { pressed: false }).concat(screen.queryAllByRole('button', { pressed: true })).find((b) => title.test(b.textContent ?? ''))!

describe('SalesForecast', () => {
  it('shows a loading state, then the months and the no-date column with their numbers', async () => {
    render(<SalesForecast pipeline={pipeline} />)
    expect(screen.getByRole('status', { name: 'Carregando a previsão…' })).toBeTruthy()
    await screen.findByText('R$ 560')
    const now = columnOf(/Este mês/)
    expect(within(now).getByText('R$ 560')).toBeTruthy() // won 100 + expected 280 + 180
    expect(within(now).getByText('R$ 1.300')).toBeTruthy() // best case
    expect(now.textContent?.replace(/ /g, ' ')).toContain('1 negócio com data vencida · R$ 200')
    expect(now.textContent).toContain('1 em outra moeda')
    expect(h.forecast).toHaveBeenCalledWith(expect.anything(), 'acc-1', 'pl-1', cur, 3)
    const upcoming = columnOf(new RegExp(next.slice(0, 4)))
    expect(upcoming).toBeTruthy()
    const noDate = columnOf(/Sem data/)
    expect(within(noDate).getByText('R$ 300')).toBeTruthy()
    expect(noDate.textContent).toContain('Preencha a data prevista')
    expect(noDate.textContent).not.toContain('Ganho')
  })

  it('the seller filter recomputes the columns: one seller, nobody, everyone', async () => {
    render(<SalesForecast pipeline={pipeline} />)
    await screen.findByText('R$ 560')
    fireEvent.change(screen.getByLabelText('Vendedor'), { target: { value: 'p2' } })
    expect(within(columnOf(/Este mês/)).getAllByText('R$ 180')).toHaveLength(2) // forecast and expected
    fireEvent.change(screen.getByLabelText('Vendedor'), { target: { value: 'none' } })
    expect(within(columnOf(/Este mês/)).getAllByText('R$ 0').length).toBeGreaterThan(0)
    expect(within(columnOf(/Sem data/)).getByText('R$ 300')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Vendedor'), { target: { value: 'all' } })
    expect(within(columnOf(/Este mês/)).getByText('R$ 560')).toBeTruthy()
    // sellers come from the account profiles (assigned_to holds profiles.id)
    expect(screen.getByRole('option', { name: 'Ana' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Sem responsável' })).toBeTruthy()
  })

  it('"all pipelines" asks the database for every pipeline', async () => {
    render(<SalesForecast pipeline={pipeline} />)
    await screen.findByText('R$ 560')
    fireEvent.change(screen.getByLabelText('Funil'), { target: { value: 'all' } })
    await waitFor(() => expect(h.forecast).toHaveBeenLastCalledWith(expect.anything(), 'acc-1', null, cur, 3))
    await screen.findByText('R$ 560')
  })

  it('clicking the month lists the deals behind it and each opens the drawer', async () => {
    render(<SalesForecast pipeline={pipeline} />)
    await screen.findByText('R$ 560')
    fireEvent.click(columnOf(/Este mês/))
    await screen.findByText('Proposta A')
    expect(columnOf(/Este mês/).getAttribute('aria-pressed')).toBe('true')
    const table = screen.getByRole('table', { name: 'Negócios por trás dos números da previsão' })
    const rows = within(table).getAllByRole('row')
    expect(rows).toHaveLength(4) // header + 3 (the one without a date is in another column)
    const late = within(table).getByText('Atrasado').closest('tr')!
    expect(late.textContent).toContain('data vencida')
    expect(late.textContent).toContain('10%')
    const usd = within(table).getByText('Em dólar').closest('tr')!
    expect(usd.textContent).toContain('outra moeda')
    fireEvent.click(within(table).getByText('Proposta A'))
    expect(await screen.findByRole('dialog', { name: 'gaveta' })).toBeTruthy()
    expect(screen.getByRole('dialog', { name: 'gaveta' }).textContent).toBe('Proposta A@pl-1')
  })

  it('no-date column lists only the deals without a date', async () => {
    render(<SalesForecast pipeline={pipeline} />)
    await screen.findByText('R$ 560')
    fireEvent.click(columnOf(/Sem data/))
    await screen.findByText('Sem prazo')
    expect(screen.queryByText('Proposta A')).toBeNull()
  })

  it('shows the error with a way to try again', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.forecast.mockRejectedValueOnce(new Error('boom'))
    render(<SalesForecast pipeline={pipeline} />)
    expect(await screen.findByText('Não foi possível carregar a previsão.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }))
    await screen.findByText('R$ 560')
    spy.mockRestore()
  })

  it('shows the empty state when there is nothing to forecast', async () => {
    h.forecast.mockResolvedValue([])
    render(<SalesForecast pipeline={pipeline} />)
    expect(await screen.findByText('Ainda não há o que prever')).toBeTruthy()
    expect(screen.queryAllByRole('button', { pressed: false })).toHaveLength(0)
  })

  it('shows an error inside the list when the deals cannot be read', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.deals.mockRejectedValue(new Error('boom'))
    render(<SalesForecast pipeline={pipeline} />)
    await screen.findByText('R$ 560')
    fireEvent.click(columnOf(/Este mês/))
    expect(await screen.findByText('Não foi possível carregar os negócios.')).toBeTruthy()
    spy.mockRestore()
  })
})
