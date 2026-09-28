import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';

import type { Company, CompanySummary } from '@/lib/companies';
import { companyAddressLine } from './company-detail-sheet';
import { CompanyFormBody } from './company-form-dialog';
import { ContactCompanies } from './contact-companies';
import { CompanyLine } from './company-pickers';
import { DealCompanyField } from './deal-company-field';

// Client components rendered to a string: markup + pt-BR copy (the
// language hook falls back to the default catalogue). Effects never
// run, so the Supabase client must not be touched while rendering.
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    throw new Error('createClient must only be called from effects/handlers');
  },
}));

const summary: CompanySummary = {
  id: 'co-1',
  razao_social: 'Padaria Sol LTDA',
  nome_fantasia: 'Padaria do Sol',
  cnpj: '11222333000181',
  cidade: 'Porto Alegre',
  uf: 'RS',
};

const company: Company = {
  ...summary,
  account_id: 'acct-1',
  email: 'sol@padaria.com.br',
  phone: '5136354333',
  cep: '90000000',
  logradouro: 'Rua Garibaldi',
  numero: '70',
  complemento: 'Sala 2',
  bairro: 'Centro',
  cnae: '1091102',
  atividade: 'Fabricação de produtos de padaria',
  notes: null,
  created_by: null,
  created_at: '2026-09-27T00:00:00Z',
  updated_at: '2026-09-27T00:00:00Z',
};

describe('CompanyFormBody', () => {
  it('renders an empty create form with the CNPJ lookup button disabled until the CNPJ is valid', () => {
    const html = renderToString(<CompanyFormBody company={null} onSaved={() => {}} onCancel={() => {}} />);
    expect(html).toContain('Buscar dados');
    expect(html).toContain('Razão social');
    expect(html).toContain('Nome fantasia');
    expect(html).toContain('Criar empresa');
    expect(html).toContain('id="address-cep"');
    expect(html).toMatch(/<button[^>]* disabled=""[^>]*>(?:(?!<\/button>).)*Buscar dados/);
  });

  it('prefills an existing company, masked, with Salvar alterações', () => {
    const html = renderToString(<CompanyFormBody company={company} onSaved={() => {}} onCancel={() => {}} />);
    expect(html).toContain('value="11.222.333/0001-81"');
    expect(html).toContain('value="Padaria Sol LTDA"');
    expect(html).toContain('value="(51) 3635-4333"');
    expect(html).toContain('value="90000-000"');
    expect(html).toMatch(/CNAE (<!-- -->)?1091102/);
    expect(html).toContain('Salvar alterações');
    expect(html).not.toMatch(/<button[^>]* disabled=""[^>]*>(?:(?!<\/button>).)*Buscar dados/);
  });
});

describe('DealCompanyField', () => {
  it('offers "Escolher empresa" when the deal has none, and nothing to click when read-only', () => {
    expect(renderToString(<DealCompanyField company={null} onChange={() => {}} />)).toContain('Escolher empresa');
    const ro = renderToString(<DealCompanyField company={null} onChange={() => {}} readOnly />);
    expect(ro).toContain('Sem empresa');
    expect(ro).not.toContain('<button');
  });

  it('shows the company with change / remove and the default hint', () => {
    const html = renderToString(
      <DealCompanyField company={summary} onChange={() => {}} hint="Empresa principal do contato" linkToCompany />,
    );
    expect(html).toContain('Padaria do Sol');
    expect(html).toContain('11.222.333/0001-81 · Porto Alegre/RS');
    expect(html).toContain('aria-label="Trocar empresa"');
    expect(html).toContain('aria-label="Tirar empresa"');
    expect(html).toContain('href="/companies?company=co-1"');
    expect(html).toContain('Empresa principal do contato');
    const ro = renderToString(<DealCompanyField company={summary} onChange={() => {}} readOnly />);
    expect(ro).not.toContain('Trocar empresa');
  });
});

describe('company display', () => {
  it('shows the razão social under a different trade name', () => {
    const html = renderToString(<CompanyLine company={summary} />);
    expect(html).toContain('Padaria do Sol');
    expect(html).toContain('Padaria Sol LTDA');
  });

  it('builds the address line from the split columns', () => {
    expect(companyAddressLine(company)).toBe('Rua Garibaldi, 70 — Sala 2 · Centro · Porto Alegre/RS · 90000-000');
    expect(companyAddressLine({ ...company, logradouro: null, numero: null, complemento: null, bairro: null, cep: null })).toBe(
      'Porto Alegre/RS',
    );
  });
});

describe('pt-BR copy for the review fixes', () => {
  it('translates the Empresas role gate like the contacts one', async () => {
    const { translateLiteral } = await import('@/lib/i18n');
    expect(translateLiteral("Read-only — your role can't add companies", 'pt-BR')).toBe(
      'Somente leitura — seu perfil não pode cadastrar empresas',
    );
    expect(translateLiteral("Read-only — your role can't add or import contacts", 'pt-BR')).toMatch(/^Somente leitura — seu perfil não pode/);
    expect(translateLiteral('Link this company', 'pt-BR')).toBe('Vincular esta empresa');
  });
});

describe('ContactCompanies (inbox panel variant)', () => {
  it('renders the panel header with the read-only flag instead of the built-in one', () => {
    const html = renderToString(
      <ContactCompanies
        contactId="c-1"
        compact
        readOnly
        header={({ count, readOnly }) => (
          <p data-testid="panel-header">{`Empresas ${count} ${readOnly ? 'ro' : 'rw'}`}</p>
        )}
      />,
    );
    expect(html).toContain('Empresas 0 ro');
    expect(html).not.toContain('Vincular empresa');
  });
});
