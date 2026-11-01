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
}))

vi.mock('@/hooks/use-auth', () => ({ useAuth: () => h.auth }))
vi.mock('@/hooks/use-teams', () => ({
  useTeams: () => ({ active: [{ id: 't1', name: 'Vendas SP' }], byId: new Map([['t1', { id: 't1', name: 'Vendas SP' }]]) }),
}))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => Promise.resolve({ data: [{ user_id: 'u-ana', full_name: 'Ana' }, { user_id: 'u-agent', full_name: 'Beto' }], error: null }),
      }),
    }),
  }),
}))
vi.mock('@/lib/sales-goals/data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sales-goals/data')>()
  return { ...actual, fetchGoalProgress: h.fetch, setGoal: h.set }
})
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
    const input = await screen.findByLabelText('Meta')
    fireEvent.change(screen.getByLabelText('Medida'), { target: { value: 'won_count' } })
    fireEvent.change(input, { target: { value: '25' } })
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar meta' }))
    await waitFor(() => expect(h.set).toHaveBeenCalledTimes(1))
    expect(h.set.mock.calls[0][1]).toBe('acc-1')
    expect(h.set.mock.calls[0][2]).toMatchObject({ scope: 'account', metric: 'won_count', target: 25, month: h.fetch.mock.calls[0][2] })
    await waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(2)) // reloads after saving
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
})
