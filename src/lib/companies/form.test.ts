import { describe, expect, it } from 'vitest';

import type { CompanyLookup } from '@/lib/br/lookup';

import {
  applyCnpjLookup,
  companyDisplayName,
  companyFieldErrorMessage,
  companyPlace,
  companyToForm,
  emptyCompanyForm,
  validateCompanyForm,
} from './form';
import type { Company } from './types';

const filled = () => ({
  ...emptyCompanyForm(),
  cnpj: '11.222.333/0001-81',
  razao_social: '  Padaria Sol LTDA ',
  nome_fantasia: 'Padaria do Sol',
  email: 'Contato@Padaria.com.br',
  phone: '(51) 3635-4333',
  address: {
    cep: '90000-000',
    street: 'Rua Garibaldi',
    number: '70',
    complement: '',
    neighborhood: 'Centro',
    city: 'Porto Alegre',
    state: 'rs',
  },
  cnae: '10.91-1-02',
  atividade: 'Fabricação de produtos de padaria',
  notes: '',
});

describe('validateCompanyForm', () => {
  it('normalises a complete form into the table columns', () => {
    const out = validateCompanyForm(filled());
    expect(out).toEqual({
      ok: true,
      value: {
        cnpj: '11222333000181',
        razao_social: 'Padaria Sol LTDA',
        nome_fantasia: 'Padaria do Sol',
        email: 'contato@padaria.com.br',
        phone: '5136354333',
        cep: '90000000',
        logradouro: 'Rua Garibaldi',
        numero: '70',
        complemento: null,
        bairro: 'Centro',
        cidade: 'Porto Alegre',
        uf: 'RS',
        cnae: '1091102',
        atividade: 'Fabricação de produtos de padaria',
        notes: null,
      },
    });
  });

  it('only requires the razão social; CNPJ and everything else are optional', () => {
    const out = validateCompanyForm({ ...emptyCompanyForm(), razao_social: 'Mercado Lua' });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.cnpj).toBeNull();
      expect(out.value.cep).toBeNull();
      expect(out.value.phone).toBeNull();
    }
    expect(validateCompanyForm(emptyCompanyForm())).toEqual({ ok: false, errors: { razao_social: 'required' } });
  });

  it('rejects a CNPJ with a wrong check digit, and accepts the alphanumeric format', () => {
    expect(validateCompanyForm({ ...filled(), cnpj: '11.222.333/0001-82' })).toEqual({
      ok: false,
      errors: { cnpj: 'invalid' },
    });
    expect(validateCompanyForm({ ...filled(), cnpj: '00.000.000/0000-00' })).toMatchObject({ ok: false });
    // Receita's published example of the July-2026 alphanumeric CNPJ.
    const alpha = validateCompanyForm({ ...filled(), cnpj: '12.ABC.345/01DE-35' });
    expect(alpha).toMatchObject({ ok: true, value: { cnpj: '12ABC34501DE35' } });
  });

  it('reports phone, e-mail, CEP, UF and length problems per field', () => {
    const out = validateCompanyForm({
      ...filled(),
      phone: '123',
      email: 'nope',
      razao_social: 'x'.repeat(201),
      address: { ...filled().address, cep: '123', state: 'XX' },
    });
    expect(out).toEqual({
      ok: false,
      errors: { phone: 'invalid', email: 'invalid', cep: 'invalid', state: 'invalid', razao_social: 'too_long' },
    });
  });
});

describe('applyCnpjLookup', () => {
  const found: CompanyLookup = {
    taxId: '11222333000181',
    legalName: 'Padaria Sol LTDA',
    tradeName: '',
    address: { cep: '90000000', street: 'Rua Garibaldi', number: '70', complement: '', neighborhood: 'Centro', city: 'Porto Alegre', state: 'RS' },
    phone: '5136354333',
    email: '',
    status: 'ATIVA',
    cnae: '1091102',
    activity: 'Fabricação de produtos de padaria',
  };

  it('fills what the Receita knows and keeps what it leaves blank', () => {
    const before = { ...emptyCompanyForm(), cnpj: '11222333000181', email: 'eu@padaria.com.br', nome_fantasia: 'Sol', notes: 'VIP' };
    const out = applyCnpjLookup(before, found);
    expect(out.cnpj).toBe('11.222.333/0001-81');
    expect(out.razao_social).toBe('Padaria Sol LTDA');
    expect(out.nome_fantasia).toBe('Sol');
    expect(out.email).toBe('eu@padaria.com.br');
    expect(out.phone).toBe('5136354333');
    expect(out.address.city).toBe('Porto Alegre');
    expect(out.atividade).toBe('Fabricação de produtos de padaria');
    expect(out.notes).toBe('VIP');
  });

  it('keeps a hand-typed address when the Receita has none', () => {
    const typed = { ...emptyCompanyForm(), address: { ...filled().address } };
    const empty = { cep: '', street: '', number: '', complement: '', neighborhood: '', city: '', state: '' };
    expect(applyCnpjLookup(typed, { ...found, address: empty }).address).toEqual(typed.address);
  });
});

describe('companyToForm', () => {
  it('round-trips a stored row through the form', () => {
    const row = validateCompanyForm(filled());
    if (!row.ok) throw new Error('fixture invalid');
    const company: Company = {
      ...row.value,
      id: 'c1',
      account_id: 'a1',
      created_by: null,
      created_at: '2026-09-27T00:00:00Z',
      updated_at: '2026-09-27T00:00:00Z',
    };
    const form = companyToForm(company);
    expect(form.cnpj).toBe('11.222.333/0001-81');
    expect(validateCompanyForm(form)).toEqual(row);
  });
});

describe('display helpers', () => {
  it('prefers the trade name and joins city/UF', () => {
    expect(companyDisplayName({ razao_social: 'Padaria Sol LTDA', nome_fantasia: 'Padaria do Sol' })).toBe('Padaria do Sol');
    expect(companyDisplayName({ razao_social: 'Padaria Sol LTDA', nome_fantasia: ' ' })).toBe('Padaria Sol LTDA');
    expect(companyPlace({ cidade: 'Porto Alegre', uf: 'RS' })).toBe('Porto Alegre/RS');
    expect(companyPlace({ cidade: null, uf: 'RS' })).toBe('RS');
    expect(companyPlace({ cidade: null, uf: null })).toBe('');
  });

  it('maps field errors to message keys', () => {
    expect(companyFieldErrorMessage('cnpj', 'invalid')).toBe('Invalid CNPJ');
    expect(companyFieldErrorMessage('razao_social', 'required')).toBe('Required');
    expect(companyFieldErrorMessage('notes', 'too_long')).toBe('Too long');
  });
});
