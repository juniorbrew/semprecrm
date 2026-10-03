import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import type { CompanyListItem } from '@/lib/companies';
import {
  COMPANIES_COPY,
  CompanyListRow,
  companyInitials,
  companyMetaLine,
  readCompaniesDensity,
  writeCompaniesDensity,
  type CompanyListRowProps,
} from './company-list-row';

const company = (over: Partial<CompanyListItem> = {}): CompanyListItem =>
  ({
    id: 'co-1',
    razao_social: 'Padaria Sol LTDA',
    nome_fantasia: 'Padaria do Sol',
    cnpj: '11222333000181',
    cidade: 'Porto Alegre',
    uf: 'RS',
    contacts_count: 3,
    ...over,
  }) as CompanyListItem;

const render = (c: CompanyListItem, extra: Partial<CompanyListRowProps> = {}) =>
  renderToString(
    <table>
      <tbody>
        <CompanyListRow
          company={c}
          selected={false}
          compact={false}
          canEdit
          copy={COMPANIES_COPY['pt-BR']}
          onToggleSelect={() => {}}
          onOpen={() => {}}
          onEdit={() => {}}
          onDelete={() => {}}
          {...extra}
        />
      </tbody>
    </table>,
  );

describe('companyMetaLine', () => {
  it('joins razão social (only when it differs), CNPJ and place', () => {
    expect(companyMetaLine(company())).toBe('Padaria Sol LTDA · 11.222.333/0001-81 · Porto Alegre/RS');
    expect(companyMetaLine(company({ nome_fantasia: null }))).toBe('11.222.333/0001-81 · Porto Alegre/RS');
    expect(companyMetaLine(company({ nome_fantasia: null, cnpj: null, cidade: null, uf: null }))).toBe('');
    expect(companyMetaLine(company(), { withPlace: false })).toBe('Padaria Sol LTDA · 11.222.333/0001-81');
  });
});

describe('companyInitials', () => {
  it('takes the first letters of the first two words', () => {
    expect(companyInitials('Padaria do Sol')).toBe('PD');
    expect(companyInitials('acme')).toBe('AC');
    expect(companyInitials('  ')).toBe('');
  });
});

describe('CompanyListRow', () => {
  it('shows the trade name, meta line, contact count and labelled controls', () => {
    const html = render(company());
    expect(html).toContain('Padaria do Sol');
    expect(html).toContain('11.222.333/0001-81');
    expect(html).toContain('3 contatos');
    expect(html).toContain('aria-label="Abrir Padaria do Sol"');
    expect(html).toContain('aria-label="Mais ações para Padaria do Sol"');
  });

  it('marks the selected row with the brand tint and accent', () => {
    const html = render(company(), { selected: true });
    expect(html).toContain('data-selected="true"');
    expect(html).toContain('bg-primary/10');
    expect(html).toContain('shadow-[inset_3px_0_0_var(--primary)]');
  });

  it('hides the quick edit for read-only roles', () => {
    expect(render(company())).toContain('title="Editar"');
    expect(render(company(), { canEdit: false })).not.toContain('title="Editar"');
  });

  it('compact density uses the small avatar', () => {
    expect(render(company(), { compact: true })).toContain('size-7');
    expect(render(company())).toContain('size-9');
  });
});

describe('density preference', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('round-trips per user and survives a throwing localStorage', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    expect(readCompaniesDensity('u1')).toBe('comfortable');
    writeCompaniesDensity('u1', 'compact');
    expect(store.get('sempre:companies:density:u1')).toBe('compact');
    expect(readCompaniesDensity('u1')).toBe('compact');
    expect(readCompaniesDensity('u2')).toBe('comfortable');

    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(readCompaniesDensity('u1')).toBe('comfortable');
    expect(() => writeCompaniesDensity('u1', 'compact')).not.toThrow();
  });
});
