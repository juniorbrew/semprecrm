// ============================================================
// Companies (migration 054) — row shapes.
//
// "Empresa" in the UI is the CRM's customer company (pessoa
// jurídica), not the tenant (`accounts`, Settings → Empresa).
// ============================================================

import type { AccountAddress } from '@/lib/br/lookup';

export interface Company {
  id: string;
  account_id: string;
  /** Normalised (no mask), or null when the company has none on file. */
  cnpj: string | null;
  razao_social: string;
  nome_fantasia: string | null;
  email: string | null;
  /** Digits only (DDD + number). */
  phone: string | null;
  /** 8 digits. */
  cep: string | null;
  logradouro: string | null;
  numero: string | null;
  complemento: string | null;
  bairro: string | null;
  cidade: string | null;
  uf: string | null;
  cnae: string | null;
  atividade: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CompanyListItem extends Company {
  contacts_count: number;
}

/** The bits pickers, chips and embeds show. */
export type CompanySummary = Pick<
  Company,
  'id' | 'razao_social' | 'nome_fantasia' | 'cnpj' | 'cidade' | 'uf'
>;

/** One of a contact's companies (contact detail → Empresas). */
export interface ContactCompanyLink {
  company: CompanySummary;
  is_primary: boolean;
  created_at: string;
}

/** One of a company's contacts (company drawer). */
export interface CompanyContactLink {
  contact: {
    id: string;
    name: string | null;
    phone: string;
    email: string | null;
    avatar_url: string | null;
  };
  is_primary: boolean;
  created_at: string;
}

/** One of a company's deals (company drawer). */
export interface CompanyDeal {
  id: string;
  title: string;
  value: number;
  currency: string | null;
  status: 'open' | 'won' | 'lost' | null;
  pipeline_id: string;
  updated_at: string | null;
  stage: { name: string; color: string } | null;
}

/** What the create / edit form holds — every field a string. */
export interface CompanyFormValues {
  cnpj: string;
  razao_social: string;
  nome_fantasia: string;
  email: string;
  phone: string;
  address: AccountAddress;
  cnae: string;
  atividade: string;
  notes: string;
}

/** The writable columns, validated and normalised. */
export type CompanyRow = Omit<
  Company,
  'id' | 'account_id' | 'created_by' | 'created_at' | 'updated_at'
>;
