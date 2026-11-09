// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const h = vi.hoisted(() => ({
  canChange: true,
  touches: [] as Record<string, unknown>[],
  byId: null as Record<string, unknown> | null,
  update: vi.fn<(values: Record<string, unknown>, id: string) => Promise<{ error: { message: string } | null }>>(async () => ({ error: null })),
  toast: { success: vi.fn(), error: vi.fn() },
  onChanged: vi.fn(),
}))

vi.mock('@/hooks/use-can', () => ({ useCan: () => h.canChange }))
vi.mock('sonner', () => ({ toast: h.toast }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => {
      let id: string | null = null
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (c: string, v: string) => ((id = c === 'id' || c === 'user_id' ? v : id), b),
        order: () => b,
        limit: () => Promise.resolve({ data: h.touches, error: null }),
        maybeSingle: () =>
          Promise.resolve({ data: table === 'profiles' ? { full_name: 'Bruno Admin' } : h.byId, error: null }),
        update: (v: Record<string, unknown>) => ({ eq: (_c: string, rowId: string) => h.update(v, rowId) }),
      }
      void id
      return b
    },
  }),
}))

import { EN_TO_PT } from '@/lib/i18n'
import { registerDict } from '@/lib/i18n-runtime'

import { DealOrigin } from './deal-origin'

registerDict(EN_TO_PT)

const touch = (id: string, headline: string, at = '2026-11-03T15:00:00Z') => ({
  id, account_id: 'a', contact_id: 'c1', conversation_id: null, channel: 'instagram', kind: 'ad', ad_id: id, source_id: null,
  source_url: null, headline, utm_source: null, utm_medium: null, utm_campaign: null, utm_content: null, utm_term: null,
  referrer_host: null, click_id_type: null, occurred_at: at, created_at: at,
})

const deal = { id: 'd1', contact_id: 'c1', origin_id: 'o1' as string | null, origin_set_by: null as string | null, origin_set_at: null as string | null }

beforeEach(() => {
  h.canChange = true
  h.touches = [touch('o2', 'Anúncio novo', '2026-11-08T12:00:00Z'), touch('o1', 'Promoção sofás')]
  h.byId = null
  h.update.mockClear()
  h.toast.success.mockClear()
  h.toast.error.mockClear()
  h.onChanged.mockClear()
})
afterEach(cleanup)

describe('DealOrigin', () => {
  it('shows the origin of the deal (not the last touch of the contact)', async () => {
    render(<DealOrigin deal={deal} />)
    await waitFor(() => expect(screen.getByTestId('deal-origin').textContent).toContain('Anúncio chamado “Promoção sofás”'))
    expect(screen.getByTestId('deal-origin').textContent).not.toContain('Anúncio novo')
    expect(screen.getByTestId('deal-origin').textContent).toContain('Origem do negócio')
  })

  it('a deal without origin is "Direto ou não identificado"; loading comes first', async () => {
    render(<DealOrigin deal={{ ...deal, origin_id: null }} />)
    expect(screen.getByTestId('deal-origin').textContent).toContain('Carregando...')
    await waitFor(() => expect(screen.getByTestId('deal-origin').textContent).toContain('Direto ou não identificado'))
  })

  it('an origin that is a touch of another contact is fetched by id', async () => {
    h.byId = touch('ox', 'Anúncio de outro contato')
    render(<DealOrigin deal={{ ...deal, origin_id: 'ox' }} />)
    await waitFor(() => expect(screen.getByTestId('deal-origin').textContent).toContain('Anúncio de outro contato'))
  })

  it('non-admins cannot see the change button', async () => {
    h.canChange = false
    render(<DealOrigin deal={deal} />)
    await waitFor(() => expect(screen.getByTestId('deal-origin').textContent).toContain('Promoção sofás'))
    expect(screen.queryByRole('button', { name: 'Trocar a origem' })).toBeNull()
  })

  it('an admin picks another touch: updates the deal, thanks, and tells the board', async () => {
    render(<DealOrigin deal={deal} onChanged={h.onChanged} />)
    await waitFor(() => screen.getByRole('button', { name: 'Trocar a origem' }))
    fireEvent.click(screen.getByRole('button', { name: 'Trocar a origem' }))
    const select = screen.getByLabelText('Origem do negócio') as HTMLSelectElement
    expect(select.value).toBe('o1')
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      'Direto ou não identificado',
      'Anúncio "Anúncio novo" · Instagram',
      'Anúncio "Promoção sofás" · Instagram',
    ])
    fireEvent.change(select, { target: { value: 'o2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(h.update).toHaveBeenCalledWith({ origin_id: 'o2' }, 'd1'))
    await waitFor(() => expect(h.onChanged).toHaveBeenCalled())
    expect(h.toast.success).toHaveBeenCalledWith('Origem trocada.')
  })

  it('choosing "direct" clears it; choosing the same origin writes nothing', async () => {
    render(<DealOrigin deal={deal} />)
    await waitFor(() => screen.getByRole('button', { name: 'Trocar a origem' }))
    fireEvent.click(screen.getByRole('button', { name: 'Trocar a origem' }))
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    expect(h.update).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Trocar a origem' }))
    fireEvent.change(screen.getByLabelText('Origem do negócio'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(h.update).toHaveBeenCalledWith({ origin_id: null }, 'd1'))
  })

  it('a refusal from the database (role, billing) is an error toast, nothing else changes', async () => {
    h.update.mockResolvedValueOnce({ error: { message: 'only an admin can change the origin of a deal' } })
    render(<DealOrigin deal={deal} onChanged={h.onChanged} />)
    await waitFor(() => screen.getByRole('button', { name: 'Trocar a origem' }))
    fireEvent.click(screen.getByRole('button', { name: 'Trocar a origem' }))
    fireEvent.change(screen.getByLabelText('Origem do negócio'), { target: { value: 'o2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith('Não foi possível trocar a origem.'))
    expect(h.onChanged).not.toHaveBeenCalled()
    expect(h.toast.success).not.toHaveBeenCalled()
  })

  it('shows who changed it by hand and when', async () => {
    render(<DealOrigin deal={{ ...deal, origin_set_by: 'u-9', origin_set_at: '2026-11-05T12:00:00Z' }} />)
    await waitFor(() => expect(screen.getByTestId('deal-origin').textContent).toContain('Trocada à mão · Bruno Admin · 5 de nov.'))
  })
})
