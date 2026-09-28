import { describe, expect, it } from 'vitest';

import {
  CompanyError,
  companyErrorFromDb,
  companyErrorMessage,
  companySearchFilter,
  createCompany,
  deleteCompany,
  findCompanyByCnpj,
  getPrimaryCompany,
  getCompany,
  isUuid,
  listCompanyContacts,
  listCompanyDeals,
  linkContactCompany,
  listCompanies,
  listContactCompanies,
  listPrimaryCompanies,
  primaryCompanyId,
  sanitizeCompanySearch,
  setDealCompany,
  setPrimaryCompany,
  sortContactCompanies,
  unlinkContactCompany,
  updateCompany,
  type CompaniesClient,
} from './data';
import type { CompanyRow } from './types';

// ------------------------------------------------------------
// A PostgREST-ish builder that records every call and resolves to a
// canned `{ data, error, count }` — enough to assert what the data
// layer asks the database for and how it reads the answer.
// ------------------------------------------------------------
type Result = { data?: unknown; error?: { code?: string; message?: string } | null; count?: number | null };

function fakeDb(result: Result) {
  const calls: { table: string; ops: [string, ...unknown[]][] }[] = [];
  const db = {
    from(table: string) {
      const entry = { table, ops: [] as [string, ...unknown[]][] };
      calls.push(entry);
      const settled = { data: result.data ?? null, error: result.error ?? null, count: result.count ?? null };
      const builder: Record<string, unknown> = {};
      for (const op of ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'in', 'or', 'order', 'range', 'limit']) {
        builder[op] = (...args: unknown[]) => {
          entry.ops.push([op, ...args]);
          return builder;
        };
      }
      builder.single = async () => settled;
      builder.maybeSingle = async () => settled;
      builder.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(settled).then(resolve, reject);
      return builder;
    },
  };
  return { db: db as unknown as CompaniesClient, calls };
}

const row: CompanyRow = {
  cnpj: '11222333000181',
  razao_social: 'Padaria Sol LTDA',
  nome_fantasia: null,
  email: null,
  phone: null,
  cep: null,
  logradouro: null,
  numero: null,
  complemento: null,
  bairro: null,
  cidade: 'Porto Alegre',
  uf: 'RS',
  cnae: null,
  atividade: null,
  notes: null,
};

describe('search helpers', () => {
  it('strips PostgREST syntax and wildcards from the term', () => {
    expect(sanitizeCompanySearch(' Sol, (LTDA) 100% ')).toBe('Sol LTDA 100');
    expect(sanitizeCompanySearch('a_b\\c*d:"e"')).toBe('a b c d e');
  });

  it('searches name and trade name, and the CNPJ when the term looks like one', () => {
    expect(companySearchFilter('')).toBeNull();
    expect(companySearchFilter('padaria')).toBe('razao_social.ilike.%padaria%,nome_fantasia.ilike.%padaria%');
    expect(companySearchFilter('11.222.333')).toBe(
      'razao_social.ilike.%11.222.333%,nome_fantasia.ilike.%11.222.333%,cnpj.ilike.%11222333%',
    );
  });
});

describe('error mapping', () => {
  it('turns Postgres codes into CompanyError codes and message keys', () => {
    expect(companyErrorFromDb({ code: '23505' }, 'duplicate_cnpj').code).toBe('duplicate_cnpj');
    expect(companyErrorFromDb({ code: '23505' }, 'already_linked').code).toBe('already_linked');
    expect(companyErrorFromDb({ code: '23503' }, 'already_linked').code).toBe('not_found');
    expect(companyErrorFromDb({ code: '42501' }, 'duplicate_cnpj').code).toBe('forbidden');
    expect(companyErrorFromDb({ code: '23514' }, 'duplicate_cnpj').code).toBe('invalid');
    expect(companyErrorFromDb({ code: 'XX000' }, 'duplicate_cnpj').code).toBe('failed');
    expect(companyErrorMessage(new CompanyError('duplicate_cnpj'))).toBe('A company with this CNPJ already exists');
    expect(companyErrorMessage(new CompanyError('forbidden'))).toBe('You do not have permission to change companies');
    expect(companyErrorMessage(new Error('boom'))).toBe('Something went wrong. Please try again.');
  });
});

