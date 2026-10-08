'use client';
import Link from 'next/link';
import { useLanguage } from '@/hooks/use-language';
import { PLAN_LABELS } from '@/lib/plans';
import { formatPlanPrice } from '@/lib/plan-editor';
import type { PlanVersion } from '@/lib/plan-catalog';
export function PlanCatalogList({ plans }: { plans: PlanVersion[] }) {
  const { t } = useLanguage();
  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('Plans')}</h1>
        <p className="text-muted-foreground mt-2 max-w-3xl text-sm">
          {t(
            'Catalog changes apply to new contracts. Existing companies keep their granted conditions.'
          )}
        </p>
      </div>
      <div className="divide-border bg-card divide-y rounded-xl border">
        {plans.map((v) => (
          <Link
            key={v.id}
            href={`/platform/plans/${v.plan}`}
            className="hover:bg-muted focus-visible:outline-primary flex flex-wrap items-center justify-between gap-4 p-5 focus-visible:outline-2"
          >
            <div>
              <h2 className="font-semibold">{t(PLAN_LABELS[v.plan])}</h2>
              <p className="text-muted-foreground mt-1 text-sm">
                {t('Version')} {v.revision} · {v.definition.modules.length}{' '}
                {t('optional modules')}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
              <span className="font-medium tabular-nums">
                {formatPlanPrice(v.price_monthly_cents)}
                {v.price_monthly_cents !== null && ' / mês'}
              </span>
              <span>
                {v.definition.limits.max_users ?? t('Unlimited')} {t('users')}
              </span>
              <span>
                {v.definition.limits.max_channels ?? t('Unlimited')}{' '}
                {t('channels')}
              </span>
            </div>
            <span className="text-primary text-sm font-medium">
              {t('Edit conditions')}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
