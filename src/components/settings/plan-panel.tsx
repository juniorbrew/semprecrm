'use client';

import { Check, Minus } from 'lucide-react';

import { useAuth, useEntitlements } from '@/hooks/use-auth';
import { useLanguage } from '@/hooks/use-language';
import {
  LIMIT_KEYS,
  LIMIT_LABELS,
  MODULES,
  MODULE_LABELS,
  PLAN_LABELS,
  daysUntil,
  type PlanStatus,
} from '@/lib/plans';
import { SettingsGroup } from './settings-group';
import { SettingsPanelHead } from './settings-panel-head';
import { planStatusLabelKey } from '@/components/platform/plan-status-chip';
import { StatusDot } from './settings-chip';

const STATUS_TONE: Record<PlanStatus, 'ok' | 'warn' | 'bad' | 'muted'> = {
  trial: 'ok',
  active: 'ok',
  past_due: 'warn',
  canceled: 'muted',
  suspended: 'warn',
};

/**
 * Read-only view of the account's plan: which plan, its status and
 * expiry, the modules it turns on, and the limits. Reachable even
 * when the account is blocked (the blocked screen links here) so
 * the owner can see *why* and who to contact.
 *
 * Nothing is editable from the customer side — plan changes go
 * through the platform admin (`/platform`) today and a checkout
 * webhook later.
 */
export function PlanPanel() {
  const { t, language } = useLanguage();
  const { profileLoading } = useAuth();
  const ent = useEntitlements();

  if (
    !profileLoading &&
    ent.blocked &&
    ent.blocked.reason === 'plan_unavailable'
  )
    return (
      <section className="max-w-2xl space-y-4">
        <SettingsPanelHead
          title={t('Plan')}
          description="Não foi possível carregar as condições concedidas à sua empresa."
        />
        <p role="alert" className="text-muted-foreground text-sm">
          Tente novamente em instantes. Se o problema continuar, entre em
          contato com o suporte.
        </p>
        <button
          onClick={() => window.location.reload()}
          className="bg-primary text-primary-foreground min-h-10 rounded-lg px-4 text-sm font-medium"
        >
          {t('Try again')}
        </button>
      </section>
    );

  const days = daysUntil(ent.expiresAt);
  const expiresLabel = ent.expiresAt
    ? new Date(ent.expiresAt).toLocaleDateString(language, {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      })
    : null;

  return (
    <section className="max-w-2xl">
      <SettingsPanelHead
        title={t('Plan')}
        description={t(
          'What your account includes today. To change the plan or add modules, get in touch with the SempreCRM team.'
        )}
      />

      <div className="space-y-8">
        <SettingsGroup
          title={t('Current plan')}
          description={t('Plan, status and validity for this account.')}
        >
          {profileLoading ? (
            <div className="bg-muted h-16 animate-pulse rounded-lg" />
          ) : (
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-foreground text-base font-semibold">
                  {t(PLAN_LABELS[ent.plan])}
                </span>
                <span className="text-foreground inline-flex items-center gap-1.5 text-sm">
                  <StatusDot tone={STATUS_TONE[ent.status]} />
                  {t(planStatusLabelKey(ent.status))}
                </span>
              </div>
              <p className="text-muted-foreground text-sm">
                {!expiresLabel
                  ? t('Validity')
                  : ent.status === 'trial'
                    ? t('Trial ends')
                    : t('Valid until')}
                {': '}
                {expiresLabel ? (
                  <span
                    data-no-translate
                    className="text-foreground tabular-nums"
                  >
                    {expiresLabel}
                    {days !== null && days >= 0 ? (
                      <span className="text-muted-foreground">
                        {' '}
                        · {days} {days === 1 ? t('day') : t('days')}
                      </span>
                    ) : null}
                  </span>
                ) : (
                  <span>{t('No end date')}</span>
                )}
              </p>
            </div>
          )}
          {ent.blocked ? (
            <p className="text-foreground flex items-center gap-2 text-sm">
              <StatusDot tone="warn" />
              {t(
                'Access to the app is currently blocked. Contact support to restore it.'
              )}
            </p>
          ) : null}
        </SettingsGroup>

        <SettingsGroup
          title={t('Modules')}
          description={t('Inbox and Contacts are always included.')}
        >
          <ul className="grid gap-x-6 sm:grid-cols-2">
            {MODULES.map((m) => {
              const on = ent.modules[m];
              return (
                <li key={m} className="flex items-center gap-2 py-1.5 text-sm">
                  {on ? (
                    <Check
                      className="size-4 text-emerald-500"
                      aria-hidden="true"
                    />
                  ) : (
                    <Minus
                      className="text-muted-foreground size-4"
                      aria-hidden="true"
                    />
                  )}
                  <span
                    className={on ? 'text-foreground' : 'text-muted-foreground'}
                  >
                    {t(MODULE_LABELS[m])}
                  </span>
                </li>
              );
            })}
          </ul>
        </SettingsGroup>

        <SettingsGroup title={t('Limits')}>
          <dl className="divide-border divide-y">
            {LIMIT_KEYS.map((k) => (
              <div
                key={k}
                className="flex items-center justify-between gap-4 py-2.5 text-sm"
              >
                <dt className="text-muted-foreground">{t(LIMIT_LABELS[k])}</dt>
                <dd className="text-foreground font-medium tabular-nums">
                  {ent.limits[k] === null ? t('Unlimited') : ent.limits[k]}
                </dd>
              </div>
            ))}
          </dl>
        </SettingsGroup>
      </div>
    </section>
  );
}
