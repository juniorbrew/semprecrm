'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';

import { useLanguage } from '@/hooks/use-language';
import {
  PLAN_LABELS,
  PLANS,
  PLAN_STATUSES,
  resolveEntitlements,
} from '@/lib/plans';
import type { PlatformAccountRow } from '@/types';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { PlanStatusChip, planStatusLabelKey } from './plan-status-chip';
import {
  DEFAULT_COMPANY_FILTERS,
  matchesCompanyFilters,
  type CompanyFilters,
} from '@/lib/platform/account-filters';

function fmtDate(iso: string | null, locale: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'America/Bahia',
  });
}

function fmtLimit(value: number | null): string {
  return value === null ? '∞' : String(value);
}

export function PlatformAccountsTable({
  rows,
  initialFilters = DEFAULT_COMPANY_FILTERS,
  snapshotAt,
}: {
  rows: PlatformAccountRow[];
  initialFilters?: CompanyFilters;
  snapshotAt: string;
}) {
  const { t, language } = useLanguage();
  const [filters, setFilters] = useState<CompanyFilters>(initialFilters);
  const updateFilter = <K extends keyof CompanyFilters>(
    key: K,
    value: CompanyFilters[K]
  ) => setFilters((previous) => ({ ...previous, [key]: value }));
  const hasFilters =
    filters.query !== '' ||
    filters.plan !== 'all' ||
    filters.status !== 'all' ||
    filters.attention !== 'all' ||
    filters.expiry !== 'all';

  const filtered = useMemo(() => {
    const now = new Date(snapshotAt);
    return rows.filter((row) => matchesCompanyFilters(row, filters, now));
  }, [rows, filters, snapshotAt]);

  return (
    <section data-no-translate>
      <div className="flex flex-col gap-4">
        <div>
          <h1 className="text-foreground text-2xl font-bold tracking-tight">
            {t('Registered companies')}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm" aria-live="polite">
            {rows.length} {rows.length === 1 ? t('account') : t('accounts')}
            {filtered.length !== rows.length ? (
              <span data-no-translate>
                {' '}
                · {filtered.length} {t('shown')}
              </span>
            ) : null}
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="relative">
            <Search
              className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
              aria-hidden="true"
            />
            <Input
              value={filters.query}
              onChange={(e) => updateFilter('query', e.target.value)}
              placeholder={t('Search by name or e-mail')}
              className="h-9 w-full pl-8 sm:w-64"
              aria-label={t('Search accounts')}
            />
          </div>
          <select
            id="company-plan-filter"
            value={filters.plan}
            onChange={(e) =>
              updateFilter('plan', e.target.value as CompanyFilters['plan'])
            }
            aria-label={t('Filter by plan')}
            className="border-border bg-muted text-foreground focus:border-primary focus:ring-primary h-9 rounded-lg border px-2.5 text-sm outline-none focus:ring-1"
          >
            <option value="all">{t('All plans')}</option>
            {PLANS.map((plan) => (
              <option key={plan} value={plan}>
                {t(PLAN_LABELS[plan])}
              </option>
            ))}
          </select>
          <select
            value={filters.status}
            onChange={(e) =>
              updateFilter('status', e.target.value as CompanyFilters['status'])
            }
            aria-label={t('Filter by status')}
            className="border-border bg-muted text-foreground focus:border-primary focus:ring-primary h-9 rounded-lg border px-2.5 text-sm outline-none focus:ring-1"
          >
            <option value="all">{t('All statuses')}</option>
            {PLAN_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(planStatusLabelKey(s))}
              </option>
            ))}
          </select>
          <select
            id="company-expiry-filter"
            value={filters.expiry}
            onChange={(e) =>
              updateFilter('expiry', e.target.value as CompanyFilters['expiry'])
            }
            aria-label={t('Filter by expiration')}
            className="border-border bg-muted text-foreground focus:border-primary focus:ring-primary h-9 rounded-lg border px-2.5 text-sm outline-none focus:ring-1"
          >
            <option value="all">{t('Any expiration')}</option>
            <option value="expired">{t('Expired plan')}</option>
            <option value="7days">{t('Expiring within 7 days')}</option>
            <option value="30days">{t('Expiring within 30 days')}</option>
            <option value="none">{t('No expiration date')}</option>
          </select>
          <select
            value={filters.attention}
            onChange={(e) =>
              updateFilter(
                'attention',
                e.target.value as CompanyFilters['attention']
              )
            }
            aria-label={t('Filter by attention')}
            className="border-border bg-muted text-foreground focus:border-primary focus:ring-primary h-9 rounded-lg border px-2.5 text-sm outline-none focus:ring-1"
          >
            <option value="all">{t('No attention filter')}</option>
            <option value="limits">{t('At capacity')}</option>
          </select>
          <Button
            type="button"
            variant="outline"
            className="h-9"
            disabled={!hasFilters}
            onClick={() => setFilters({ ...DEFAULT_COMPANY_FILTERS })}
          >
            {t('Clear filters')}
          </Button>
        </div>
      </div>

      <div className="border-border bg-card mt-5 overflow-x-auto rounded-xl border">
        <table className="w-full min-w-[880px] text-sm">
          <thead className="bg-muted/50 text-muted-foreground text-left text-xs font-semibold tracking-wider uppercase">
            <tr>
              <th className="px-4 py-3">{t('Account')}</th>
              <th className="px-4 py-3">{t('Owner')}</th>
              <th className="px-4 py-3">{t('Plan')}</th>
              <th className="px-4 py-3">{t('Status')}</th>
              <th className="px-4 py-3">{t('Valid until')}</th>
              <th className="px-4 py-3 text-right">{t('Members')}</th>
              <th className="px-4 py-3 text-right">{t('Channels')}</th>
              <th className="px-4 py-3">{t('Created')}</th>
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            {filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={8}
                  className="text-muted-foreground px-4 py-10 text-center text-sm"
                >
                  {t('No accounts match the current filters.')}
                </td>
              </tr>
            ) : (
              filtered.map((r) => {
                const ent = resolveEntitlements(r, new Date(snapshotAt));
                const memberCount = Number(r.members_count);
                const pending = Number(r.pending_invites_count);
                const overMembers =
                  ent.limits.max_users !== null &&
                  memberCount + pending >= ent.limits.max_users;
                return (
                  <tr
                    key={r.id}
                    className="hover:bg-muted/40 transition-colors"
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/platform/${r.id}`}
                        className="text-foreground hover:text-primary font-medium underline-offset-4 hover:underline"
                        data-no-translate
                      >
                        {r.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3" data-no-translate>
                      <div className="text-foreground">
                        {r.owner_name || '—'}
                      </div>
                      <div className="text-muted-foreground text-xs">
                        {r.owner_email ?? '—'}
                      </div>
                    </td>
                    <td className="text-foreground px-4 py-3">
                      {t(PLAN_LABELS[ent.plan])}
                    </td>
                    <td className="px-4 py-3">
                      <PlanStatusChip
                        status={ent.status}
                        blocked={!!ent.blocked}
                      />
                    </td>
                    <td className="text-foreground px-4 py-3" data-no-translate>
                      {fmtDate(r.plan_expires_at, language)}
                    </td>
                    <td
                      className={cn(
                        'px-4 py-3 text-right tabular-nums',
                        overMembers
                          ? 'text-amber-700 [[data-mode=dark]_&]:text-amber-300'
                          : 'text-foreground'
                      )}
                      data-no-translate
                    >
                      {memberCount}
                      {pending ? `+${pending}` : ''} /{' '}
                      {fmtLimit(ent.limits.max_users)}
                    </td>
                    <td
                      className="text-foreground px-4 py-3 text-right tabular-nums"
                      data-no-translate
                    >
                      {Number(r.channels_count)} /{' '}
                      {fmtLimit(ent.limits.max_channels)}
                    </td>
                    <td
                      className="text-muted-foreground px-4 py-3"
                      data-no-translate
                    >
                      {fmtDate(r.created_at, language)}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
