'use client';

import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { useLanguage } from '@/hooks/use-language';
import type { ExtraKind } from '@/lib/billing/extras';
import { formatBrl, type ExtrasView } from '@/lib/billing/overview';
import { periodPriceCents, type BillingCycle } from '@/lib/billing/rules';
import { SettingsGroup } from './settings-group';

type Pending = { kind: ExtraKind; delta: number };

/**
 * Settings → Plano → extras: what the plan includes, the extras bought and the
 * next charge, with "+ extra user" / "+ extra number" and a confirmation that
 * shows the new value. Everything is decided again by POST /api/billing/extras;
 * the checks here only avoid dead buttons. Shown only on an active paid
 * subscription (the overview sends `extras: null` otherwise).
 */
export function ExtrasPanel({
  extras,
  cycle,
  valueCents,
  onChanged,
}: {
  extras: ExtrasView;
  cycle: BillingCycle;
  valueCents: number;
  onChanged: () => void;
}) {
  const { t } = useLanguage();
  const [qty, setQty] = useState({ user: 1, channel: 1 });
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rows = [
    {
      kind: 'user' as const,
      title: t('Users'),
      add: t('+ extra user'),
      included: extras.includedUsers,
      bought: extras.users,
      used: extras.usedUsers,
      unit: extras.userUnitCents,
    },
    {
      kind: 'channel' as const,
      title: t('WhatsApp numbers'),
      add: t('+ extra number'),
      included: extras.includedChannels,
      bought: extras.channels,
      used: extras.usedChannels,
      unit: extras.channelUnitCents,
    },
  ];
  const cycleLabel = cycle === 'annual' ? t('/year') : t('/month');

  function newValue(p: Pending): number {
    const unit = (p.kind === 'user' ? extras.userUnitCents : extras.channelUnitCents) ?? 0;
    return valueCents + p.delta * periodPriceCents(unit, cycle);
  }

  async function confirm() {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/billing/extras', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(pending),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        const message = body?.error ? t(body.error) : t('Could not change it right now, try again.');
        setError(message);
        toast.error(message);
        return;
      }
      toast.success(t('Extras updated. The new value starts at your next charge.'));
      setPending(null);
      onChanged();
    } catch {
      const message = t('Could not change it right now, try again.');
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsGroup
      title={t('Extras beyond the plan')}
      description={t(
        'Add users or WhatsApp numbers without changing plan. The new limit works right away; the new value starts at your next charge.',
      )}
    >
      <p className="text-sm">
        {t('Next charge')}:{' '}
        <span className="text-foreground font-semibold tabular-nums" data-no-translate>
          {formatBrl(valueCents)}
        </span>
        <span className="text-muted-foreground">{cycleLabel}</span>
      </p>

      <ul className="grid gap-3 sm:grid-cols-2">
        {rows.map((r) => {
          const q = qty[r.kind];
          const canAdd = r.included !== null && r.unit !== null;
          const canRemove = r.bought > 0 && r.included !== null && r.used <= r.included + r.bought - q && q <= r.bought;
          const inputId = `extra-qty-${r.kind}`;
          return (
            <li key={r.kind} className="border-border flex flex-col gap-3 rounded-xl border p-4">
              <span className="text-foreground font-semibold">{r.title}</span>
              <dl className="text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{t('Included in the plan')}</dt>
                  <dd className="tabular-nums" data-no-translate>
                    {r.included === null ? t('Unlimited') : r.included}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{t('Extras bought')}</dt>
                  <dd className="tabular-nums" data-no-translate>
                    {r.bought}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{t('In use')}</dt>
                  <dd className="tabular-nums" data-no-translate>
                    {r.used}
                  </dd>
                </div>
              </dl>
              {r.included === null ? (
                <p className="text-muted-foreground text-xs">{t('Your plan has no limit here, so there is nothing to add.')}</p>
              ) : r.unit === null ? (
                <p className="text-muted-foreground text-xs">{t('Your plan does not offer this extra. Talk to the SempreCRM team.')}</p>
              ) : (
                <p className="text-muted-foreground text-xs">
                  <span data-no-translate>{formatBrl(r.unit)}</span> {t('per extra, per month')}
                </p>
              )}
              <div className="mt-auto flex flex-wrap items-end gap-2">
                <div>
                  <label htmlFor={inputId} className="text-muted-foreground mb-1 block text-xs">
                    {t('Quantity')}
                  </label>
                  <input
                    id={inputId}
                    type="number"
                    min={1}
                    max={100}
                    value={q}
                    onChange={(e) => setQty((prev) => ({ ...prev, [r.kind]: Math.max(1, Math.min(100, Math.floor(Number(e.target.value)) || 1)) }))}
                    className="border-input bg-background h-9 w-20 rounded-md border px-2 text-sm"
                  />
                </div>
                <Button size="sm" disabled={!canAdd || busy} onClick={() => setPending({ kind: r.kind, delta: q })}>
                  {r.add}
                </Button>
                <Button size="sm" variant="outline" disabled={!canRemove || busy} onClick={() => setPending({ kind: r.kind, delta: -q })}>
                  {t('Remove')}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      {pending ? (
        <div role="alertdialog" aria-label={t('Confirm the change')} className="border-border bg-muted/40 space-y-3 rounded-xl border p-4 text-sm">
          <p>
            {pending.delta > 0 ? t('Add') : t('Remove')} <span data-no-translate>{Math.abs(pending.delta)}</span>{' '}
            {pending.kind === 'user' ? t('extra user(s)') : t('extra number(s)')}
            {'. '}
            {t('New charge')}:{' '}
            <span className="text-foreground font-semibold tabular-nums" data-no-translate>
              {formatBrl(newValue(pending))}
            </span>
            {cycleLabel}, {t('starting at your next charge')}.
          </p>
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void confirm()}>
              {busy ? t('Saving...') : t('Confirm')}
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setPending(null)}>
              {t('Cancel')}
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </SettingsGroup>
  );
}
