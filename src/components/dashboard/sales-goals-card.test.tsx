// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const h = vi.hoisted(() => ({
  auth: {
    accountId: 'acc-1' as string | null,
    user: { id: 'u-agent' },
    canManageMembers: true,
    defaultCurrency: 'BRL',
    preferences: { business_hours: { timezone: 'America/Sao_Paulo' } },
    profileLoading: false,
  },
  fetch: vi.fn(),
  set: vi.fn(),
  forecast: vi.fn(),
}))

vi.mock('@/hooks/use-auth', () => ({ useAuth: () => h.auth }))
vi.mock('@/hooks/use-teams', () => ({
  useTeams: () => ({ active: [{ id: 't1', name: 'Vendas SP' }], byId: new Map([['t1', { id: 't1', name: 'Vendas SP' }]]) }),
}))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => Promise.resolve({ data: [{ id: 'p-ana', user_id: 'u-ana', full_name: 'Ana' }, { id: 'p-agent', user_id: 'u-agent', full_name: 'Beto' }], error: null }),
      }),
    }),
  }),
}))
vi.mock('@/lib/sales-goals/data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sales-goals/data')>()
  return { ...actual, fetchGoalProgress: h.fetch, setGoal: h.set }
})
vi.mock('@/lib/sales-forecast/data', () => ({ fetchSalesForecast: h.forecast }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { SalesGoalsCard } from './sales-goals-card'

const company = { scope: 'account', team_id: null, user_id: null, metric: 'won_value', target: 10000, achieved: 2500, since: '2026-09-01' }
const team = { scope: 'team', team_id: 't1', user_id: null, metric: 'won_count', target: 10, achieved: 10, since: '2026-09-01' }
const mine = { scope: 'member', team_id: null, user_id: 'u-agent', metric: 'won_value', target: 4000, achieved: 1000, since: '2026-10-01' }

beforeEach(() => {
  h.auth.canManageMembers = true
  h.fetch.mockReset()
  h.set.mockReset()
  h.set.mockResolvedValue(undefined)
  h.forecast.mockReset()
  h.forecast.mockResolvedValue([])
})
afterEach(cleanup)

describe('SalesGoalsCard', () => {
  it('shows progress bars with values for an admin, plus the edit button', async () => {
    h.fetch.mockResolvedValue([company, team])
    render(<SalesGoalsCard />)
    await waitFor(() => expect(screen.getByText('Metas do mês')).toBeTruthy())
    const bars = await screen.findAllByRole('progressbar')
    expect(bars).toHaveLength(2)
    const bar = screen.getByRole('progressbar', { name: /Empresa/ })
    expect(bar.getAttribute('aria-valuenow')).toBe('25')
    expect(screen.getByText(/25%/)).toBeTruthy()
    expect(screen.getByText(/faltam/)).toBeTruthy()
    expect(screen.getByText('Vendas SP', { exact: false })).toBeTruthy()
    expect(screen.getByText('Meta batida')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Definir metas' })).toBeTruthy()
    expect(h.fetch).toHaveBeenCalledWith(expect.anything(), 'acc-1', expect.stringMatching(/^\d{4}-\d{2}-01$/))
  })

  it('agent: no edit button and own goal is labelled as theirs', async () => {
    h.auth.canManageMembers = false
    h.fetch.mockResolvedValue([company, mine])
    render(<SalesGoalsCard />)
    await screen.findAllByRole('progressbar')
    expect(screen.queryByRole('button', { name: 'Definir metas' })).toBeNull()
    expect(screen.getByRole('progressbar', { name: /Sua meta/ })).toBeTruthy()
  })

  it('agent with nothing assigned: the card disappears', async () => {
    h.auth.canManageMembers = false
    h.fetch.mockResolvedValue([])
    const { container } = render(<SalesGoalsCard />)
    await waitFor(() => expect(h.fetch).toHaveBeenCalled())
    await waitFor(() => expect(container.innerHTML).toBe(''))
  })

  it('admin with no goals sees the invitation to set the first one', async () => {
    h.fetch.mockResolvedValue([])
    render(<SalesGoalsCard />)
    expect(await screen.findByText('Nenhuma meta definida')).toBeTruthy()
    expect(screen.getByText(/Defina uma meta mensal/)).toBeTruthy()
  })

  it('past month: read-only, no edit button, no way past the current month', async () => {
    h.fetch.mockResolvedValue([company])
    render(<SalesGoalsCard />)
    await screen.findAllByRole('progressbar')
    expect(screen.getByRole('button', { name: 'Próximo mês' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Mês anterior' }))
    await waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(2))
    const pastMonth = h.fetch.mock.calls[1][2] as string
    expect(pastMonth < (h.fetch.mock.calls[0][2] as string)).toBe(true)
    await screen.findByText('Somente leitura: este mês já fechou')
    expect(screen.queryByRole('button', { name: 'Definir metas' })).toBeNull()
    expect(screen.getByText('Meta não batida')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Próximo mês' }).hasAttribute('disabled')).toBe(false)
  })

  it('admin saves a new goal from the dialog for the current month', async () => {
    h.fetch.mockResolvedValue([company])
    render(<SalesGoalsCard />)
    await screen.findAllByRole('progressbar')
    fireEvent.click(screen.getByRole('button', { name: 'Definir metas' }))
    const input = await screen.findByLabelText('Valor da meta')
    fireEvent.change(screen.getByLabelText('O que a meta mede'), { target: { value: 'won_count' } })
    fireEvent.change(input, { target: { value: '25' } })
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar meta' }))
    await waitFor(() => expect(h.set).toHaveBeenCalledTimes(1))
    expect(h.set.mock.calls[0][1]).toBe('acc-1')
    expect(h.set.mock.calls[0][2]).toMatchObject({ scope: 'account', metric: 'won_count', target: 25, month: h.fetch.mock.calls[0][2] })
    await waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(2)) // reloads after saving
  })

  it('invalid value shows a visible message linked to the input', async () => {
    h.fetch.mockResolvedValue([company])
    render(<SalesGoalsCard />)
    await screen.findAllByRole('progressbar')
    fireEvent.click(screen.getByRole('button', { name: 'Definir metas' }))
    const input = await screen.findByLabelText('Valor da meta')
    fireEvent.change(input, { target: { value: 'abc1' } })
    const msg = await screen.findByText(/Digite um número maior que zero/)
    expect(input.getAttribute('aria-describedby')).toBe(msg.id)
    expect(screen.getByRole('button', { name: 'Adicionar meta' }).hasAttribute('disabled')).toBe(true)
  })

  it('never shows another month while loading and shows the error when the fetch fails', async () => {
    h.fetch.mockResolvedValueOnce([company])
    render(<SalesGoalsCard />)
    await screen.findAllByRole('progressbar')
    h.fetch.mockRejectedValueOnce(new Error('boom'))
    fireEvent.click(screen.getByRole('button', { name: 'Mês anterior' }))
    expect(screen.queryAllByRole('progressbar')).toHaveLength(0)
    expect(await screen.findByText('Não foi possível carregar as metas.')).toBeTruthy()
  })

  it('removing a goal sends a null target', async () => {
    h.fetch.mockResolvedValue([company])
    render(<SalesGoalsCard />)
    await screen.findAllByRole('progressbar')
    fireEvent.click(screen.getByRole('button', { name: 'Definir metas' }))
    fireEvent.click(await screen.findByRole('button', { name: /Remover: Empresa/ }))
    await waitFor(() => expect(h.set).toHaveBeenCalled())
    expect(h.set.mock.calls[0][2]).toMatchObject({ scope: 'account', metric: 'won_value', target: null })
  })

  describe('Previsão do mês', () => {
    const frow = (assigned_to: string | null, won: number, weighted: number) => ({
      month: '2026-11-01', assigned_to, won_value: won, weighted_value: weighted, best_case_value: 0,
      open_count: 0, overdue_count: 0, overdue_value: 0, other_currency_count: 0,
    })

    it('value goals of the company and of a seller show the forecast and its share of the goal', async () => {
      h.fetch.mockResolvedValue([company, mine, team])
      h.forecast.mockResolvedValue([frow('p-agent', 500, 1500), frow('p-ana', 1000, 3000)])
      render(<SalesGoalsCard />)
      // company 10.000: (500+1500+1000+3000) = 6.000 = 60%; Beto 4.000: 2.000 = 50%
      expect(await screen.findByText(/Previsão do mês: R\$\s6\.000 \(60% da meta\)/)).toBeTruthy()
      expect(screen.getByText(/Previsão do mês: R\$\s2\.000 \(50% da meta\)/)).toBeTruthy()
      // the team goal (count) gets no forecast line
      expect(screen.getAllByText(/Previsão do mês:/)).toHaveLength(2)
      expect(h.forecast).toHaveBeenCalledWith(expect.anything(), 'acc-1', null, expect.stringMatching(/^\d{4}-\d{2}-01$/), 1)
    })

    it('count goals never show a forecast', async () => {
      h.fetch.mockResolvedValue([team])
      h.forecast.mockResolvedValue([frow(null, 100, 100)])
      render(<SalesGoalsCard />)
      await screen.findAllByRole('progressbar')
      await waitFor(() => expect(h.forecast).toHaveBeenCalled())
      expect(screen.queryByText(/Previsão do mês:/)).toBeNull()
    })

    it('a failed forecast read leaves the goal as it was', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      h.fetch.mockResolvedValue([company])
      h.forecast.mockRejectedValue(new Error('boom'))
      render(<SalesGoalsCard />)
      await screen.findAllByRole('progressbar')
      await waitFor(() => expect(spy).toHaveBeenCalled())
      expect(screen.queryByText(/Previsão do mês:/)).toBeNull()
      spy.mockRestore()
    })

    it('past months have no forecast line', async () => {
      h.fetch.mockResolvedValue([company])
      h.forecast.mockResolvedValue([frow(null, 100, 100)])
      render(<SalesGoalsCard />)
      await screen.findByText(/Previsão do mês:/)
      fireEvent.click(screen.getByRole('button', { name: 'Mês anterior' }))
      await screen.findByText('Somente leitura: este mês já fechou')
      expect(screen.queryByText(/Previsão do mês:/)).toBeNull()
    })
  })
})
