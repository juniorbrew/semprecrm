'use client';

import { useCallback, useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { useAuth, useEntitlements } from '@/hooks/use-auth';
import { useLanguage } from '@/hooks/use-language';
import {
  cyclePricing,
  formatBrl,
  paymentStatusKey,
  planAction,
  safeInvoiceUrl,
  situationOf,
  type BillingOverview,
  type Situation,
} from '@/lib/billing/overview';
import type { BillingCycle } from '@/lib/billing/rules';
import { PLAN_LABELS, type Plan } from '@/lib/plans';
import { cn } from '@/lib/utils';
import { SettingsGroup } from './settings-group';

/** English keys; the dictionary carries the pt-BR (i18n-dict/billing.ts). */
const SITUATION_TEXT: Record<Situation, string> = {
  trial: 'You are on the free trial. Subscribe to keep everything running when it ends.',
  trial_expired:
    'Your trial has ended. The account is read-only until you subscribe: you can see everything, but sending and automations are paused.',
  active: 'Your subscription is active.',
  past_due:
    'A payment is overdue. The account is read-only until the charge is paid: you can see everything, but sending and automations are paused.',
  canceled: 'The subscription was canceled. Subscribe again to get back in.',
  suspended: 'This account was suspended by the platform team. Get in touch with support.',
  unavailable: 'We could not read the plan of this account.',
};

type Load = { state: 'loading' } | { state: 'error' } | { state: 'ready'; data: BillingOverview };

/**
 * Settings → Plano → subscription: situation in plain words, the charge to
 * pay, the plans sold online (monthly / annual) and the payment history.
 * Only the owner subscribes (checkout is owner-only on the server too);
 * admins see everything. Reachable while the account is read-only.
 */
export function BillingPanel() {
  const { t, language } = useLanguage();
  const { refreshAccount } = useAuth();
  const ent = useEntitlements();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [cycle, setCycle] = useState<BillingCycle>('annual');
  const [busy, setBusy] = useState<string | null>(null);
  const [payUrl, setPayUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await fetch('/api/billing/overview', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      setLoad({ state: 'ready', data: (await res.json()) as BillingOverview });
    } catch {
      setLoad((prev) => (prev.state === 'ready' ? prev : { state: 'error' }));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Back from the payment tab: pick up the new charge status and plan.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      void reload();
      void refreshAccount();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [reload, refreshAccount]);

  const situation = situationOf(ent);

  async function subscribe(plan: string) {
    setBusy(plan);
    setError(null);
    setPayUrl(null);
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plan, cycle }),
      });
      const body = (await res.json().catch(() => null)) as { url?: string; error?: string; confirmed?: boolean } | null;
      if (res.ok && body?.confirmed) {
        toast.success(t('Payment confirmed. Your plan is active.'));
        void reload();
        void refreshAccount();
        return;
      }
      const url = safeInvoiceUrl(body?.url);
      if (!res.ok || !url) {
        const message = body?.error ? t(body.error) : t('Could not start the payment. Try again in a few minutes.');
        setError(message);
        toast.error(message);
        return;
      }
      setPayUrl(url);
      // A popup blocker may eat this (it runs after the request): the link below is the fallback.
      window.open(url, '_blank', 'noopener,noreferrer');
      void reload();
    } catch {
      const message = t('Could not start the payment. Try again in a few minutes.');
      setError(message);
      toast.error(message);
    } finally {
      setBusy(null);
    }
  }

  if (load.state === 'loading') {
    return <div className="bg-muted h-24 animate-pulse rounded-lg" aria-busy="true" />;
  }
  if (load.state === 'error') {
    return (
      <SettingsGroup title={t('Subscription')}>
        <p role="alert" className="text-muted-foreground text-sm">
          {t('Could not load the subscription details.')}
        </p>
        <div>
          <Button variant="outline" size="sm" onClick={() => void reload()}>
            {t('Try again')}
          </Button>
        </div>
      </SettingsGroup>
    );
  }

  const o = load.data;
  const currentPlan = o.billing && o.billing.status !== 'canceled' ? o.billing.plan : null;

  return (
    <div className="space-y-8">
      <SettingsGroup title={t('Subscription')} description={t(SITUATION_TEXT[situation])}>
        {o.pendingInvoiceUrl ? (
          <div>
            <Button nativeButton={false} render={<a href={o.pendingInvoiceUrl} target="_blank" rel="noopener noreferrer" />}>
              <ExternalLink className="size-4" aria-hidden="true" />
              {t('Pay pending charge')}
            </Button>
          </div>
        ) : null}

        {!o.configured ? (
          <p role="status" className="text-muted-foreground text-sm">
            {t('Online payment is not available yet. Talk to the SempreCRM team.')}
          </p>
        ) : (
          <>
            <div role="group" aria-label={t('Billing cycle')} className="bg-muted inline-flex w-fit rounded-lg p-0.5 text-sm">
              {(['monthly', 'annual'] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-pressed={cycle === c}
                  onClick={() => setCycle(c)}
                  className={cn(
                    'rounded-md px-3 py-1.5 font-medium transition-colors',
                    cycle === c ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {c === 'monthly' ? t('Monthly') : t('Annual')}
                  {c === 'annual' ? <span className="text-primary ml-1.5 text-xs">{t('2 months free')}</span> : null}
                </button>
              ))}
            </div>

            <ul className="grid gap-3 sm:grid-cols-2">
              {o.plans.map((p) => {
                const { periodCents, annualSavingsCents } = cyclePricing(p.monthlyCents, cycle);
                const isCurrent = currentPlan === p.plan;
                const action = planAction(situation, isCurrent);
                return (
                  <li key={p.plan} className={cn('border-border flex flex-col gap-3 rounded-xl border p-4', isCurrent && 'border-primary/50')}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-foreground font-semibold">{t(PLAN_LABELS[p.plan as Plan] ?? p.plan)}</span>
                      {isCurrent ? <span className="text-primary text-xs font-medium">{t('Current plan')}</span> : null}
                    </div>
                    <div>
                      <p className="text-foreground text-2xl font-semibold tabular-nums" data-no-translate>
                        {formatBrl(cycle === 'annual' ? periodCents : p.monthlyCents)}
                        <span className="text-muted-foreground text-sm font-normal">{cycle === 'annual' ? t('/year') : t('/month')}</span>
                      </p>
                      {cycle === 'annual' ? (
                        <p className="text-muted-foreground mt-0.5 text-xs">
                          <span data-no-translate>{formatBrl(Math.round(periodCents / 12))}</span> {t('per month on average')} ·{' '}
                          {t('you save')} <span data-no-translate>{formatBrl(annualSavingsCents)}</span>
                        </p>
                      ) : null}
                    </div>
                    {!o.canSubscribe ? null : action === 'locked' ? null : (
                      <Button
                        className="mt-auto w-full"
                        disabled={busy !== null}
                        onClick={() => void subscribe(p.plan)}
                      >
                        {busy === p.plan ? t('Opening…') : action === 'pay' ? t('Pay overdue charge') : t('Subscribe')}
                      </Button>
                    )}
                  </li>
                );
              })}
              <li className="border-border flex flex-col gap-3 rounded-xl border border-dashed p-4">
                <span className="text-foreground font-semibold">{t(PLAN_LABELS.empresa)}</span>
                <p className="text-muted-foreground text-sm">{t('Custom plan. Talk to the SempreCRM team.')}</p>
              </li>
            </ul>

            {!o.canSubscribe ? (
              <p className="text-muted-foreground text-sm">{t('Only the account owner can subscribe or change the plan.')}</p>
            ) : situation === 'active' ? (
              <p className="text-muted-foreground text-sm">
                {t('To change the plan or the cycle of an active subscription, talk to the SempreCRM team.')}
              </p>
            ) : null}

            {error ? (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            ) : null}
            {payUrl ? (
              <p className="text-sm">
                {t('The payment page opened in a new tab.')}{' '}
                <a href={payUrl} target="_blank" rel="noopener noreferrer" className="text-primary font-medium underline-offset-4 hover:underline">
                  {t('Open the payment page')}
                </a>
              </p>
            ) : null}
          </>
        )}
      </SettingsGroup>

      <SettingsGroup title={t('Payment history')}>
        {o.payments.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('No charges yet.')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted-foreground text-left text-xs">
                  <th className="py-2 pr-4 font-medium">{t('Due date')}</th>
                  <th className="py-2 pr-4 font-medium">{t('Amount')}</th>
                  <th className="py-2 pr-4 font-medium">{t('Status')}</th>
                  <th className="py-2 font-medium">
                    <span className="sr-only">{t('Link')}</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-border divide-y">
                {o.payments.map((p) => (
                  <tr key={p.id}>
                    <td className="py-2 pr-4 tabular-nums" data-no-translate>
                      {p.dueDate ? new Date(`${p.dueDate}T12:00:00`).toLocaleDateString(language) : '—'}
                    </td>
                    <td className="py-2 pr-4 tabular-nums" data-no-translate>
                      {formatBrl(p.valueCents)}
                    </td>
                    <td className="py-2 pr-4">{t(paymentStatusKey(p.status))}</td>
                    <td className="py-2 text-right">
                      {p.invoiceUrl ? (
                        <a
                          href={p.invoiceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline"
                        >
                          {t('Open')}
                          <ExternalLink className="size-3.5" aria-hidden="true" />
                        </a>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SettingsGroup>
    </div>
  );
}
