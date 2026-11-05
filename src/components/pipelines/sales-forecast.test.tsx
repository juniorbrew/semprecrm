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
  stages: vi.fn(),
}))

vi.mock('@/hooks/use-auth', () => ({ useAuth: () => h.auth }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ eq: () => Promise.resolve({ data: [{ id: 'p1', full_name: 'Ana' }, { id: 'p2', full_name: 'Beto' }], error: null }) }),
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
    }),
  }),
}))
vi.mock('@/lib/sales-forecast/data', () => ({
  fetchSalesForecast: h.forecast,
  loadForecastDeals: h.deals,
  loadForecastStages: h.stages,
}))
vi.mock('./deal-drawer', () => ({
  // The real drawer calls onChanged after a save / status change; the mock exposes a button for it.
  DealDrawer: ({ deal, pipelineId, onChanged }: { deal: { title: string } | null; pipelineId: string; onChanged: () => void }) =>
    deal ? (
      <div role="dialog" aria-label="gaveta">
        <span>{`${deal.title}@${pipelineId}`}</span>
        <button type="button" onClick={() => onChanged()}>
          salvar na gaveta
        </button>
      </div>
    ) : null,
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
const deal = (p: Record<string, unknown>): Record<string, unknown> => ({
  id: p.title, pipeline_id: 'pl-1', stage_id: 's1', value: 100, currency: 'BRL', status: 'open',
  contact_id: null, created_at: '2026-01-01T00:00:00Z', ...p,
})
const stages = [
  { id: 's1', pipeline_id: 'pl-1', name: 'Novo', position: 0, created_at: '2026-01-01T00:00:00Z' },
  { id: 's2', pipeline_id: 'pl-1', name: 'Ganho', position: 1, created_at: '2026-01-01T00:00:00Z' },
  { id: 's3', pipeline_id: 'pl-1', name: 'Fechado', position: 2, created_at: '2026-01-01T00:00:00Z' },
]
const allDeals = [
  deal({ title: 'Proposta A', expected_close_date: day(cur, '20'), assigned_to: 'p1' }),
  deal({ title: 'Atrasado', stage_id: 's2', value: 200, expected_close_date: '2020-01-10', assigned_to: 'p2' }),
  deal({ title: 'Em dólar', currency: 'USD', value: 999, expected_close_date: day(cur, '05'), assigned_to: 'p1' }),
  deal({ title: 'Sem prazo', expected_close_date: undefined, assigned_to: null }),
]

beforeEach(() => {
  h.auth.accountId = 'acc-1'
  h.forecast.mockReset()
  h.deals.mockReset()
  h.stages.mockReset()
  h.stages.mockResolvedValue(stages)
  h.forecast.mockResolvedValue([
    frow({ assigned_to: 'p1', won_value: 100, weighted_value: 280, best_case_value: 1100, open_count: 2, overdue_count: 1, overdue_value: 200, other_currency_count: 1 }),
    frow({ assigned_to: 'p2', weighted_value: 180, best_case_value: 200, open_count: 1 }),
    frow({ month: next, assigned_to: 'p1', weighted_value: 450, best_case_value: 500, open_count: 1 }),
    frow({ month: null, assigned_to: null, weighted_value: 30, best_case_value: 300, open_count: 1 }),
  ])
  // the loader reads one column: the fake answers like the database would
  h.deals.mockImplementation(async (_db, _acc, _pl, col: { month: string | null }) =>
    allDeals.filter((d) => (col.month === null ? !d.expected_close_date : !!d.expected_close_date)),
  )
})
afterEach(cleanup)

/** The card of a column (its <li>) and its toggle button. */
const card = (title: RegExp) => screen.getAllByRole('listitem').find((li) => title.test(li.textContent ?? ''))!
const toggle = (title: RegExp) => within(card(title)).getByRole('button')

describe('SalesForecast', () => {
  it('shows a loading state, then the months and the no-date column with their numbers', async () => {
    render(<SalesForecast pipeline={pipeline} />)
    expect(screen.getByRole('status', { name: 'Carregando a previsão…' })).toBeTruthy()
    await screen.findByText('R$ 560')
    const now = card(/Este mês/)
    expect(within(now).getByText('R$ 560')).toBeTruthy() // won 100 + expected 280 + 180
    expect(within(now).getByText('R$ 1.300')).toBeTruthy() // best case
    expect(now.textContent?.replace(/ /g, ' ')).toContain('1 negócio com data vencida · R$ 200')
    expect(now.textContent).toContain('1 em outra moeda')
    expect(h.forecast).toHaveBeenCalledWith(expect.anything(), 'acc-1', 'pl-1', cur, 3)
    expect(card(new RegExp(next.slice(0, 4)))).toBeTruthy()
    const noDate = card(/Sem data/)
    expect(within(noDate).getByText('R$ 300')).toBeTruthy()
    expect(noDate.textContent).toContain('Preencha a data prevista')
    expect(noDate.textContent).not.toContain('Ganho')
  })

  it('the card is valid HTML: the toggle button holds text only, no block content inside it', async () => {
    render(<SalesForecast pipeline={pipeline} />)
    await screen.findByText('R$ 560')
    for (const b of screen.getAllByRole('button', { pressed: false })) {
      expect(b.querySelector('dl, div, p, ul, table')).toBeNull()
    }
    expect(toggle(/Este mês/).getAttribute('aria-pressed')).toBe('false')
  })

  it('the seller filter recomputes the columns: one seller, nobody, everyone', async () => {
    render(<SalesForecast pipeline={pipeline} />)
    await screen.findByText('R$ 560')
    fireEvent.change(screen.getByLabelText('Vendedor'), { target: { value: 'p2' } })
    expect(within(card(/Este mês/)).getAllByText('R$ 180')).toHaveLength(2) // forecast and expected
    fireEvent.change(screen.getByLabelText('Vendedor'), { target: { value: 'none' } })
    // nobody has deals this month: the forecast figure (the one just above its label) is zero
    expect(within(card(/Este mês/)).getByText('Previsão do mês').previousElementSibling?.textContent?.replace(/ /g, ' ')).toBe('R$ 0')
    expect(within(card(/Sem data/)).getByText('R$ 300')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Vendedor'), { target: { value: 'all' } })
    expect(within(card(/Este mês/)).getByText('R$ 560')).toBeTruthy()
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

  it('clicking the month reads only that column, lists its deals and each opens the drawer', async () => {
    render(<SalesForecast pipeline={pipeline} />)
    await screen.findByText('R$ 560')
    fireEvent.click(toggle(/Este mês/))
    await screen.findByText('Proposta A')
    expect(h.deals).toHaveBeenCalledWith(expect.anything(), 'acc-1', 'pl-1', { month: cur, currentMonth: cur, timezone: 'America/Sao_Paulo' })
    expect(toggle(/Este mês/).getAttribute('aria-pressed')).toBe('true')
    const table = screen.getByRole('table', { name: 'Negócios por trás dos números da previsão' })
    expect(within(table).getAllByRole('row')).toHaveLength(4) // header + 3
    // the count is announced in a short status line, not by making the table live
    expect(screen.getByRole('status').textContent).toMatch(/^3 negócios em /)
    expect(table.closest('[aria-live]')).toBeNull()
    const late = within(table).getByText('Atrasado').closest('tr')!
    expect(late.textContent).toContain('data vencida')
    expect(late.textContent).toContain('90%')
    const first = within(table).getByText('Proposta A').closest('tr')!
    expect(first.textContent).toContain('10%')
    expect(first.textContent).not.toMatch(/\d\.\d+%/)
    expect(within(table).getByText('Em dólar').closest('tr')!.textContent).toContain('outra moeda')
    fireEvent.click(within(table).getByText('Proposta A'))
    expect((await screen.findByRole('dialog', { name: 'gaveta' })).textContent).toContain('Proposta A@pl-1')
  })

  it('a change made in the drawer re-reads in the background: drawer and columns stay on screen', async () => {
    render(<SalesForecast pipeline={pipeline} />)
    await screen.findByText('R$ 560')
    fireEvent.click(toggle(/Este mês/))
    fireEvent.click(await screen.findByText('Proposta A'))
    await screen.findByRole('dialog', { name: 'gaveta' })
    const forecastCalls = h.forecast.mock.calls.length
    const dealCalls = h.deals.mock.calls.length
    // hold the next reads open to look at the screen while they are in flight
    let release: (v: unknown) => void = () => {}
    h.forecast.mockImplementationOnce(() => new Promise((r) => (release = r)))
    h.deals.mockImplementationOnce(() => new Promise(() => {}))
    fireEvent.click(screen.getByRole('button', { name: 'salvar na gaveta' }))
    await waitFor(() => expect(h.forecast.mock.calls.length).toBe(forecastCalls + 1))
    expect(h.deals.mock.calls.length).toBe(dealCalls + 1)
    expect(screen.getByRole('dialog', { name: 'gaveta' })).toBeTruthy()
    expect(screen.getByText('R$ 560')).toBeTruthy()
    expect(screen.queryByRole('status', { name: 'Carregando a previsão…' })).toBeNull()
    expect(screen.getByText('Proposta A', { selector: 'button' })).toBeTruthy()
    release([frow({ assigned_to: 'p1', won_value: 600, open_count: 0 })])
    await waitFor(() => expect(screen.getAllByText('R$ 600').length).toBeGreaterThan(0))
    expect(screen.queryByText('R$ 560')).toBeNull()
    expect(screen.getByRole('dialog', { name: 'gaveta' })).toBeTruthy()
  })

  it('a failed refresh keeps the numbers that were on screen', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<SalesForecast pipeline={pipeline} />)
    await screen.findByText('R$ 560')
    fireEvent.click(toggle(/Este mês/))
    fireEvent.click(await screen.findByText('Proposta A'))
    h.forecast.mockRejectedValueOnce(new Error('boom'))
    fireEvent.click(screen.getByRole('button', { name: 'salvar na gaveta' }))
    await waitFor(() => expect(spy).toHaveBeenCalled())
    expect(screen.getByText('R$ 560')).toBeTruthy()
    expect(screen.queryByText('Não foi possível carregar a previsão.')).toBeNull()
    spy.mockRestore()
  })

  it('no-date column reads and lists only the deals without a date', async () => {
    render(<SalesForecast pipeline={pipeline} />)
    await screen.findByText('R$ 560')
    fireEvent.click(toggle(/Sem data/))
    await screen.findByText('Sem prazo')
    expect(h.deals.mock.calls.at(-1)?.[3]).toMatchObject({ month: null })
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

  it('shows the empty state, with its explanation, and no columns, when there is nothing to forecast', async () => {
    h.forecast.mockResolvedValue([])
    render(<SalesForecast pipeline={pipeline} />)
    expect(await screen.findByText('Ainda não há o que prever')).toBeTruthy()
    expect(screen.getByText(/Negócios abertos com data prevista de fechamento e os ganhos deste mês aparecem aqui/)).toBeTruthy()
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('shows an error inside the list when the deals cannot be read', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.deals.mockRejectedValue(new Error('boom'))
    render(<SalesForecast pipeline={pipeline} />)
    await screen.findByText('R$ 560')
    fireEvent.click(toggle(/Este mês/))
    expect(await screen.findByText('Não foi possível carregar os negócios.')).toBeTruthy()
    spy.mockRestore()
  })
})
