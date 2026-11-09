// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

type Call = { table: string; cols?: string; eq?: [string, unknown]; in?: [string, unknown[]] }

const h = vi.hoisted(() => ({
  contact: { first_origin_id: null, last_origin_id: null } as { first_origin_id: string | null; last_origin_id: string | null } | null,
  contactError: null as { message: string } | null,
  rows: [] as unknown[],
  rowsError: null as { message: string } | null,
  calls: [] as Call[],
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => {
      const call: Call = { table }
      h.calls.push(call)
      const b: Record<string, unknown> = {
        select: (cols: string) => ((call.cols = cols), b),
        eq: (c: string, v: unknown) => ((call.eq = [c, v]), b),
        in: (c: string, v: unknown[]) => ((call.in = [c, v]), Promise.resolve({ data: h.rows, error: h.rowsError })),
        maybeSingle: () => Promise.resolve({ data: h.contact, error: h.contactError }),
      }
      return b
    },
  }),
}))

import { EN_TO_PT } from '@/lib/i18n'
import { registerDict } from '@/lib/i18n-runtime'
import type { LeadOrigin } from '@/lib/lead-origins'

import { ContactOrigin, OriginSummary } from './origin-line'

registerDict(EN_TO_PT)

const origin = (over: Partial<LeadOrigin> = {}): LeadOrigin => ({
  id: 'o1',
  account_id: 'a',
  contact_id: 'c',
  conversation_id: null,
  channel: 'instagram',
  kind: 'ad',
  ad_id: 'AD1',
  source_id: null,
  source_url: null,
  headline: 'Promoção sofás',
  utm_source: null,
  utm_medium: null,
  utm_campaign: null,
  utm_content: null,
  utm_term: null,
  referrer_host: null,
  click_id_type: null,
  occurred_at: '2026-11-03T15:00:00Z',
  created_at: '2026-11-03T15:00:00Z',
  ...over,
})

beforeEach(() => {
  h.contact = { first_origin_id: null, last_origin_id: null }
  h.contactError = null
  h.rows = []
  h.rowsError = null
  h.calls.length = 0
})
afterEach(cleanup)

describe('OriginSummary', () => {
  it('no touch: "Veio de: Direto ou não identificado"', () => {
    render(<OriginSummary first={null} last={null} />)
    expect(screen.getByTestId('origin-summary').textContent).toBe('Veio de: Direto ou não identificado')
  })

  it('one ad touch: name, channel and date on one line, link to the ad with its host', () => {
    const o = origin({ source_url: 'https://fb.me/x' })
    render(<OriginSummary first={o} last={o} />)
    const text = screen.getByTestId('origin-summary').textContent ?? ''
    expect(text).toContain('Veio de: Anúncio chamado “Promoção sofás” · Instagram · 3 de nov.')
    expect(text).toContain('(fb.me)')
    const link = screen.getByRole('link', { name: /Ver o anúncio/ })
    expect(link.getAttribute('href')).toBe('https://fb.me/x')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    expect(link.getAttribute('target')).toBe('_blank')
  })

  it('never renders a link for a non-http source url, nor for anything but an ad or a post', () => {
    const { rerender } = render(<OriginSummary first={null} last={origin({ source_url: 'javascript:alert(1)' })} />)
    expect(screen.queryByRole('link')).toBeNull()
    rerender(<OriginSummary first={null} last={origin({ kind: 'campaign', utm_campaign: 'bf', headline: null, ad_id: null, source_url: 'https://loja.com.br/lp' })} />)
    expect(screen.queryByRole('link')).toBeNull()
    rerender(<OriginSummary first={null} last={origin({ kind: 'post', source_url: 'https://instagram.com/p/1' })} />)
    expect(screen.getByRole('link', { name: /Ver o anúncio/ })).toBeTruthy()
  })

  it('a campaign, a referrer and a bare click id read in their own words; customer text is outside the translator', () => {
    const { container, rerender } = render(
      <OriginSummary first={null} last={origin({ channel: 'site_bot', kind: 'campaign', headline: null, ad_id: null, utm_campaign: 'black-friday', utm_source: 'google' })} />,
    )
    expect(container.textContent).toContain('Campanha chamada “black-friday” · Site · google')
    expect(container.querySelector('[data-no-translate]')?.textContent).toBe('“black-friday”')
    rerender(<OriginSummary first={null} last={origin({ channel: 'site_bot', kind: 'referrer', headline: null, ad_id: null, referrer_host: 'blog.example.org' })} />)
    expect(container.textContent).toContain('Visita vinda de blog.example.org')
    rerender(<OriginSummary first={null} last={origin({ channel: 'site_bot', kind: 'campaign', headline: null, ad_id: null, click_id_type: 'gclid' })} />)
    expect(container.textContent).toContain('Google Ads')
  })

  it('an ad without a title says so', () => {
    const o = origin({ headline: null, ad_id: null, source_id: null })
    render(<OriginSummary first={o} last={o} />)
    expect(screen.getByTestId('origin-summary').textContent).toContain('Anúncio sem título · Instagram')
  })

  it('different first and last touch: both lines', () => {
    render(
      <OriginSummary
        first={origin({ id: 'old', channel: 'site_bot', kind: 'campaign', headline: null, ad_id: null, utm_campaign: 'bf', occurred_at: '2026-11-01T12:00:00Z' })}
        last={origin({ id: 'new', headline: 'Anúncio novo', occurred_at: '2026-11-08T12:00:00Z' })}
      />,
    )
    const text = screen.getByTestId('origin-summary').textContent ?? ''
    expect(text).toContain('Primeiro contato: Campanha chamada “bf”')
    expect(text).toContain('Último contato: Anúncio chamado “Anúncio novo”')
  })

  it('loading and error states', () => {
    const { rerender } = render(<OriginSummary first={null} last={null} loading />)
    expect(screen.getByTestId('origin-summary').textContent).toBe('Carregando...')
    rerender(<OriginSummary first={null} last={null} error />)
    expect(screen.getByTestId('origin-summary').textContent).toBe('Não foi possível carregar a origem.')
  })
})

