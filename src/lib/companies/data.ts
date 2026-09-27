// ============================================================
// Companies — reads and writes through the caller's Supabase client.
//
// Same contract as src/lib/tasks: pass the client in (the browser
// client is RLS-scoped — viewer+ reads, agent+ writes, migration
// 054), get rows back, errors are thrown. Writes throw
// `CompanyError` with a machine code so the UI can say *why*
// (duplicate CNPJ, already linked, no permission) without parsing
// PostgREST messages.
//
// Primary-company bookkeeping lives in the database triggers: the
// first link of a contact becomes primary, marking one clears the
// others, removing the primary promotes the oldest remaining link.
// So link / set-primary / unlink are single statements here.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { normalizeTaxId } from '@/lib/br/documents';

import type {
  Company,
  CompanyContactLink,
  CompanyDeal,
  CompanyListItem,
  CompanyRow,
  CompanySummary,
  ContactCompanyLink,
} from './types';

export type CompaniesClient = Pick<SupabaseClient, 'from'>;

export const COMPANY_COLUMNS =
  'id, account_id, cnpj, razao_social, nome_fantasia, email, phone, cep, logradouro, numero, complemento, bairro, cidade, uf, cnae, atividade, notes, created_by, created_at, updated_at';

export const COMPANY_SUMMARY_COLUMNS = 'id, razao_social, nome_fantasia, cnpj, cidade, uf';

// ------------------------------------------------------------
// Errors
// ------------------------------------------------------------

export type CompanyErrorCode =
  | 'duplicate_cnpj'
  | 'already_linked'
  | 'not_found'
  | 'forbidden'
  | 'invalid'
  | 'failed';

export class CompanyError extends Error {
  readonly code: CompanyErrorCode;
  constructor(code: CompanyErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'CompanyError';
    this.code = code;
  }
}

interface PgError {
  code?: string;
  message?: string;
  details?: string | null;
}

/**
 * PostgREST / Postgres error → our code.
 *   23505 unique_violation     — CNPJ taken in the account, or link exists
 *   23503 foreign_key_violation — the cross-account triggers (054) or a
 *                                 row that no longer exists
 *   42501 insufficient_privilege — RLS said no (viewer, other account)
 *   23514 check_violation / 22xxx — shape rejected by the table
 */
export function companyErrorFromDb(error: PgError, onUnique: 'duplicate_cnpj' | 'already_linked'): CompanyError {
  const code = error.code ?? '';
  if (code === '23505') return new CompanyError(onUnique, error.message);
  if (code === '23503') return new CompanyError('not_found', error.message);
  if (code === '42501') return new CompanyError('forbidden', error.message);
  if (code === '23514' || code.startsWith('22')) return new CompanyError('invalid', error.message);
  return new CompanyError('failed', error.message);
}

