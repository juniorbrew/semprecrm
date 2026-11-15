// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  upsert: vi.fn(),
  saved: { current: null as number | null },
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    rpc: (...a: unknown[]) => h.rpc(...a),
    from: (table: string) => {
      if (table === 'ad_spend') {
        const chain: Record<string, unknown> = {}
        chain.eq = () => chain
        chain.maybeSingle = async () => ({ data: h.saved.current == null ? null : { amount_cents: h.saved.current }, error: null })
        return { select: () => chain, upsert: (...a: unknown[]) => h.upsert(...a) }
      }
      return { select: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }
    },
  }),
}))

import { EN_TO_PT } from '@/lib/i18n'
import { registerDict } from '@/lib/i18n-runtime'

import { AiSection } from './ai-section'
import { OriginSection } from './origin-section'
import { TeamSection } from './team-section'

registerDict(EN_TO_PT)

const PERIOD = { from: '2026-11-10', to: '2026-11-20' }
const AD = { origin_type: 'ad', channel: 'instagram', name: 'Promoção sofás', source: '', customers: 4, deals_created: 3, deals_won: 2, won_value: 1500, conversion_pct: 66.7, avg_ticket: 750, spend_cents: 30000 }
const CAMPAIGN = { origin_type: 'campaign', channel: 'site_bot', name: 'black-friday', source: 'google', customers: 1, deals_created: 1, deals_won: 0, won_value: 0, conversion_pct: 0, avg_ticket: 0, spend_cents: null }
const DIRECT = { origin_type: 'direct', channel: '', name: '', source: '', customers: 1, deals_created: 0, deals_won: 0, won_value: 0, conversion_pct: 0, avg_ticket: 0, spend_cents: null }

beforeEach(() => {
  h.rpc.mockReset()
  h.upsert.mockReset()
  h.upsert.mockResolvedValue({ error: null })
  h.saved.current = null
})
afterEach(cleanup)

