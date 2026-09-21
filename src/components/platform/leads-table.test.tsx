import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';

import { LeadsEmptyState, PlatformLeadsTable } from './leads-table';
import type { LeadList } from '@/lib/platform/leads';

// The table is a client component; the server snapshot is enough to check
// the markup of a rendered page. No effects, no fetches run here.
const list = (leads: LeadList['leads']): LeadList => ({
  leads,
  total: leads.length,
  new_count: 0,
  limit: 25,
  offset: 0,
});

describe('LeadsEmptyState', () => {
  it('shows the empty message when a search returned no leads', () => {
    const html = renderToString(<LeadsEmptyState hasData error="" />);
    expect(html).toContain('Nenhum lead encontrado');
  });

  it('shows the unavailable message when the initial list never loaded', () => {
    const html = renderToString(
      <LeadsEmptyState
        hasData={false}
        error="Não foi possível carregar os leads."
      />
    );
    expect(html).toContain('Lista indisponível');
  });

  it('renders nothing when a refresh failed on top of an empty result', () => {
    // The error alert already explains the failure; a second "no leads"
    // card next to it contradicts it.
    const html = renderToString(
      <LeadsEmptyState hasData error="Não foi possível atualizar a lista." />
    );
    expect(html).toBe('');
  });
});

describe('PlatformLeadsTable e-mail column', () => {
  const email =
    'atendimento.comercial.regional@exemplo-de-dominio-longo.com.br';
  const html = () =>
    renderToString(
      <PlatformLeadsTable
        initialData={list([
          {
            id: '11111111-1111-4111-8111-111111111111',
            kind: 'contato',
            status: 'novo',
            name: 'Maria',
            email,
            company: null,
            created_at: '2026-09-21T12:00:00.000Z',
            updated_at: '2026-09-21T12:00:00.000Z',
          },
        ])}
      />
    );

  it('truncates long e-mails in the desktop table instead of breaking mid-address', () => {
    const out = html();
    const cell = out
      .match(/<td[^>]*>[^<]*<\/td>/g)
      ?.find((td) => td.includes(email));
    expect(cell).toBeDefined();
    expect(cell).toContain('truncate');
    expect(cell).not.toContain('break-all');
  });

  it('exposes the full e-mail as a title so the truncated cell is still readable', () => {
    const out = html();
    const cell = out
      .match(/<td[^>]*>[^<]*<\/td>/g)
      ?.find((td) => td.includes(email));
    expect(cell).toContain(`title="${email}"`);
  });
});
