'use client';
import { useState } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { formatPlanPrice } from '@/lib/plan-editor';
import { parsePlanVersion, type PlanVersionHistory } from '@/lib/plan-catalog';
import { MODULE_LABELS, type Plan } from '@/lib/plans';
export function PlanVersionHistoryList({ plan }: { plan: Plan }) {
  const { t, language } = useLanguage();
  const [items, setItems] = useState<PlanVersionHistory[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function load() {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(
        `/api/platform/plans/${plan}/history${cursor ? `?cursor=${cursor}` : ''}`
      );
      if (!res.ok)
        throw new Error(t('Could not load version history. Try again.'));
      const page = await res.json();
      if (
        !Array.isArray(page.items) ||
        page.items.some(
          (v: PlanVersionHistory) =>
            !parsePlanVersion(v) ||
            v.plan !== plan ||
            !Number.isFinite(Date.parse(v.created_at)) ||
            !(v.actor_name === null || typeof v.actor_name === 'string')
        )
      )
        throw new Error(t('Could not load version history. Try again.'));
      setItems((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
      setLoaded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Failed to load'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-4 border-t pt-6">
      <h2 className="text-lg font-semibold">{t('Version history')}</h2>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      {items.map((v) => (
        <details key={v.id} className="bg-card rounded-lg border p-4">
          <summary className="cursor-pointer text-sm">
            <span className="font-medium">
              {t('Version')} {v.revision}
            </span>{' '}
            · {formatPlanPrice(v.price_monthly_cents)}
            <span className="text-muted-foreground mt-1 block">
              {new Date(v.created_at).toLocaleString(
                language === 'pt-BR' ? 'pt-BR' : 'en-US'
              )}{' '}
              · {v.actor_name ?? t('Initial conditions')}
            </span>
          </summary>
          <div className="mt-3 space-y-2 text-sm">
            <p>
              {v.definition.limits.max_users ?? t('Unlimited')} {t('users')} ·{' '}
              {v.definition.limits.max_channels ?? t('Unlimited')}{' '}
              {t('channels')}
            </p>
            <p>
              {v.definition.modules
                .map((m) => t(MODULE_LABELS[m]))
                .join(', ') || t('No optional modules')}
            </p>
          </div>
        </details>
      ))}
      {loaded && items.length === 0 && (
        <p className="text-muted-foreground text-sm">
          {t('No versions found.')}
        </p>
      )}
      {(!loaded || cursor || error) && (
        <Button variant="outline" disabled={busy} onClick={load}>
          {busy
            ? t('Loading...')
            : error
              ? t('Try again')
              : loaded
                ? t('Load more')
                : t('View version history')}
        </Button>
      )}
    </section>
  );
}
