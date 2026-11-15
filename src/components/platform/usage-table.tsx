'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowDown, ArrowUp, Download } from 'lucide-react';

import { useLanguage } from '@/hooks/use-language';
import { PLAN_LABELS, PLANS } from '@/lib/plans';
import {
  MIN_MONTH,
  filterUsageRows,
  sortUsageRows,
  usageToCsv,
  type UsageFilters,
  type UsageRow,
  type UsageSortKey,
} from '@/lib/platform/usage';
import { Button } from '@/components/ui/button';
import { PlanStatusChip } from './plan-status-chip';

const SELECT =
  'border-border bg-muted text-foreground focus:border-primary focus:ring-primary h-9 rounded-lg border px-2.5 text-sm outline-none focus:ring-1';

const COLUMNS: { key: UsageSortKey; label: string; numeric?: boolean }[] = [
  { key: 'name', label: 'Company' },
  { key: 'plan', label: 'Plan' },
  { key: 'status', label: 'Status' },
  { key: 'users', label: 'Users', numeric: true },
  { key: 'channels', label: 'WhatsApp numbers', numeric: true },
  { key: 'conversations', label: 'Conversations', numeric: true },
  { key: 'received', label: 'Received', numeric: true },
  { key: 'sent', label: 'Sent', numeric: true },
  { key: 'aiCalls', label: 'AI calls', numeric: true },
  { key: 'aiCostUsd', label: 'AI cost (USD)', numeric: true },
  { key: 'contacts7d', label: 'New people (7 days)', numeric: true },
  { key: 'lastActivityAt', label: 'Last activity' },
];

const limit = (value: number | null) => (value === null ? '∞' : String(value));

