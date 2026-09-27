// ============================================================
// Companies — form model: empty values, row ↔ form, CNPJ lookup
// merge and validation. Pure (no I/O, no browser globals).
//
// Phone / e-mail / address go through `validateAccountContact`
// (the same rules as Settings → Empresa and signup) so the CRM
// company and the tenant's own registration never disagree.
// ============================================================

import { formatTaxId, isValidCnpj, normalizeTaxId } from '@/lib/br/documents';
import {
  EMPTY_ADDRESS,
  validateAccountContact,
  type ContactErrors,
  type CompanyLookup,
} from '@/lib/br/lookup';

import type { Company, CompanyFormValues, CompanyRow, CompanySummary } from './types';

export const MAX_COMPANY_NAME_LEN = 200;
export const MAX_ACTIVITY_LEN = 300;
export const MAX_NOTES_LEN = 5000;

export type CompanyField =
  | 'cnpj'
  | 'razao_social'
  | 'nome_fantasia'
  | 'atividade'
  | 'notes'
  | keyof ContactErrors;
export type CompanyFieldErrorCode = 'required' | 'invalid' | 'too_long';
export type CompanyFieldErrors = Partial<Record<CompanyField, CompanyFieldErrorCode>>;

export type CompanyValidation =
  | { ok: true; value: CompanyRow }
  | { ok: false; errors: CompanyFieldErrors };

export function emptyCompanyForm(): CompanyFormValues {
  return {
    cnpj: '',
    razao_social: '',
    nome_fantasia: '',
    email: '',
    phone: '',
    address: { ...EMPTY_ADDRESS },
    cnae: '',
    atividade: '',
    notes: '',
  };
}

export function companyToForm(company: Company): CompanyFormValues {
  return {
    cnpj: company.cnpj ? formatTaxId('pj', company.cnpj) : '',
    razao_social: company.razao_social,
    nome_fantasia: company.nome_fantasia ?? '',
    email: company.email ?? '',
    phone: company.phone ?? '',
    address: {
      cep: company.cep ?? '',
      street: company.logradouro ?? '',
      number: company.numero ?? '',
      complement: company.complemento ?? '',
      neighborhood: company.bairro ?? '',
      city: company.cidade ?? '',
      state: company.uf ?? '',
    },
    cnae: company.cnae ?? '',
    atividade: company.atividade ?? '',
    notes: company.notes ?? '',
  };
}

/**
 * Fill the form from a CNPJ lookup. What the Receita knows replaces
 * the form's value; a field the Receita leaves blank keeps what the
 * user typed (e.g. an e-mail BrasilAPI does not have). Notes are
 * never touched.
 */
export function applyCnpjLookup(values: CompanyFormValues, found: CompanyLookup): CompanyFormValues {
  const pick = (next: string, current: string) => (next.trim() ? next : current);
  const hasAddress = [found.address.cep, found.address.street, found.address.city].some((v) => v.trim());
  return {
    ...values,
    cnpj: formatTaxId('pj', found.taxId || values.cnpj),
    razao_social: pick(found.legalName, values.razao_social),
    nome_fantasia: pick(found.tradeName, values.nome_fantasia),
    email: pick(found.email, values.email),
    phone: pick(found.phone, values.phone),
    address: hasAddress ? { ...found.address } : values.address,
    cnae: pick(found.cnae, values.cnae),
    atividade: pick(found.activity, values.atividade),
  };
}

function nullable(value: string): string | null {
  const v = value.trim();
  return v ? v : null;
}

export function validateCompanyForm(values: CompanyFormValues): CompanyValidation {
  const errors: CompanyFieldErrors = {};

  const cnpjRaw = normalizeTaxId(values.cnpj ?? '');
  if (cnpjRaw.length > 0 && !isValidCnpj(cnpjRaw)) errors.cnpj = 'invalid';

  const razao = (values.razao_social ?? '').trim();
  if (!razao) errors.razao_social = 'required';
  else if (razao.length > MAX_COMPANY_NAME_LEN) errors.razao_social = 'too_long';

  const fantasia = (values.nome_fantasia ?? '').trim();
  if (fantasia.length > MAX_COMPANY_NAME_LEN) errors.nome_fantasia = 'too_long';

  const atividade = (values.atividade ?? '').trim();
  if (atividade.length > MAX_ACTIVITY_LEN) errors.atividade = 'too_long';

  const notes = (values.notes ?? '').trim();
  if (notes.length > MAX_NOTES_LEN) errors.notes = 'too_long';

  const contact = validateAccountContact({
    phone: values.phone,
    email: values.email,
    address: values.address,
  });
  if (!contact.ok) Object.assign(errors, contact.errors);

  if (Object.keys(errors).length > 0 || !contact.ok) return { ok: false, errors };

  const address = contact.value.address;
  const cnae = (values.cnae ?? '').replace(/\D/g, '').slice(0, 20);
  return {
    ok: true,
    value: {
      cnpj: cnpjRaw || null,
      razao_social: razao,
      nome_fantasia: fantasia || null,
      email: contact.value.email,
      phone: contact.value.phone,
      cep: nullable(address?.cep ?? ''),
      logradouro: nullable(address?.street ?? ''),
      numero: nullable(address?.number ?? ''),
      complemento: nullable(address?.complement ?? ''),
      bairro: nullable(address?.neighborhood ?? ''),
      cidade: nullable(address?.city ?? ''),
      uf: nullable(address?.state ?? ''),
      cnae: cnae || null,
      atividade: atividade || null,
      notes: notes || null,
    },
  };
}

/** English message key (rendered through `t()`) for a field error. */
export function companyFieldErrorMessage(field: CompanyField, code: CompanyFieldErrorCode): string {
  if (code === 'required') return 'Required';
  if (code === 'too_long') return 'Too long';
  switch (field) {
    case 'cnpj':
      return 'Invalid CNPJ';
    case 'phone':
      return 'Invalid phone number';
    case 'email':
      return 'Invalid e-mail';
    case 'cep':
      return 'Invalid CEP';
    case 'state':
      return 'Choose a state';
    default:
      return 'Invalid value';
  }
}

/** The name the app shows: trade name when there is one. */
export function companyDisplayName(company: Pick<CompanySummary, 'razao_social' | 'nome_fantasia'>): string {
  return company.nome_fantasia?.trim() || company.razao_social;
}

/** "Porto Alegre/RS", "Porto Alegre", "RS" or ''. */
export function companyPlace(company: Pick<CompanySummary, 'cidade' | 'uf'>): string {
  return [company.cidade, company.uf].filter(Boolean).join('/');
}
