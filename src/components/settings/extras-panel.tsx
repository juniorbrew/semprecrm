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
type Response = { error?: string; pendingRemoval?: { effectiveDate: string } | null };

/**
 * Settings → Plano → extras: what the plan includes, the extras bought and the
 * next charge, with "+ extra user" / "+ extra number" and a confirmation that
 * shows the new value. Adding is immediate for the limit and goes into the next
 * charge; removing is scheduled (the extras stay until the end of the paid period).
 * Only the owner changes anything (admins see it read-only). Everything is decided
 * again by POST /api/billing/extras; the checks here only avoid dead buttons.
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
  const { t, language } = useLanguage();
  const [qty, setQty] = useState({ user: 1, channel: 1 });
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scheduled = extras.pendingRemoval;
  const locked = !extras.canChange || busy;
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
  const day = (iso: string) =>
    new Date(`${iso}T12:00:00`).toLocaleDateString(language, { day: '2-digit', month: '2-digit' });

  async function send(body: Record<string, unknown>, done: (r: Response) => string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/billing/extras', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as Response | null;
      if (!res.ok) {
        const message = data?.error ? t(data.error) : t('Could not change it right now, try again.');
        setError(message);
        toast.error(message);
        return;
      }
      toast.success(done(data ?? {}));
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

  const confirm = () =>
    pending &&
    send(pending, (r) =>
      pending.delta > 0
        ? t('Extras added. The limit is already higher; the new value is in your next charge.')
        : `${t('Removal scheduled: the extras stay active until')} ${r.pendingRemoval ? day(r.pendingRemoval.effectiveDate) : ''}.`,
    );

  return (
    <SettingsGroup
      title={t('Extras beyond the plan')}
      description={t(
        'Add users or WhatsApp numbers without changing plan. Added extras work right away and go into your next charge. Removed extras stay active until the end of the period you already paid.',
      )}
    >
      <p className="text-sm">
        {t('Next charge')}:{' '}
        <span className="text-foreground font-semibold tabular-nums" data-no-translate>
          {formatBrl(valueCents)}
        </span>
        <span className="text-muted-foreground">{cycleLabel}</span>
      </p>

      {!extras.canChange ? (
        <p role="status" className="text-muted-foreground text-sm">
          {t('Only the account owner can buy or remove extras. Ask the account owner.')}
        </p>
      ) : null}

      {scheduled ? (
        <div role="status" className="border-border bg-muted/40 flex flex-wrap items-center gap-3 rounded-xl border p-3 text-sm">
          <span>
            {t('Removal scheduled: the extras stay active until')} <span data-no-translate>{day(scheduled.effectiveDate)}</span>.{' '}
            {t('Then the limit drops to')} <span data-no-translate>{scheduled.users}</span> {t('extra user(s)')},{' '}
            <span data-no-translate>{scheduled.channels}</span> {t('extra number(s)')}.
          </span>
          {extras.canChange ? (
            <Button size="sm" variant="outline" disabled={locked} onClick={() => void send({ cancel_removal: true }, () => t('Removal cancelled.'))}>
              {t('Cancel removal')}
            </Button>
          ) : null}
        </div>
      ) : null}

      <ul className="grid gap-3 sm:grid-cols-2">
        {rows.map((r) => {
          const q = qty[r.kind];
          const canAdd = !scheduled && r.included !== null && r.unit !== null;
          const canRemove = !scheduled && r.bought > 0 && q <= r.bought && (r.included === null || r.used <= r.included + r.bought - q);
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
                  {cycle === 'annual' ? (
                    <>
                      {' · '}
                      <span data-no-translate>{formatBrl(periodPriceCents(r.unit, cycle))}</span> {t('per extra, per year (12 months for the price of 10)')}
                    </>
                  ) : null}
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
                    disabled={locked}
                    onChange={(e) => setQty((prev) => ({ ...prev, [r.kind]: Math.max(1, Math.min(100, Math.floor(Number(e.target.value)) || 1)) }))}
                    className="border-input bg-background h-9 w-20 rounded-md border px-2 text-sm"
                  />
                </div>
                <Button size="sm" disabled={!canAdd || locked} onClick={() => setPending({ kind: r.kind, delta: q })}>
                  {r.add}
                </Button>
                <Button size="sm" variant="outline" disabled={!canRemove || locked} onClick={() => setPending({ kind: r.kind, delta: -q })}>
                  {t('Remove')}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      {pending ? <Confirm pending={pending} extras={extras} cycle={cycle} valueCents={valueCents} busy={busy} onConfirm={() => void confirm()} onCancel={() => setPending(null)} /> : null}

      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </SettingsGroup>
  );
}

function Confirm({
  pending,
  extras,
  cycle,
  valueCents,
  busy,
  onConfirm,
  onCancel,
}: {
  pending: Pending;
  extras: ExtrasView;
  cycle: BillingCycle;
  valueCents: number;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useLanguage();
  const unit = (pending.kind === 'user' ? extras.userUnitCents : extras.channelUnitCents) ?? 0;
  const period = periodPriceCents(unit, cycle);
  const adding = pending.delta > 0;
  const label = pending.kind === 'user' ? t('extra user(s)') : t('extra number(s)');
  const cycleLabel = cycle === 'annual' ? t('/year') : t('/month');
  return (
    <div role="alertdialog" aria-label={t('Confirm the change')} className="border-border bg-muted/40 space-y-3 rounded-xl border p-4 text-sm">
      {adding ? (
        <p>
          {t('Add')} <span data-no-translate>{pending.delta}</span> {label}. {t('New charge')}:{' '}
          <span className="text-foreground font-semibold tabular-nums" data-no-translate>
            {formatBrl(valueCents + pending.delta * period)}
          </span>
          {cycleLabel}
          {cycle === 'annual' ? (
            <>
              {' '}
              (<span data-no-translate>{formatBrl(period)}</span> {t('per extra, per year (12 months for the price of 10)')})
            </>
          ) : null}
          . {t('It works right away and goes into your next charge, even one already issued.')}
        </p>
      ) : (
        <p>
          {t('Remove')} <span data-no-translate>{Math.abs(pending.delta)}</span> {label}.{' '}
          {t('They stay active until the end of the period you already paid (and every extra is billed for at least one full period). The charge after that no longer includes them.')}
        </p>
      )}
      <div className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={onConfirm}>
          {busy ? t('Saving...') : t('Confirm')}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onCancel}>
          {t('Cancel')}
        </Button>
      </div>
    </div>
  );
}