describe('companies CRUD', () => {
  it('lists a page ordered by razão social with the contact count flattened', async () => {
    const { db, calls } = fakeDb({
      data: [{ id: 'c1', razao_social: 'A', contact_companies: [{ count: 3 }] }],
      count: 41,
    });
    const out = await listCompanies(db, { search: 'sol', page: 1, pageSize: 20 });
    expect(out.total).toBe(41);
    expect(out.rows[0]).toMatchObject({ id: 'c1', contacts_count: 3 });
    expect(out.rows[0]).not.toHaveProperty('contact_companies');
    const ops = calls[0].ops;
    expect(calls[0].table).toBe('companies');
    expect(ops).toContainEqual(['range', 20, 39]);
    expect(ops).toContainEqual(['or', 'razao_social.ilike.%sol%,nome_fantasia.ilike.%sol%']);
  });

  it('creates with the account and author from the context, not the row', async () => {
    const { db, calls } = fakeDb({ data: { id: 'new', ...row } });
    await createCompany(db, { accountId: 'acct-1', userId: 'user-1' }, row);
    const insert = calls[0].ops.find(([op]) => op === 'insert');
    expect(insert?.[1]).toMatchObject({ account_id: 'acct-1', created_by: 'user-1', cnpj: '11222333000181' });
  });

  it('reports a duplicate CNPJ as duplicate_cnpj', async () => {
    const { db } = fakeDb({ error: { code: '23505', message: 'duplicate key value violates unique constraint' } });
    await expect(createCompany(db, { accountId: 'a', userId: null }, row)).rejects.toMatchObject({ code: 'duplicate_cnpj' });
  });

  it('treats an update or delete that touched no row as forbidden (RLS hides it)', async () => {
    await expect(updateCompany(fakeDb({ data: null }).db, 'c1', row)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(deleteCompany(fakeDb({ data: [] }).db, 'c1')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(deleteCompany(fakeDb({ data: [{ id: 'c1' }] }).db, 'c1')).resolves.toBeUndefined();
  });

  it('looks a CNPJ up normalised, scoped to the account and skipping the company being edited', async () => {
    const { db, calls } = fakeDb({ data: [{ id: 'c9', razao_social: 'Sol' }] });
    const out = await findCompanyByCnpj(db, '11.222.333/0001-81', { accountId: 'acct-1', excludeId: 'c1' });
    expect(out).toMatchObject({ id: 'c9' });
    expect(calls[0].ops).toContainEqual(['eq', 'cnpj', '11222333000181']);
    expect(calls[0].ops).toContainEqual(['eq', 'account_id', 'acct-1']);
    expect(calls[0].ops).toContainEqual(['neq', 'id', 'c1']);
    expect(await findCompanyByCnpj(fakeDb({ data: [] }).db, '')).toBeNull();
  });
});

describe('primary-company rules (client side)', () => {
  const link = (id: string, is_primary: boolean, created_at: string) => ({
    is_primary,
    created_at,
    company: { id, razao_social: id, nome_fantasia: null, cnpj: null, cidade: null, uf: null },
  });

  it('sorts the primary first, then by link date', () => {
    const sorted = sortContactCompanies([
      link('b', false, '2026-01-02'),
      link('c', true, '2026-01-03'),
      link('a', false, '2026-01-01'),
    ]);
    expect(sorted.map((l) => l.company.id)).toEqual(['c', 'a', 'b']);
    expect(primaryCompanyId(sorted)).toBe('c');
    expect(primaryCompanyId([link('a', false, '2026-01-01')])).toBeNull();
  });

  it('reads the contact companies, unwrapping embeds and dropping links to hidden companies', async () => {
    const { db } = fakeDb({
      data: [
        { is_primary: false, created_at: '2026-01-01', company: [{ id: 'a', razao_social: 'A' }] },
        { is_primary: true, created_at: '2026-01-02', company: { id: 'b', razao_social: 'B' } },
        { is_primary: false, created_at: '2026-01-03', company: null },
      ],
    });
    const out = await listContactCompanies(db, 'contact-1');
    expect(out.map((l) => [l.company.id, l.is_primary])).toEqual([
      ['b', true],
      ['a', false],
    ]);
  });

  it('reads the contact primary company (deal default) from the primary link only', async () => {
    const { db, calls } = fakeDb({ data: { company: [{ id: 'co-1', razao_social: 'Sol' }] } });
    expect(await getPrimaryCompany(db, 'contact-1')).toMatchObject({ id: 'co-1' });
    expect(calls[0].ops).toContainEqual(['eq', 'contact_id', 'contact-1']);
    expect(calls[0].ops).toContainEqual(['eq', 'is_primary', true]);
    expect(await getPrimaryCompany(fakeDb({ data: null }).db, 'contact-2')).toBeNull();
  });

  it('links with a single insert and leaves account and primary bookkeeping to the database', async () => {
    const { db, calls } = fakeDb({});
    await linkContactCompany(db, 'contact-1', 'co-1');
    expect(calls[0].table).toBe('contact_companies');
    expect(calls[0].ops).toEqual([['insert', { contact_id: 'contact-1', company_id: 'co-1', is_primary: false }]]);
    await linkContactCompany(db, 'contact-1', 'co-2', { primary: true });
    expect(calls[1].ops[0]).toEqual(['insert', { contact_id: 'contact-1', company_id: 'co-2', is_primary: true }]);
  });

  it('maps a second link to the same company and a cross-account link', async () => {
    await expect(
      linkContactCompany(fakeDb({ error: { code: '23505' } }).db, 'contact-1', 'co-1'),
    ).rejects.toMatchObject({ code: 'already_linked' });
    await expect(
      linkContactCompany(fakeDb({ error: { code: '23503' } }).db, 'contact-1', 'other-account-co'),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      linkContactCompany(fakeDb({ error: { code: '42501' } }).db, 'contact-1', 'co-1'),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('marks primary / unlinks by the (contact, company) pair and refuses a no-op', async () => {
    const ok = fakeDb({ data: [{ company_id: 'co-1' }] });
    await setPrimaryCompany(ok.db, 'contact-1', 'co-1');
    expect(ok.calls[0].ops).toEqual([
      ['update', { is_primary: true }],
      ['eq', 'contact_id', 'contact-1'],
      ['eq', 'company_id', 'co-1'],
      ['select', 'company_id'],
    ]);
    await unlinkContactCompany(ok.db, 'contact-1', 'co-1');
    expect(ok.calls[1].ops[0]).toEqual(['delete']);
    await expect(setPrimaryCompany(fakeDb({ data: [] }).db, 'c', 'x')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(unlinkContactCompany(fakeDb({ data: [] }).db, 'c', 'x')).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('review fixes', () => {
  it('maps a malformed id (22P02) to not_found and never queries a non-UUID company id', async () => {
    expect(companyErrorFromDb({ code: '22P02' }, 'duplicate_cnpj').code).toBe('not_found');
    const { db, calls } = fakeDb({ data: { id: 'x' } });
    expect(await getCompany(db, 'abc')).toBeNull();
    expect(await listCompanyContacts(db, 'abc')).toEqual([]);
    expect(await listCompanyDeals(db, 'abc')).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(isUuid('7b1c2e4a-0000-4000-8000-000000000001')).toBe(true);
  });

  it('gives a check violation its own message (nothing is highlighted on the form)', () => {
    expect(companyErrorMessage(companyErrorFromDb({ code: '23514' }, 'duplicate_cnpj'))).toBe(
      'The company data was rejected — check the CNPJ, CEP, UF and field sizes',
    );
  });

  it('tells a lost race on the primary index apart from a duplicate link', () => {
    const race = companyErrorFromDb(
      { code: '23505', message: 'duplicate key value violates unique constraint "idx_contact_companies_one_primary"' },
      'already_linked',
    );
    expect(race.code).toBe('primary_conflict');
    expect(companyErrorMessage(race)).toMatch(/try again/);
    expect(
      companyErrorFromDb({ code: '23505', message: 'violates unique constraint "contact_companies_pkey"' }, 'already_linked').code,
    ).toBe('already_linked');
  });

  it('retries a mark-primary that lost the race once, and reports a second loss', async () => {
    const race = { code: '23505', message: 'unique constraint "idx_contact_companies_one_primary"' };
    let n = 0;
    const flaky = {
      from: () => {
        const b: Record<string, unknown> = {};
        for (const op of ['update', 'eq', 'select', 'insert']) b[op] = () => b;
        b.then = (resolve: (v: unknown) => unknown) => {
          n += 1;
          return Promise.resolve(n === 1 ? { data: null, error: race } : { data: [{ company_id: 'co' }], error: null }).then(resolve);
        };
        return b;
      },
    } as unknown as CompaniesClient;
    await expect(setPrimaryCompany(flaky, 'c', 'co')).resolves.toBeUndefined();
    expect(n).toBe(2);

    const { db, calls } = fakeDb({ error: race });
    await expect(setPrimaryCompany(db, 'c', 'co')).rejects.toMatchObject({ code: 'primary_conflict' });
    expect(calls).toHaveLength(2);
    await expect(linkContactCompany(fakeDb({ error: race }).db, 'c', 'co', { primary: true })).rejects.toMatchObject({
      code: 'primary_conflict',
    });
  });
});

describe('deal company', () => {
  it('sets and clears the company on a deal', async () => {
    const { db, calls } = fakeDb({ data: [{ id: 'd1' }] });
    await setDealCompany(db, 'd1', 'co-1');
    await setDealCompany(db, 'd1', null);
    expect(calls[0].table).toBe('deals');
    expect(calls[0].ops[0]).toMatchObject(['update', { company_id: 'co-1' }]);
    expect(calls[1].ops[0]).toMatchObject(['update', { company_id: null }]);
  });

  it('maps a company from another account (trigger 23503) to not_found', async () => {
    await expect(setDealCompany(fakeDb({ error: { code: '23503' } }).db, 'd1', 'x')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('listPrimaryCompanies (inbox list rows)', () => {
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  it('maps contact id → primary company in one query', async () => {
    const { db, calls } = fakeDb({
      data: [
        { contact_id: uuid(1), company: { id: 'co-1', razao_social: 'ACME LTDA', nome_fantasia: 'Acme' } },
        { contact_id: uuid(2), company: [{ id: 'co-2', razao_social: 'Beta SA', nome_fantasia: null }] },
        { contact_id: uuid(3), company: null },
      ],
    });
    const map = await listPrimaryCompanies(db, [uuid(1), uuid(2), uuid(3), uuid(1)]);
    expect(map.get(uuid(1))).toMatchObject({ id: 'co-1' });
    expect(map.get(uuid(2))).toMatchObject({ id: 'co-2' });
    expect(map.has(uuid(3))).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe('contact_companies');
    expect(calls[0].ops).toContainEqual(['eq', 'is_primary', true]);
    // Duplicates collapsed before the `in` list is sent.
    expect(calls[0].ops).toContainEqual(['in', 'contact_id', [uuid(1), uuid(2), uuid(3)]]);
  });

  it('skips the round-trip without valid ids and chunks long lists', async () => {
    const empty = fakeDb({ data: [] });
    expect((await listPrimaryCompanies(empty.db, ['not-a-uuid'])).size).toBe(0);
    expect(empty.calls).toHaveLength(0);

    const many = fakeDb({ data: [] });
    await listPrimaryCompanies(many.db, Array.from({ length: 450 }, (_, i) => uuid(i + 1)));
    expect(many.calls).toHaveLength(3);
  });

  it('throws a CompanyError on a database error', async () => {
    await expect(listPrimaryCompanies(fakeDb({ error: { code: '42501' } }).db, [uuid(1)])).rejects.toBeInstanceOf(
      CompanyError,
    );
  });
});
