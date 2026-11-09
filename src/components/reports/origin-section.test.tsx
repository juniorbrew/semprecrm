// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  pipelines: [{ id: 'p1', name: 'Vendas B2B' }],
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    rpc: (...a: unknown[]) => h.rpc(...a),
    from: () => ({ select: () => ({ order: () => Promise.resolve({ data: h.pipelines, error: null }) }) }),
  }),
}))

import { EN_TO_PT } from '@/lib/i18n'
import { registerDict } from '@/lib/i18n-runtime'

import { OriginSection } from './origin-section'

registerDict(EN_TO_PT)

const PERIOD = { from: '2026-11-01', to: '2026-11-30' }
const ROWS = [
  { origin_type: 'ad', channel: 'instagram', name: 'Promoção sofás', source: '', customers: 2, deals_created: 3, deals_won: 2, won_value: 1500, conversion_pct: 66.7, avg_ticket: 750 },
  { origin_type: 'campaign', channel: 'site_bot', name: 'black-friday', source: 'google', customers: 1, deals_created: 1, deals_won: 1, won_value: 300, conversion_pct: 100, avg_ticket: 300 },
  { origin_type: 'direct', channel: '', name: '', source: '', customers: 1, deals_created: 2, deals_won: 0, won_value: 0, conversion_pct: 0, avg_ticket: 0 },
]

const renderSection = (over: Partial<Parameters<typeof OriginSection>[0]> = {}) =>
  render(<OriginSection period={PERIOD} periodOk timezone="America/Sao_Paulo" currency="BRL" {...over} />)

beforeEach(() => {
  h.rpc.mockReset()
  h.rpc.mockResolvedValue({ data: ROWS, error: null })
})
afterEach(cleanup)

describe('OriginSection', () => {
  it('asks origin_report for the period of the page in the account time zone', async () => {
    renderSection()
    await waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(1))
    expect(h.rpc).toHaveBeenCalledWith('origin_report', {
      p_start: '2026-11-01T03:00:00.000Z', // Sao Paulo is UTC-3
      p_end: '2026-12-01T03:00:00.000Z',
      p_channel: null,
      p_pipeline_id: null,
    })
  })

  it('shows one row per origin with the numbers of the database, and "Direto" for no origin', async () => {
    renderSection()
    const table = await screen.findByTestId('origin-table')
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(3)
    const ad = rows[0].textContent ?? ''
    expect(ad).toContain('Anúncio chamado “Promoção sofás” · Instagram')
    expect(ad).toContain('R$')
    expect(ad).toContain('1.500')
    expect(ad).toContain('66,7%')
    expect(ad).toContain('750')
    expect(rows[1].textContent).toContain('Campanha chamada “black-friday” · Site · google')
    expect(rows[2].textContent).toContain('Direto ou não identificado')
    // a direct bucket with nothing won has no ticket to show
    expect(rows[2].textContent).toContain('—')
    for (const head of ['Clientes novos', 'Negócios criados', 'Negócios ganhos', 'Valor vendido', 'Taxa de conversão', 'Ticket médio']) {
      expect(within(table).getByText(head)).toBeTruthy()
    }
  })

  it('draws the origins that sold, biggest first, and leaves out the ones that did not', async () => {
    renderSection()
    const chart = await screen.findByTestId('origin-chart')
    const items = within(chart).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0].textContent).toContain('Promoção sofás')
    expect(items[1].textContent).toContain('black-friday')
  })

  it('keeps at most 10 bars', async () => {
    h.rpc.mockResolvedValue({
      data: Array.from({ length: 14 }, (_, i) => ({ ...ROWS[0], name: `Anúncio ${i}`, won_value: 100 + i, deals_won: 1 })),
      error: null,
    })
    renderSection()
    const chart = await screen.findByTestId('origin-chart')
    expect(within(chart).getAllByRole('listitem')).toHaveLength(10)
  })

  it('empty: one sentence, no table and no export', async () => {
    h.rpc.mockResolvedValue({ data: [], error: null })
    renderSection()
    expect((await screen.findByTestId('origin-empty')).textContent).toBe('Nenhum cliente ou negócio neste período.')
    expect(screen.queryByTestId('origin-table')).toBeNull()
    expect((screen.getByRole('button', { name: /Exportar CSV/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('loading first, then error with a retry that asks again', async () => {
    h.rpc.mockRejectedValueOnce(new Error('boom'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    renderSection()
    expect(screen.getByText('Carregando...')).toBeTruthy()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Não foi possível carregar a origem dos clientes.')
    fireEvent.click(within(alert).getByRole('button', { name: 'Tentar novamente' }))
    await screen.findByTestId('origin-table')
    expect(h.rpc).toHaveBeenCalledTimes(2)
    spy.mockRestore()
  })

  it('an RPC error object (not a throw) is an error too', async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { message: 'permission denied' } })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    renderSection()
    expect((await screen.findByRole('alert')).textContent).toContain('Não foi possível carregar')
    spy.mockRestore()
  })

  it('the channel and pipeline filters go to the database', async () => {
    renderSection()
    await screen.findByTestId('origin-table')
    await waitFor(() => expect(within(screen.getByTestId('origin-pipeline')).getAllByRole('option')).toHaveLength(2))
    fireEvent.change(screen.getByTestId('origin-channel'), { target: { value: 'instagram' } })
    await waitFor(() => expect(h.rpc).toHaveBeenLastCalledWith('origin_report', expect.objectContaining({ p_channel: 'instagram', p_pipeline_id: null })))
    fireEvent.change(screen.getByTestId('origin-pipeline'), { target: { value: 'p1' } })
    await waitFor(() => expect(h.rpc).toHaveBeenLastCalledWith('origin_report', expect.objectContaining({ p_channel: 'instagram', p_pipeline_id: 'p1' })))
  })

  it('does not ask while the period is invalid', async () => {
    renderSection({ periodOk: false })
    await new Promise((r) => setTimeout(r, 20))
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('exports the rows as CSV, with a formula in an ad title stays text', async () => {
    h.rpc.mockResolvedValue({ data: [{ ...ROWS[0], name: '=HYPERLINK("http://x")' }], error: null })
    let blob: Blob | null = null
    URL.createObjectURL = vi.fn((b: Blob) => {
      blob = b
      return 'blob:x'
    })
    URL.revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    renderSection()
    await screen.findByTestId('origin-table')
    fireEvent.click(screen.getByRole('button', { name: /Exportar CSV/ }))
    expect(click).toHaveBeenCalled()
    const text = await (blob as unknown as Blob).text()
    // Blob.text() drops the BOM; Excel needs it, so check the raw bytes
    expect([...new Uint8Array(await (blob as unknown as Blob).slice(0, 3).arrayBuffer())]).toEqual([0xef, 0xbb, 0xbf])
    expect(text.startsWith('periodo;2026-11-01;2026-11-30')).toBe(true)
    // every label starts with a fixed word, so a customer text can never open a cell with = + - @
    expect(text.split(/\r?\n/)[2].startsWith('"Anúncio ""=HYPERLINK')).toBe(true)
    click.mockRestore()
  })
})