describe('ContactOrigin (reads the contact pointers, then those two touches by id)', () => {
  it('fetches exactly the two pointed touches, never click_id', async () => {
    h.contact = { first_origin_id: 'o-first', last_origin_id: 'o-last' }
    h.rows = [origin({ id: 'o-last', headline: 'Anúncio novo' }), origin({ id: 'o-first', headline: 'Anúncio antigo' })]
    render(<ContactOrigin contactId="c-9" />)
    expect(screen.getByTestId('origin-summary').textContent).toBe('Carregando...')
    await waitFor(() => expect(screen.getByTestId('origin-summary').textContent).toContain('Primeiro contato: Anúncio chamado “Anúncio antigo”'))
    expect(screen.getByTestId('origin-summary').textContent).toContain('Último contato: Anúncio chamado “Anúncio novo”')
    expect(h.calls[0]).toMatchObject({ table: 'contacts', eq: ['id', 'c-9'], cols: 'first_origin_id, last_origin_id' })
    expect(h.calls[1].table).toBe('lead_origins')
    expect(h.calls[1].in).toEqual(['id', ['o-first', 'o-last']])
    expect(h.calls[1].cols?.split(',').map((c) => c.trim())).not.toContain('click_id')
  })

  it('one pointer (or both equal) is one line and one id', async () => {
    h.contact = { first_origin_id: 'o1', last_origin_id: 'o1' }
    h.rows = [origin({ id: 'o1' })]
    render(<ContactOrigin contactId="c-9" />)
    await waitFor(() => expect(screen.getByTestId('origin-summary').textContent).toContain('Veio de: Anúncio chamado'))
    expect(h.calls[1].in).toEqual(['id', ['o1']])
  })

  it('a contact without pointers is direct and never reads lead_origins', async () => {
    render(<ContactOrigin contactId="c-9" />)
    await waitFor(() => expect(screen.getByTestId('origin-summary').textContent).toBe('Veio de: Direto ou não identificado'))
    expect(h.calls.map((c) => c.table)).toEqual(['contacts'])
  })

  it('shows the error line when a read fails, and renders nothing without a contact', async () => {
    h.contact = { first_origin_id: 'o1', last_origin_id: 'o1' }
    h.rowsError = { message: 'boom' }
    const { container, rerender } = render(<ContactOrigin contactId="c-9" />)
    await waitFor(() => expect(screen.getByTestId('origin-summary').textContent).toBe('Não foi possível carregar a origem.'))
    rerender(<ContactOrigin contactId={null} />)
    expect(container.textContent).toBe('')
    cleanup()
    h.contactError = { message: 'boom' }
    render(<ContactOrigin contactId="c-10" />)
    await waitFor(() => expect(screen.getByTestId('origin-summary').textContent).toBe('Não foi possível carregar a origem.'))
  })
})
