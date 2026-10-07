'use client';

import { TriangleAlert } from 'lucide-react';
import { useLanguage } from '@/hooks/use-language';
import { PLAN_LABELS } from '@/lib/plans';
import { getAccountHealth } from '@/lib/platform/overview';
import type { PlatformAccountRow } from '@/types';

export function PlatformAccountSummary({
  row,
  snapshotAt,
}: {
  row: PlatformAccountRow;
  snapshotAt: string;
}) {
  const { t, language } = useLanguage();
  const health = getAccountHealth(row, new Date(snapshotAt));
  const { ent } = health;
  const expiry = ent.expiresAt ? new Date(ent.expiresAt) : null;
  const validExpiry = expiry && !Number.isNaN(expiry.getTime());
  const users = Number(row.members_count) + Number(row.pending_invites_count);
  const alerts = [
    ...(health.expired
      ? ['Expired plan']
      : health.expiring
        ? ['Expiring plan']
        : []),
    ...(ent.blocked ? ['Company access is blocked.'] : []),
    ...(health.usersAtLimit ? ['User limit reached'] : []),
    ...(health.channelsAtLimit ? ['Channel limit reached'] : []),
  ];
  const capacity = (used: number, limit: number | null) =>
    `${used} / ${limit === null ? t('Unlimited') : limit}`;

  return (
    <section
      aria-labelledby="company-summary-title"
      className="border-border bg-card rounded-xl border p-5 sm:p-6"
      data-no-translate
    >
      <div className="border-border mb-5 flex flex-col justify-between gap-4 border-b pb-5 sm:flex-row">
        <div>
          <h2 id="company-summary-title" className="text-lg font-semibold">
            {t('Company summary')}
          </h2>
          <p className="text-muted-foreground mt-1 text-xs">
            {t('Saved settings. Changes appear here after saving.')}
          </p>
        </div>
        <dl className="min-w-0 sm:max-w-[50%] sm:text-right">
          <dt className="text-muted-foreground text-xs">
            {t('Company owner')}
          </dt>
          <dd className="mt-1 text-sm font-medium break-words">
            {row.owner_name || t('Not available')}
          </dd>
          <dd className="text-muted-foreground mt-1 text-xs break-all">
            {row.owner_email || t('Not available')}
          </dd>
        </dl>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-5 xl:grid-cols-4">
        <div>
          <dt className="text-muted-foreground text-xs">{t('Plan')}</dt>
          <dd className="mt-2 text-base font-semibold">
            {t(PLAN_LABELS[ent.plan])}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">{t('Valid until')}</dt>
          <dd className="mt-2 text-sm font-medium">
            {validExpiry ? (
              <time dateTime={ent.expiresAt!}>
                {expiry.toLocaleString(language, {
                  dateStyle: 'short',
                  timeStyle: 'short',
                  timeZone: 'America/Bahia',
                })}
              </time>
            ) : (
              t('No expiration date')
            )}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">
            {t('User capacity')}
          </dt>
          <dd className="mt-2 text-base font-semibold tabular-nums">
            {capacity(users, ent.limits.max_users)}
          </dd>
          <dd className="text-muted-foreground mt-1 text-xs">
            {Number(row.members_count)} {t('members')} ·{' '}
            {Number(row.pending_invites_count)} {t('pending invitations')}
          </dd>
          <dd className="text-muted-foreground mt-1 text-xs">
            {t('Pending invitations count toward the user limit.')}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">
            {t('Channel capacity')}
          </dt>
          <dd className="mt-2 text-base font-semibold tabular-nums">
            {capacity(Number(row.channels_count), ent.limits.max_channels)}
          </dd>
        </div>
      </dl>
      <div className="border-border mt-5 border-t pt-4">
        {alerts.length ? (
          <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {alerts.map((alert) => (
              <li key={alert} className="flex items-start gap-2">
                <TriangleAlert
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0 text-amber-700 [[data-mode=dark]_&]:text-amber-300"
                />
                <span>{t(alert)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">
            {t('No expiration or capacity alerts.')}
          </p>
        )}
      </div>
    </section>
  );
}