/** English message key for `t()`. */
export function companyErrorMessage(err: unknown): string {
  const code = err instanceof CompanyError ? err.code : 'failed';
  switch (code) {
    case 'duplicate_cnpj':
      return 'A company with this CNPJ already exists';
    case 'already_linked':
      return 'This contact is already linked to this company';
    case 'not_found':
      return 'Company not found';
    case 'forbidden':
      return 'You do not have permission to change companies';
    case 'invalid':
      return 'Check the highlighted fields';
    default:
      return 'Something went wrong. Please try again.';
  }
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

/** One-element embeds come back as arrays from some PostgREST paths. */
function one<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * A search term safe inside PostgREST's `or=(…)` filter: drop the
 * characters that are syntax there (`,` `(` `)`), the LIKE wildcards
 * and backslashes. Collapses whitespace.
 */
export function sanitizeCompanySearch(term: string): string {
  return term.replace(/[%_,()\\*:"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** The `or` filter for a search box: name, trade name, CNPJ. */
export function companySearchFilter(term: string): string | null {
  const clean = sanitizeCompanySearch(term);
  if (!clean) return null;
  const filters = [`razao_social.ilike.%${clean}%`, `nome_fantasia.ilike.%${clean}%`];
  const doc = normalizeTaxId(clean);
  // "11.222", "11222333" or an alphanumeric CNPJ prefix.
  if (doc.length >= 3 && /\d/.test(doc)) filters.push(`cnpj.ilike.%${doc}%`);
  return filters.join(',');
}

// ------------------------------------------------------------
// Companies
// ------------------------------------------------------------

export interface ListCompaniesOptions {
  search?: string;
  /** 0-based. */
  page?: number;
  pageSize?: number;
}

export async function listCompanies(
  db: CompaniesClient,
  { search = '', page = 0, pageSize = 25 }: ListCompaniesOptions = {},
): Promise<{ rows: CompanyListItem[]; total: number }> {
  const from = page * pageSize;
  let q = db
    .from('companies')
    .select(`${COMPANY_COLUMNS}, contact_companies(count)`, { count: 'exact' })
    .order('razao_social', { ascending: true })
    .range(from, from + pageSize - 1);
  const filter = companySearchFilter(search);
  if (filter) q = q.or(filter);
  const { data, error, count } = await q;
  if (error) throw companyErrorFromDb(error, 'duplicate_cnpj');
  type Row = Company & { contact_companies?: { count: number }[] | { count: number } | null };
  const rows = ((data ?? []) as unknown as Row[]).map(({ contact_companies, ...c }) => ({
    ...c,
    contacts_count: one(contact_companies)?.count ?? 0,
  }));
  return { rows, total: count ?? rows.length };
}

/** For pickers: a short list matching `search` (or the first ones). */
export async function searchCompanies(
  db: CompaniesClient,
  search: string,
  limit = 20,
): Promise<CompanySummary[]> {
  let q = db
    .from('companies')
    .select(COMPANY_SUMMARY_COLUMNS)
    .order('razao_social', { ascending: true })
    .limit(limit);
  const filter = companySearchFilter(search);
  if (filter) q = q.or(filter);
  const { data, error } = await q;
  if (error) throw companyErrorFromDb(error, 'duplicate_cnpj');
  return (data ?? []) as CompanySummary[];
}

export async function getCompany(db: CompaniesClient, id: string): Promise<Company | null> {
  const { data, error } = await db.from('companies').select(COMPANY_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw companyErrorFromDb(error, 'duplicate_cnpj');
  return (data as Company | null) ?? null;
}

/**
 * The account's company with this CNPJ, if any. `accountId` repeats
 * the RLS scope (defence in depth, and required for a service-role
 * client); `excludeId` skips the company being edited.
 */
export async function findCompanyByCnpj(
  db: CompaniesClient,
  cnpj: string,
  { accountId, excludeId }: { accountId?: string | null; excludeId?: string | null } = {},
): Promise<CompanySummary | null> {
  const doc = normalizeTaxId(cnpj);
  if (!doc) return null;
  let q = db.from('companies').select(COMPANY_SUMMARY_COLUMNS).eq('cnpj', doc);
  if (accountId) q = q.eq('account_id', accountId);
  if (excludeId) q = q.neq('id', excludeId);
  const { data, error } = await q.limit(1);
  if (error) throw companyErrorFromDb(error, 'duplicate_cnpj');
  return ((data ?? []) as CompanySummary[])[0] ?? null;
}

export async function createCompany(
  db: CompaniesClient,
  ctx: { accountId: string; userId: string | null },
  row: CompanyRow,
): Promise<Company> {
  const { data, error } = await db
    .from('companies')
    .insert({ ...row, account_id: ctx.accountId, created_by: ctx.userId })
    .select(COMPANY_COLUMNS)
    .single();
  if (error || !data) throw companyErrorFromDb(error ?? {}, 'duplicate_cnpj');
  return data as Company;
}

export async function updateCompany(db: CompaniesClient, id: string, row: CompanyRow): Promise<Company> {
  const { data, error } = await db
    .from('companies')
    .update(row)
    .eq('id', id)
    .select(COMPANY_COLUMNS)
    .maybeSingle();
  if (error) throw companyErrorFromDb(error, 'duplicate_cnpj');
  // RLS hides the row from a viewer's UPDATE: zero rows, no error.
  if (!data) throw new CompanyError('forbidden');
  return data as Company;
}

/** Links go with it (cascade); deals keep existing with no company. */
export async function deleteCompany(db: CompaniesClient, id: string): Promise<void> {
  const { data, error } = await db.from('companies').delete().eq('id', id).select('id');
  if (error) throw companyErrorFromDb(error, 'duplicate_cnpj');
  if (!data || (data as unknown[]).length === 0) throw new CompanyError('forbidden');
}

// ------------------------------------------------------------
// Contact ↔ company
// ------------------------------------------------------------

/** Primary first, then the order they were linked. */
export function sortContactCompanies<T extends { is_primary: boolean; created_at: string }>(links: readonly T[]): T[] {
  return [...links].sort((a, b) => {
    if (a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1;
    return a.created_at.localeCompare(b.created_at);
  });
}

/** The contact's primary company id, from an already-loaded list. */
export function primaryCompanyId(links: readonly Pick<ContactCompanyLink, 'is_primary' | 'company'>[]): string | null {
  return links.find((l) => l.is_primary)?.company.id ?? null;
}

export async function listContactCompanies(
  db: CompaniesClient,
  contactId: string,
): Promise<ContactCompanyLink[]> {
  const { data, error } = await db
    .from('contact_companies')
    .select(`is_primary, created_at, company:companies(${COMPANY_SUMMARY_COLUMNS})`)
    .eq('contact_id', contactId);
  if (error) throw companyErrorFromDb(error, 'already_linked');
  type Row = { is_primary: boolean; created_at: string; company: CompanySummary | CompanySummary[] | null };
  const links = ((data ?? []) as unknown as Row[])
    .map((r) => ({ is_primary: r.is_primary, created_at: r.created_at, company: one(r.company) }))
    .filter((r): r is ContactCompanyLink => r.company !== null);
  return sortContactCompanies(links);
}

/** The contact's primary company (the deal form's default), or null. */
export async function getPrimaryCompany(db: CompaniesClient, contactId: string): Promise<CompanySummary | null> {
  const { data, error } = await db
    .from('contact_companies')
    .select(`company:companies(${COMPANY_SUMMARY_COLUMNS})`)
    .eq('contact_id', contactId)
    .eq('is_primary', true)
    .maybeSingle();
  if (error) throw companyErrorFromDb(error, 'already_linked');
  return one((data as { company: CompanySummary | CompanySummary[] | null } | null)?.company);
}

/**
 * Link a contact to a company. The first company of a contact is
 * primary whatever `primary` says (trigger); `primary: true` moves the
 * flag here. `account_id` is filled by the trigger from the contact.
 */
export async function linkContactCompany(
  db: CompaniesClient,
  contactId: string,
  companyId: string,
  { primary = false }: { primary?: boolean } = {},
): Promise<void> {
  const { error } = await db
    .from('contact_companies')
    .insert({ contact_id: contactId, company_id: companyId, is_primary: primary });
  if (error) throw companyErrorFromDb(error, 'already_linked');
}

export async function setPrimaryCompany(db: CompaniesClient, contactId: string, companyId: string): Promise<void> {
  const { data, error } = await db
    .from('contact_companies')
    .update({ is_primary: true })
    .eq('contact_id', contactId)
    .eq('company_id', companyId)
    .select('company_id');
  if (error) throw companyErrorFromDb(error, 'already_linked');
  if (!data || (data as unknown[]).length === 0) throw new CompanyError('forbidden');
}

export async function unlinkContactCompany(db: CompaniesClient, contactId: string, companyId: string): Promise<void> {
  const { data, error } = await db
    .from('contact_companies')
    .delete()
    .eq('contact_id', contactId)
    .eq('company_id', companyId)
    .select('company_id');
  if (error) throw companyErrorFromDb(error, 'already_linked');
  if (!data || (data as unknown[]).length === 0) throw new CompanyError('forbidden');
}

/** For the company drawer's "Link contact" picker. */
export async function searchContactsForCompany(
  db: CompaniesClient,
  search: string,
  limit = 20,
): Promise<CompanyContactLink['contact'][]> {
  let q = db
    .from('contacts')
    .select('id, name, phone, email, avatar_url')
    .is('anonymized_at', null)
    .order('name', { ascending: true })
    .limit(limit);
  const clean = sanitizeCompanySearch(search);
  if (clean) q = q.or(`name.ilike.%${clean}%,phone.ilike.%${clean}%,email.ilike.%${clean}%`);
  const { data, error } = await q;
  if (error) throw companyErrorFromDb(error, 'already_linked');
  return (data ?? []) as CompanyContactLink['contact'][];
}

export async function listCompanyContacts(
  db: CompaniesClient,
  companyId: string,
): Promise<CompanyContactLink[]> {
  const { data, error } = await db
    .from('contact_companies')
    .select('is_primary, created_at, contact:contacts(id, name, phone, email, avatar_url)')
    .eq('company_id', companyId)
    .order('created_at', { ascending: true });
  if (error) throw companyErrorFromDb(error, 'already_linked');
  type Row = {
    is_primary: boolean;
    created_at: string;
    contact: CompanyContactLink['contact'] | CompanyContactLink['contact'][] | null;
  };
  return ((data ?? []) as unknown as Row[])
    .map((r) => ({ is_primary: r.is_primary, created_at: r.created_at, contact: one(r.contact) }))
    .filter((r): r is CompanyContactLink => r.contact !== null);
}

// ------------------------------------------------------------
// Deals
// ------------------------------------------------------------

export async function listCompanyDeals(db: CompaniesClient, companyId: string, limit = 100): Promise<CompanyDeal[]> {
  const { data, error } = await db
    .from('deals')
    .select('id, title, value, currency, status, pipeline_id, updated_at, stage:pipeline_stages(name, color)')
    .eq('company_id', companyId)
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throw companyErrorFromDb(error, 'already_linked');
  type Row = Omit<CompanyDeal, 'stage'> & { stage: CompanyDeal['stage'] | NonNullable<CompanyDeal['stage']>[] };
  return ((data ?? []) as unknown as Row[]).map((d) => ({ ...d, value: Number(d.value ?? 0), stage: one(d.stage) }));
}

/** Point a deal at a company (or clear it with `null`). */
export async function setDealCompany(db: CompaniesClient, dealId: string, companyId: string | null): Promise<void> {
  const { data, error } = await db
    .from('deals')
    .update({ company_id: companyId, updated_at: new Date().toISOString() })
    .eq('id', dealId)
    .select('id');
  if (error) throw companyErrorFromDb(error, 'already_linked');
  if (!data || (data as unknown[]).length === 0) throw new CompanyError('forbidden');
}
