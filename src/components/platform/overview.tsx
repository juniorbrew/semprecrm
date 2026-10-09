'use client';

import { useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowUpRight,
  Building2,
  CheckCircle2,
  Clock3,
  CirclePause,
  CalendarClock,
  RefreshCw,
  TriangleAlert,
  Users,
  Cable,
} from 'lucide-react';
import { useLanguage } from '@/hooks/use-language';
import { getAccountHealth, summarizeAccounts } from '@/lib/platform/overview';
import { PLAN_LABELS } from '@/lib/plans';
import type { PlatformAccountRow } from '@/types';
import { PlanStatusChip } from './plan-status-chip';

export function PlatformOverview({
  rows,
  snapshotAt,
}: {
  rows: PlatformAccountRow[];
  snapshotAt: string;
}) {
  const { t, language } = useLanguage();
  const router = useRouter();
  const [refreshing, startTransition] = useTransition();
  const now = new Date(snapshotAt);
  const summary = summarizeAccounts(rows, now);
  const alerts = rows
    .map((row) => ({ row, health: getAccountHealth(row, now) }))
    .filter(({ health }) => health.attention)
    .sort((a, b) => Number(b.health.expired) - Number(a.health.expired));
  const metrics = [
    {
      label: 'Registered companies',
      value: summary.total,
      icon: Building2,
      href: '/platform/accounts',
    },
    {
      label: 'Active companies',
      value: summary.active,
      icon: CheckCircle2,
      href: '/platform/accounts?status=active',
    },
    {
      label: 'Companies on trial',
      value: summary.trial,
      icon: Clock3,
      href: '/platform/accounts?status=trial',
    },
    {
      label: 'Suspended companies',
      value: summary.suspended,
      icon: CirclePause,
      href: '/platform/accounts?status=suspended',
    },
    {
      label: 'Expiring within 7 days',
      value: summary.expiring,
      icon: CalendarClock,
      href: '/platform/accounts?attention=expiring',
    },
  ];

  return (
    <section className="space-y-8">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {t('Overview')}
          </h1>
          <p className="text-muted-foreground mt-2 text-sm">
            {t('A consolidated view of the companies on SempreCRM.')}
          </p>
          <p className="text-muted-foreground mt-2 text-xs">
            {t('Snapshot updated at')}{' '}
            <time dateTime={snapshotAt} data-no-translate>
              {now.toLocaleString(language, {
                dateStyle: 'short',
                timeStyle: 'short',
                timeZone: 'America/Bahia',
              })}
            </time>
          </p>
        </div>
        <button
          type="button"
          disabled={refreshing}
          onClick={() => startTransition(() => router.refresh())}
          className="border-border bg-card hover:bg-muted focus-visible:outline-primary inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-60"
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          {t(refreshing ? 'Refreshing overview' : 'Refresh overview')}
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {metrics.map(({ label, value, icon: Icon, href }) => (
          <Link
            key={label}
            href={href}
            className="border-border bg-card hover:border-primary/50 focus-visible:outline-primary rounded-xl border p-5 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            <div className="text-muted-foreground flex min-h-10 items-start justify-between gap-3">
              <span className="text-sm font-medium">{t(label)}</span>
              <Icon className="size-4 shrink-0" aria-hidden="true" />
            </div>
            <div className="mt-4 flex items-end justify-between">
              <span
                className="text-3xl font-semibold tabular-nums"
                data-no-translate
              >
                {value.toLocaleString(language)}
              </span>
              <ArrowUpRight
                className="text-muted-foreground size-4"
                aria-hidden="true"
              />
            </div>
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="border-border bg-card rounded-xl border px-6 py-12 text-center">
          <Building2
            className="text-muted-foreground mx-auto mb-4 size-8"
            aria-hidden="true"
          />
          <h2 className="text-lg font-semibold">
            {t('No companies registered yet.')}
          </h2>
          <p className="text-muted-foreground mt-2 text-sm">
            {t('Companies will appear here after registration.')}
          </p>
        </div>
      ) : (
        <>
          <section aria-labelledby="platform-alerts">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 id="platform-alerts" className="text-lg font-semibold">
                  {t('Requires attention')}{' '}
                  <span
                    className="text-muted-foreground ml-1 text-sm tabular-nums"
                    data-no-translate
                  >
                    ({summary.attention})
                  </span>
                </h2>
                <p className="text-muted-foreground mt-1 text-sm">
                  {t('Company status, expiration and capacity alerts')}
                </p>
              </div>
              <p className="text-muted-foreground text-xs">
                {t('Pending invitations count toward the user limit.')}
              </p>
            </div>
            {alerts.length === 0 ? (
              <div className="border-border bg-card flex items-center gap-3 rounded-xl border p-5">
                <CheckCircle2
                  className="text-primary size-5 shrink-0"
                  aria-hidden="true"
                />
                <p className="text-sm">{t('No companies need attention.')}</p>
              </div>
            ) : (
              <ul className="border-border bg-card divide-border max-h-96 divide-y overflow-y-auto rounded-xl border">
                {alerts.map(({ row, health }) => (
                  <li key={row.id}>
                    <Link
                      href={`/platform/${row.id}`}
                      className="hover:bg-muted/40 focus-visible:outline-primary flex items-center justify-between gap-4 p-4 focus-visible:outline-2 focus-visible:outline-offset-[-2px] sm:px-5"
                    >
                      <div className="flex min-w-0 items-start gap-3">
                        <TriangleAlert
                          className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300"
                          aria-hidden="true"
                        />
                        <div className="min-w-0">
                          <p
                            className="truncate text-sm font-medium"
                            data-no-translate
                          >
                            {row.name}
                          </p>
                          <ul className="text-muted-foreground mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                            {health.ent.status === 'suspended' && (
                              <li>{t('Account suspended')}</li>
                            )}
                            {health.ent.status === 'past_due' && (
                              <li>{t('Payment past due')}</li>
                            )}
                            {health.expired ? (
                              <li>
                                {t('Expired plan')}
                                {health.ent.expiresAt ? (
                                  <span data-no-translate>
                                    {' · '}
                                    {new Date(
                                      health.ent.expiresAt
                                    ).toLocaleDateString(language, {
                                      timeZone: 'America/Bahia',
                                    })}
                                  </span>
                                ) : null}
                              </li>
                            ) : health.expiring ? (
                              <li>
                                {t('Expiring plan')}
                                {health.ent.expiresAt ? (
                                  <span data-no-translate>
                                    {' · '}
                                    {new Date(
                                      health.ent.expiresAt
                                    ).toLocaleDateString(language, {
                                      timeZone: 'America/Bahia',
                                    })}
                                  </span>
                                ) : null}
                              </li>
                            ) : null}
                            {health.usersAtLimit ? (
                              <li>{t('User limit reached')}</li>
                            ) : null}
                            {health.channelsAtLimit ? (
                              <li>{t('Channel limit reached')}</li>
                            ) : null}
                          </ul>
                        </div>
                      </div>
                      <ArrowUpRight
                        className="text-muted-foreground size-4 shrink-0"
                        aria-hidden="true"
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="recent-companies">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h2 id="recent-companies" className="text-lg font-semibold">
                {t('Recent companies')}
              </h2>
              <Link
                href="/platform/accounts"
                className="text-foreground focus-visible:outline-primary inline-flex min-h-10 items-center gap-2 text-sm font-medium hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                {t('View all companies')}
                <ArrowUpRight className="size-4" aria-hidden="true" />
              </Link>
            </div>
            <ul className="border-border bg-card divide-border divide-y rounded-xl border">
              {rows.slice(0, 6).map((row) => {
                const { ent } = getAccountHealth(row, now);
                return (
                  <li key={row.id}>
                    <Link
                      href={`/platform/${row.id}`}
                      className="hover:bg-muted/40 focus-visible:outline-primary flex flex-wrap items-center justify-between gap-3 px-5 py-4 focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
                    >
                      <div className="min-w-0 flex-1">
                        <p
                          className="truncate text-sm font-medium"
                          data-no-translate
                        >
                          {row.name}
                        </p>
                        <p
                          className="text-muted-foreground mt-1 truncate text-xs"
                          data-no-translate
                        >
                          {row.owner_email || row.owner_name || '—'}
                        </p>
                      </div>
                      <span className="text-muted-foreground text-xs">
                        {t(PLAN_LABELS[ent.plan])}
                      </span>
                      <PlanStatusChip
                        status={ent.status}
                        blocked={!!ent.blocked}
                      />
                      <ArrowUpRight
                        className="text-muted-foreground size-4 shrink-0"
                        aria-hidden="true"
                      />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
          <div className="text-muted-foreground border-border flex flex-wrap gap-6 border-t pt-5 text-sm">
            <span className="inline-flex items-center gap-2">
              <Users className="size-4" aria-hidden="true" />
              {t('Members')}:{' '}
              <span className="text-foreground tabular-nums" data-no-translate>
                {summary.members.toLocaleString(language)}
              </span>
            </span>
            <span className="inline-flex items-center gap-2">
              <Cable className="size-4" aria-hidden="true" />
              {t('Channels')}:{' '}
              <span className="text-foreground tabular-nums" data-no-translate>
                {summary.channels.toLocaleString(language)}
              </span>
            </span>
          </div>
        </>
      )}
    </section>
  );
}
