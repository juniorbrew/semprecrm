// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

const h = vi.hoisted(() => ({
  rows: [] as unknown[],
  error: null as { message: string } | null,
  calls: [] as { cols?: string; eq?: [string, unknown] }[],
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => {
      const call: { cols?: string; eq?: [string, unknown] } = {}
      h.calls.push(call)
      const b: Record<string, unknown> = {
        select: (cols: string) => ((call.cols = cols), b),
        eq: (c: string, v: unknown) => ((call.eq = [c, v]), b),
        order: () => b,
        limit: () => Promise.resolve({ data: h.rows, error: h.error }),
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
  h.rows = []
  h.error = null
  h.calls.length = 0
})
afterEach(cleanup)

describe('OriginSummary', () => {
  it('no touch: "Veio de: Direto ou não identificado"', () => {
    render(<OriginSummary origins={[]} />)
    expect(screen.getByTestId('origin-summary').textContent).toBe('Veio de: Direto ou não identificado')
  })

  it('one ad touch: name, channel and date on one line, link to the ad', () => {
    render(<OriginSummary origins={[origin({ source_url: 'https://fb.me/x' })]} />)
    const text = screen.getByTestId('origin-summary').textContent ?? ''
    expect(text).toContain('Veio de: Anúncio chamado “Promoção sofás” · Instagram · 3 de nov.')
    const link = screen.getByRole('link', { name: /Ver o anúncio/ })
    expect(link.getAttribute('href')).toBe('https://fb.me/x')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    expect(link.getAttribute('target')).toBe('_blank')
  })

  it('never renders a link for a non-http source url', () => {
    render(<OriginSummary origins={[origin({ source_url: 'javascript:alert(1)' })]} />)
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('a campaign and a referrer read in their own words; the customer text is outside the translator', () => {
    const { container, rerender } = render(
      <OriginSummary origins={[origin({ channel: 'site_bot', kind: 'campaign', headline: null, ad_id: null, utm_campaign: 'black-friday', utm_source: 'google' })]} />,
    )
    expect(container.textContent).toContain('Campanha chamada “black-friday” · Site · google')
    expect(container.querySelector('[data-no-translate]')?.textContent).toBe('“black-friday”')
    rerender(<OriginSummary origins={[origin({ channel: 'site_bot', kind: 'referrer', headline: null, ad_id: null, referrer_host: 'blog.example.org' })]} />)
    expect(container.textContent).toContain('Visita vinda de blog.example.org')
  })

  it('an ad without a title says so', () => {
    render(<OriginSummary origins={[origin({ headline: null, ad_id: null, source_id: null })]} />)
    expect(screen.getByTestId('origin-summary').textContent).toContain('Anúncio sem título · Instagram')
  })

  it('several touches show the first and the last contact (list is newest first)', () => {
    render(
      <OriginSummary
        origins={[
          origin({ id: 'new', headline: 'Anúncio novo', occurred_at: '2026-11-08T12:00:00Z' }),
          origin({ id: 'old', channel: 'site_bot', kind: 'campaign', headline: null, ad_id: null, utm_campaign: 'bf', occurred_at: '2026-11-01T12:00:00Z' }),
        ]}
      />,
    )
    const text = screen.getByTestId('origin-summary').textContent ?? ''
    expect(text).toContain('Primeiro contato: Campanha chamada “bf”')
    expect(text).toContain('Último contato: Anúncio chamado “Anúncio novo”')
  })

  it('loading and error states', () => {
    const { rerender } = render(<OriginSummary origins={[]} loading />)
    expect(screen.getByTestId('origin-summary').textContent).toBe('Carregando...')
    rerender(<OriginSummary origins={[]} error />)
    expect(screen.getByTestId('origin-summary').textContent).toBe('Não foi possível carregar a origem.')
  })
})

describe('ContactOrigin (fetches the contact touches)', () => {
  it('reads only the columns the browser may see (never click_id) for that contact', async () => {
    h.rows = [origin()]
    render(<ContactOrigin contactId="c-9" />)
    expect(screen.getByTestId('origin-summary').textContent).toBe('Carregando...')
    await waitFor(() => expect(screen.getByTestId('origin-summary').textContent).toContain('Anúncio chamado'))
    expect(h.calls[0].eq).toEqual(['contact_id', 'c-9'])
    expect(h.calls[0].cols).not.toContain('click_id,')
    expect(h.calls[0].cols?.split(',').map((c) => c.trim())).not.toContain('click_id')
  })

  it('shows the error line when the read fails and renders nothing without a contact', async () => {
    h.error = { message: 'boom' }
    const { container, rerender } = render(<ContactOrigin contactId="c-9" />)
    await waitFor(() => expect(screen.getByTestId('origin-summary').textContent).toBe('Não foi possível carregar a origem.'))
    rerender(<ContactOrigin contactId={null} />)
    expect(container.textContent).toBe('')
  })
})