export function PlatformUsageTable({
  rows,
  month,
  maxMonth,
}: {
  rows: UsageRow[];
  month: string;
  maxMonth: string;
}) {
  const { t, language } = useLanguage();
  const [filters, setFilters] = useState<UsageFilters>({
    plan: 'all',
    signal: 'all',
  });
  const [sort, setSort] = useState<{
    key: UsageSortKey;
    dir: 'asc' | 'desc';
  }>({ key: 'name', dir: 'asc' });

  const visible = useMemo(
    () => sortUsageRows(filterUsageRows(rows, filters), sort.key, sort.dir),
    [rows, filters, sort]
  );

  const fmtDate = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleDateString(language, {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          timeZone: 'America/Sao_Paulo',
        })
      : t('Never');
  const usd = new Intl.NumberFormat(language, {
    style: 'currency',
    currency: 'USD',
  });

  const exportCsv = () => {
    const blob = new Blob([usageToCsv(visible)], {
      type: 'text/csv;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `uso-${month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section>
      <h1 className="text-foreground text-2xl font-bold tracking-tight">
        {t('Usage by company')}
      </h1>
      <p className="text-muted-foreground mt-1 text-sm" aria-live="polite">
        {t(
          'Counts only. Conversations, messages and AI use refer to the selected month.'
        )}{' '}
        <span data-no-translate>
          {visible.length}/{rows.length}
        </span>
      </p>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <form method="get" className="flex items-center gap-2">
          <input
            type="month"
            name="month"
            defaultValue={month}
            min={MIN_MONTH}
            max={maxMonth}
            required
            aria-label={t('Month')}
            className={SELECT}
          />
          <Button type="submit" variant="outline" className="h-9">
            {t('Show')}
          </Button>
        </form>
        <select
          value={filters.plan}
          onChange={(e) =>
            setFilters((f) => ({
              ...f,
              plan: e.target.value as UsageFilters['plan'],
            }))
          }
          aria-label={t('Filter by plan')}
          className={SELECT}
        >
          <option value="all">{t('All plans')}</option>
          {PLANS.map((plan) => (
            <option key={plan} value={plan}>
              {t(PLAN_LABELS[plan])}
            </option>
          ))}
        </select>
        <select
          value={filters.signal}
          onChange={(e) =>
            setFilters((f) => ({
              ...f,
              signal: e.target.value as UsageFilters['signal'],
            }))
          }
          aria-label={t('Filter by signal')}
          className={SELECT}
        >
          <option value="all">{t('All signals')}</option>
          <option value="near_limit">{t('Near the limit')}</option>
          <option value="idle">{t('No use for 14 days')}</option>
        </select>
        <Button
          type="button"
          variant="outline"
          className="h-9 sm:ml-auto"
          onClick={exportCsv}
          disabled={visible.length === 0}
        >
          <Download className="size-4" aria-hidden="true" />
          {t('Export CSV')}
        </Button>
      </div>

      <div className="border-border bg-card mt-5 overflow-x-auto rounded-xl border">
        <table className="w-full min-w-[1100px] text-sm">
          <thead className="bg-muted/50 text-muted-foreground text-left text-xs font-semibold tracking-wider uppercase">
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={
                    sort.key === c.key
                      ? sort.dir === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                  }
                  className={`px-3 py-3 ${c.numeric ? 'text-right' : ''}`}
                >
                  <button
                    type="button"
                    className="focus-visible:outline-primary inline-flex min-h-8 items-center gap-1 font-semibold tracking-wider uppercase focus-visible:outline-2"
                    onClick={() =>
                      setSort((s) => ({
                        key: c.key,
                        dir:
                          s.key === c.key && s.dir === 'asc' ? 'desc' : 'asc',
                      }))
                    }
                  >
                    {t(c.label)}
                    {sort.key === c.key &&
                      (sort.dir === 'asc' ? (
                        <ArrowUp className="size-3" aria-hidden="true" />
                      ) : (
                        <ArrowDown className="size-3" aria-hidden="true" />
                      ))}
                  </button>
                </th>
              ))}
              <th scope="col" className="px-3 py-3">
                {t('Signals')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            {visible.length === 0 ? (
              <tr>
                <td
                  colSpan={COLUMNS.length + 1}
                  className="text-muted-foreground px-4 py-10 text-center text-sm"
                >
                  {t('No companies match the current filters.')}
                </td>
              </tr>
            ) : (
              visible.map((r) => (
                <tr key={r.id} className="hover:bg-muted/40 transition-colors">
                  <td className="px-3 py-3" data-no-translate>
                    <Link
                      href={`/platform/${r.id}`}
                      className="text-foreground hover:text-primary font-medium underline-offset-4 hover:underline"
                    >
                      {r.name}
                    </Link>
                  </td>
                  <td className="text-foreground px-3 py-3">
                    {t(PLAN_LABELS[r.plan])}
                  </td>
                  <td className="px-3 py-3">
                    <PlanStatusChip status={r.status} blocked={r.blocked} />
                  </td>
                  <td
                    className="px-3 py-3 text-right tabular-nums"
                    data-no-translate
                  >
                    {r.users} / {limit(r.maxUsers)}
                  </td>
                  <td
                    className="px-3 py-3 text-right tabular-nums"
                    data-no-translate
                  >
                    {r.channels} / {limit(r.maxChannels)}
                  </td>
                  <td
                    className="px-3 py-3 text-right tabular-nums"
                    data-no-translate
                  >
                    {r.conversations}
                  </td>
                  <td
                    className="px-3 py-3 text-right tabular-nums"
                    data-no-translate
                  >
                    {r.received}
                  </td>
                  <td
                    className="px-3 py-3 text-right tabular-nums"
                    data-no-translate
                  >
                    {r.sent}
                  </td>
                  <td
                    className="px-3 py-3 text-right tabular-nums"
                    data-no-translate
                  >
                    {r.aiCalls}
                  </td>
                  <td
                    className="px-3 py-3 text-right tabular-nums"
                    data-no-translate
                  >
                    {usd.format(r.aiCostUsd)}
                  </td>
                  <td
                    className="px-3 py-3 text-right tabular-nums"
                    data-no-translate
                  >
                    {r.contacts7d}
                  </td>
                  <td className="px-3 py-3 whitespace-nowrap" data-no-translate>
                    {fmtDate(r.lastActivityAt)}
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex flex-wrap gap-1">
                      {r.nearLimit && (
                        <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-amber-700 [[data-mode=dark]_&]:text-amber-300">
                          {t('Near the limit')}
                        </span>
                      )}
                      {r.idle && (
                        <span className="border-destructive/40 bg-destructive/10 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap text-red-700 [[data-mode=dark]_&]:text-red-300">
                          {t('No use for 14 days')}
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