describe('OriginSection: spend columns', () => {
  const renderOrigin = (over: Partial<Parameters<typeof OriginSection>[0]> = {}) =>
    render(<OriginSection period={PERIOD} periodOk timezone="America/Sao_Paulo" currency="BRL" {...over} />)

  it('shows spend, cost per customer, cost per sale and return; rows without a spend show a dash', async () => {
    h.rpc.mockResolvedValue({ data: [AD, CAMPAIGN, DIRECT], error: null })
    renderOrigin()
    const table = await screen.findByTestId('origin-table')
    const rows = within(table).getAllByRole('row').slice(1)
    const cells = (i: number) => within(rows[i]).getAllByRole('cell').map((c) => c.textContent ?? '')
    // customers, deals, won, won value, conversion, ticket, spend, cost/customer, cost/sale, return
    const ad = cells(0)
    expect(ad[6]).toContain('300,00') // spend 30000 cents
    expect(ad[7]).toContain('75,00') // 300 / 4 customers
    expect(ad[8]).toContain('150,00') // 300 / 2 sales
    expect(ad[9]).toBe('5,0×') // 1500 / 300
    expect(cells(1).slice(6)).toEqual(['—', '—', '—', '—'])
    expect(cells(2).slice(6)).toEqual(['—', '—', '—', '—'])
    for (const head of ['Gasto com anúncios', 'Custo por cliente', 'Custo por venda', 'Retorno do gasto']) {
      expect(within(table).getByText(head)).toBeTruthy()
    }
  })

  it('a spend with no customer or sale divides nothing: dashes, never Infinity or NaN', async () => {
    h.rpc.mockResolvedValue({ data: [{ ...CAMPAIGN, customers: 0, spend_cents: 5000 }], error: null })
    renderOrigin()
    const table = await screen.findByTestId('origin-table')
    const cells = within(within(table).getAllByRole('row')[1]).getAllByRole('cell').map((c) => c.textContent ?? '')
    expect(cells[6]).toContain('50,00')
    expect(cells[7]).toBe('—')
    expect(cells[8]).toBe('—')
    expect(cells[9]).toBe('0,0×')
    expect(table.textContent).not.toMatch(/Infinity|NaN/)
  })

  it('explains that the spend counts whole months', async () => {
    h.rpc.mockResolvedValue({ data: [AD], error: null })
    renderOrigin()
    expect((await screen.findByTestId('origin-spend-note')).textContent).toContain('meses inteiros')
  })

  it('only an admin gets the "Informar gasto" button, and never on the direct row', async () => {
    h.rpc.mockResolvedValue({ data: [AD, CAMPAIGN, DIRECT], error: null })
    const { unmount } = renderOrigin()
    await screen.findByTestId('origin-table')
    expect(screen.queryAllByTestId('origin-spend-button')).toHaveLength(0)
    unmount()
    renderOrigin({ accountId: 'acc-1', canEditSpend: true })
    await screen.findByTestId('origin-table')
    expect(screen.getAllByTestId('origin-spend-button')).toHaveLength(2)
  })

  it('the dialog saves the amount of the chosen month and the table asks again', async () => {
    h.rpc.mockResolvedValue({ data: [AD, CAMPAIGN], error: null })
    renderOrigin({ accountId: 'acc-1', canEditSpend: true })
    await screen.findByTestId('origin-table')
    fireEvent.click(screen.getAllByTestId('origin-spend-button')[0])
    const dialog = await screen.findByRole('dialog')
    expect((within(dialog).getByLabelText('Mês do gasto') as HTMLInputElement).value).toBe('2026-11')
    const amount = within(dialog).getByLabelText('Valor gasto') as HTMLInputElement
    await waitFor(() => expect(amount.disabled).toBe(false))
    fireEvent.change(amount, { target: { value: '1.234,56' } })
    const callsBefore = h.rpc.mock.calls.length
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar gasto' })))
    expect(h.upsert).toHaveBeenCalledWith(
      { account_id: 'acc-1', origin_type: 'ad', channel: 'instagram', name: 'Promoção sofás', source: '', month: '2026-11-01', amount_cents: 123456 },
      { onConflict: 'account_id,origin_type,channel,name,source,month' },
    )
    await waitFor(() => expect(h.rpc.mock.calls.length).toBeGreaterThan(callsBefore))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('the dialog shows the saved amount, refuses text that is not an amount and shows a save error', async () => {
    h.saved.current = 5000
    h.rpc.mockResolvedValue({ data: [AD], error: null })
    renderOrigin({ accountId: 'acc-1', canEditSpend: true })
    await screen.findByTestId('origin-table')
    fireEvent.click(screen.getByTestId('origin-spend-button'))
    const dialog = await screen.findByRole('dialog')
    const amount = within(dialog).getByLabelText('Valor gasto') as HTMLInputElement
    await waitFor(() => expect(amount.value).toBe('50,00'))
    const save = within(dialog).getByRole('button', { name: 'Salvar gasto' }) as HTMLButtonElement
    fireEvent.change(amount, { target: { value: 'abc' } })
    expect(save.disabled).toBe(true)
    fireEvent.change(amount, { target: { value: '70' } })
    h.upsert.mockResolvedValue({ error: new Error('rls') })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => fireEvent.click(save))
    expect((await within(dialog).findByRole('alert')).textContent).toContain('Não foi possível salvar o gasto.')
    expect(screen.getByRole('dialog')).toBeTruthy()
    spy.mockRestore()
  })
})

describe('AiSection', () => {
  const AI = { ai_enabled: true, attended: 12, handed_off: 3, top_reason: 'preço', top_reason_count: 2, resolved_without_person: 7, ai_messages: 40,
    cost_by_feature: [{ feature: 'auto_reply', calls: 30, cost_cents: 250 }, { feature: 'triage', calls: 5, cost_cents: 50 }] }
  const renderAi = () => render(<AiSection accountId="acc-1" period={PERIOD} periodOk timezone="America/Sao_Paulo" />)

  it('shows the numbers and the cost in dollars by feature', async () => {
    h.rpc.mockResolvedValue({ data: [AI], error: null })
    renderAi()
    const numbers = await screen.findByTestId('ai-numbers')
    expect(numbers.textContent).toContain('Conversas atendidas pela IA')
    for (const n of ['12', '3', '7', '40']) expect(within(numbers).getByText(n)).toBeTruthy()
    expect(numbers.textContent).toContain('Motivo mais comum')
    expect(numbers.textContent).toContain('preço')
    const cost = screen.getByTestId('ai-cost')
    expect(cost.textContent).toContain('3,00') // 250 + 50 cents
    expect(cost.textContent).toContain('Resposta automática')
    expect(cost.textContent).toContain('Triagem de conversas')
    expect(cost.textContent).toContain('US$')
    expect(h.rpc).toHaveBeenCalledWith('ai_report', { p_account_id: 'acc-1', p_start: '2026-11-10T03:00:00.000Z', p_end: '2026-11-21T03:00:00.000Z' })
  })

  it('no cost block for someone who cannot see the cost', async () => {
    h.rpc.mockResolvedValue({ data: [{ ...AI, cost_by_feature: null }], error: null })
    renderAi()
    await screen.findByTestId('ai-numbers')
    expect(screen.queryByTestId('ai-cost')).toBeNull()
  })

  it('AI off and unused: an empty state with a link to Settings', async () => {
    h.rpc.mockResolvedValue({ data: [{ ai_enabled: false, attended: 0, ai_messages: 0, cost_by_feature: [] }], error: null })
    renderAi()
    const empty = await screen.findByTestId('ai-empty')
    expect(empty.textContent).toContain('A IA não está ligada nesta conta.')
    expect(within(empty).getByRole('link').getAttribute('href')).toBe('/settings?tab=ai')
    expect(screen.queryByTestId('ai-numbers')).toBeNull()
  })

  it('loading first, then error with a retry that asks again', async () => {
    h.rpc.mockRejectedValueOnce(new Error('boom'))
    h.rpc.mockResolvedValue({ data: [AI], error: null })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    renderAi()
    expect(screen.getByText('Carregando...')).toBeTruthy()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Não foi possível carregar o resultado da IA.')
    fireEvent.click(within(alert).getByRole('button', { name: 'Tentar novamente' }))
    await screen.findByTestId('ai-numbers')
    expect(h.rpc).toHaveBeenCalledTimes(2)
    spy.mockRestore()
  })

  it('does not ask while the period is invalid or there is no account yet', async () => {
    render(<AiSection accountId="acc-1" period={PERIOD} periodOk={false} timezone="UTC" />)
    render(<AiSection accountId={null} period={PERIOD} periodOk timezone="UTC" />)
    await new Promise((r) => setTimeout(r, 20))
    expect(h.rpc).not.toHaveBeenCalled()
  })
})

describe('TeamSection', () => {
  const MEMBERS = new Map([['u1', 'Ana'], ['u2', 'Bruno']])
  const ROWS = [
    { user_id: 'u1', handled: 10, resolved: 8, first_response_avg_seconds: 90, tasks_completed: 3, open_assigned: 2, deals_won: 2, deals_lost: 1, won_value: 1500 },
    { user_id: 'u2', handled: 0, resolved: 0, first_response_avg_seconds: null, tasks_completed: 0, open_assigned: 0, deals_won: 0, deals_lost: 0, won_value: 0 },
  ]
  const renderTeam = (members = MEMBERS) =>
    render(<TeamSection accountId="acc-1" period={PERIOD} periodOk timezone="America/Sao_Paulo" currency="BRL" members={members} />)

  it('one row per member with the numbers, the win rate and dashes where there is nothing', async () => {
    h.rpc.mockResolvedValue({ data: ROWS, error: null })
    renderTeam()
    const table = await screen.findByTestId('team-table')
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('Ana')
    const ana = within(rows[0]).getAllByRole('cell').map((c) => c.textContent ?? '')
    expect(ana.slice(0, 3)).toEqual(['10', '8', '1 min 30 s'])
    expect(ana[5]).toBe('2')
    expect(ana[6]).toContain('1.500')
    expect(ana[7]).toBe('66,7%') // 2 won of 3 closed
    const bruno = within(rows[1]).getAllByRole('cell').map((c) => c.textContent ?? '')
    expect(bruno[2]).toBe('—')
    expect(bruno[7]).toBe('—') // nothing closed: no win rate
    expect(table.textContent).not.toMatch(/NaN|Infinity/)
    expect(h.rpc).toHaveBeenCalledWith('team_report', { p_account_id: 'acc-1', p_start: '2026-11-10T03:00:00.000Z', p_end: '2026-11-21T03:00:00.000Z' })
  })

  it('names are data (never translated)', async () => {
    h.rpc.mockResolvedValue({ data: ROWS, error: null })
    renderTeam()
    const table = await screen.findByTestId('team-table')
    expect(within(table).getByText('Ana').closest('[data-no-translate]')).toBeTruthy()
  })

  it('empty: one sentence and no table', async () => {
    h.rpc.mockResolvedValue({ data: [], error: null })
    renderTeam()
    expect((await screen.findByTestId('team-empty')).textContent).toBe('Nenhum membro da equipe nesta conta.')
    expect(screen.queryByTestId('team-table')).toBeNull()
  })

  it('loading, then error with a retry', async () => {
    h.rpc.mockRejectedValueOnce(new Error('boom'))
    h.rpc.mockResolvedValue({ data: ROWS, error: null })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    renderTeam()
    expect(screen.getByText('Carregando...')).toBeTruthy()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Não foi possível carregar o desempenho da equipe.')
    fireEvent.click(within(alert).getByRole('button', { name: 'Tentar novamente' }))
    await screen.findByTestId('team-table')
    spy.mockRestore()
  })
})
