import { isPlan, isPlanStatus, type Plan } from '@/lib/plans';
import type { PlatformAccountRow } from '@/types';
import {
  getAccountHealth,
  matchesAccountFilter,
  type AccountStatusFilter,
  type AttentionFilter,
} from './overview';

export type ExpiryFilter = 'all' | 'expired' | '7days' | '30days' | 'none';
export interface CompanyFilters {
  query: string;
  plan: 'all' | Plan;
  status: AccountStatusFilter;
  attention: AttentionFilter;
  expiry: ExpiryFilter;
}
export const DEFAULT_COMPANY_FILTERS: CompanyFilters = {
  query: '',
  plan: 'all',
  status: 'all',
  attention: 'all',
  expiry: 'all',
};
export function parseCompanyFilters(
  params: Record<string, string | string[] | undefined>
): CompanyFilters {
  const expirations: ExpiryFilter[] = [
    'all',
    'expired',
    '7days',
    '30days',
    'none',
  ];
  const expiry =
    typeof params.expiry === 'string' &&
    expirations.includes(params.expiry as ExpiryFilter)
      ? (params.expiry as ExpiryFilter)
      : params.attention === 'expired'
        ? 'expired'
        : params.attention === 'expiring'
          ? '7days'
          : 'all';
  return {
    query: typeof params.q === 'string' ? params.q.slice(0, 500) : '',
    plan: isPlan(params.plan) ? params.plan : 'all',
    status: isPlanStatus(params.status) ? params.status : 'all',
    attention: params.attention === 'limits' ? 'limits' : 'all',
    expiry,
  };
}
function searchable(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}
export function matchesCompanyFilters(
  row: PlatformAccountRow,
  filters: CompanyFilters,
  now: Date
): boolean {
  if (!matchesAccountFilter(row, filters.status, filters.attention, now))
    return false;
  const health = getAccountHealth(row, now);
  if (filters.plan !== 'all' && health.ent.plan !== filters.plan) return false;
  if (filters.expiry === 'expired' && !health.expired) return false;
  if (filters.expiry === '7days' && !health.expiring) return false;
  if (filters.expiry === 'none' && row.plan_expires_at !== null) return false;
  if (filters.expiry === '30days') {
    const expiry = health.ent.expiresAt
      ? Date.parse(health.ent.expiresAt)
      : NaN;
    if (
      (health.ent.status !== 'active' && health.ent.status !== 'trial') ||
      !(expiry > now.getTime() && expiry <= now.getTime() + 30 * 86_400_000)
    )
      return false;
  }
  const query = searchable(filters.query);
  return (
    !query ||
    [row.name, row.owner_name ?? '', row.owner_email ?? ''].some((value) =>
      searchable(value).includes(query)
    )
  );
}
