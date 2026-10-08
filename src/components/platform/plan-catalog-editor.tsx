'use client';
import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  PLAN_LABELS,
  OPTIONAL_MODULES,
  MODULE_LABELS,
  LIMIT_KEYS,
  LIMIT_LABELS,
  type OptionalModule,
} from '@/lib/plans';
import { parsePlanVersion, type PlanVersion } from '@/lib/plan-catalog';
import {
  formatPlanPrice,
  parseBrazilianPrice,
  parseCapacity,
} from '@/lib/plan-editor';
import { PlanVersionHistoryList } from './plan-version-history';

const priceInput = (v: PlanVersion) =>
  v.price_monthly_cents === null
    ? ''
    : `${Math.floor(v.price_monthly_cents / 100)},${String(v.price_monthly_cents % 100).padStart(2, '0')}`;
const limitsInput = (v: PlanVersion) => ({
  max_users:
    v.definition.limits.max_users === null
      ? ''
      : String(v.definition.limits.max_users),
  max_channels:
    v.definition.limits.max_channels === null
      ? ''
      : String(v.definition.limits.max_channels),
});
export function PlanCatalogEditor({ initial }: { initial: PlanVersion }) {
  const { t } = useLanguage();
  const [current, setCurrent] = useState(initial);
  const [modules, setModules] = useState<readonly OptionalModule[]>(
    initial.definition.modules
  );
  const [limits, setLimits] = useState(limitsInput(initial));
  const [unlimited, setUnlimited] = useState({
    max_users: initial.definition.limits.max_users === null,
    max_channels: initial.definition.limits.max_channels === null,
  });
  const [price, setPrice] = useState(priceInput(initial));
  const [customPrice, setCustomPrice] = useState(
    initial.price_monthly_cents === null
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [success, setSuccess] = useState('');
  const cents =
    current.plan === 'trial'
      ? 0
      : customPrice
        ? null
        : parseBrazilianPrice(price);
  const capacities = {
    max_users: unlimited.max_users ? null : parseCapacity(limits.max_users),
    max_channels: unlimited.max_channels
      ? null
      : parseCapacity(limits.max_channels),
  };
  const valid =
    (current.plan === 'trial' || customPrice || cents !== null) &&
    LIMIT_KEYS.every((k) => unlimited[k] || capacities[k] !== null);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const res = await fetch(`/api/platform/plans/${current.plan}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expected_version_id: current.id,
          definition: { modules, limits: capacities },
          price_monthly_cents: cents,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setConflict(res.status === 409);
        throw new Error(body?.error ?? t('Failed to save'));
      }
      const saved = parsePlanVersion(body?.plan);
      if (!saved || saved.plan !== current.plan)
        throw new Error(t('Reload the plan to confirm the saved conditions.'));
      setCurrent(saved);
      setConflict(false);
      setSuccess(
        t('Conditions saved. Existing companies keep their versions.')
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Failed to save'));
    } finally {
      setBusy(false);
    }
  }
  async function reload() {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/platform/plans/${current.plan}`);
      if (!res.ok) throw new Error(t('Could not reload the plan. Try again.'));
      const next = parsePlanVersion((await res.json()).plan);
      if (!next || next.plan !== current.plan)
        throw new Error(t('Could not reload the plan. Try again.'));
      setCurrent(next);
      setModules(next.definition.modules);
      setLimits(limitsInput(next));
      setUnlimited({
        max_users: next.definition.limits.max_users === null,
        max_channels: next.definition.limits.max_channels === null,
      });
      setPrice(priceInput(next));
      setCustomPrice(next.price_monthly_cents === null);
      setConflict(false);
      setSuccess('');
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Failed to load'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-6">
      <div>
        <Link
          href="/platform/plans"
          className="text-muted-foreground text-sm hover:underline"
        >
          {t('All plans')}
        </Link>
        <h1 className="mt-3 text-2xl font-semibold">
          {t(PLAN_LABELS[current.plan])}
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {t('Current version')} {current.revision}
        </p>
      </div>
      <p className="bg-muted rounded-lg p-4 text-sm">
        {t(
          'Catalog changes apply to new contracts. Existing companies keep their granted conditions.'
        )}
      </p>
      <form
        onSubmit={save}
        className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]"
      >
        <fieldset disabled={busy} className="min-w-0 space-y-6">
          <section className="space-y-4">
            <h2 className="text-lg font-semibold">
              {t('Advertised monthly price')}
            </h2>
            {current.plan === 'trial' ? (
              <p className="text-sm">{t('Free trial for 14 days')}</p>
            ) : (
              <>
                <label className="flex min-h-10 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={customPrice}
                    onChange={(e) => setCustomPrice(e.target.checked)}
                  />
                  {t('Personalized pricing')}
                </label>
                <label
                  htmlFor="plan-price"
                  className="block text-sm font-medium"
                >
                  {t('Monthly price in BRL')}
                </label>
                <Input
                  id="plan-price"
                  inputMode="decimal"
                  value={price}
                  disabled={customPrice}
                  onChange={(e) => setPrice(e.target.value)}
                  aria-invalid={!customPrice && cents === null}
                />
                {!customPrice && cents === null && (
                  <p className="text-destructive text-sm">
                    {t(
                      'Enter a price such as 59,90, with at most two decimal places.'
                    )}
                  </p>
                )}
              </>
            )}
          </section>
          <section className="space-y-3 border-t pt-5">
            <h2 className="text-lg font-semibold">{t('Capacity limits')}</h2>
            {LIMIT_KEYS.map((k) => (
              <div key={k} className="grid gap-2 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor={`plan-${k}`}
                    className="mb-2 block text-sm font-medium"
                  >
                    {t(LIMIT_LABELS[k])}
                  </label>
                  <Input
                    id={`plan-${k}`}
                    inputMode="numeric"
                    value={limits[k]}
                    disabled={unlimited[k]}
                    onChange={(e) =>
                      setLimits((prev) => ({ ...prev, [k]: e.target.value }))
                    }
                    aria-invalid={!unlimited[k] && capacities[k] === null}
                  />
                </div>
                <label className="flex min-h-10 items-center gap-2 text-sm sm:self-end">
                  <input
                    type="checkbox"
                    checked={unlimited[k]}
                    onChange={(e) =>
                      setUnlimited((prev) => ({
                        ...prev,
                        [k]: e.target.checked,
                      }))
                    }
                  />
                  {t('Unlimited')} — {t(LIMIT_LABELS[k])}
                </label>
              </div>
            ))}
            {!LIMIT_KEYS.every(
              (k) => unlimited[k] || capacities[k] !== null
            ) && (
              <p className="text-destructive text-sm">
                {t('Limits must be whole numbers, zero or unlimited.')}
              </p>
            )}
          </section>
          <section className="border-t pt-5">
            <h2 className="text-lg font-semibold">{t('Modules')}</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              {t('Inbox and Contacts are always included.')}
            </p>
            <div className="mt-3 grid gap-x-6 sm:grid-cols-2">
              {OPTIONAL_MODULES.map((m) => (
                <label
                  key={m}
                  className="flex min-h-11 items-center gap-3 border-b py-2 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={modules.includes(m)}
                    onChange={(e) =>
                      setModules((prev) =>
                        e.target.checked
                          ? [...prev, m]
                          : prev.filter((value) => value !== m)
                      )
                    }
                  />
                  {t(MODULE_LABELS[m])}
                </label>
              ))}
            </div>
          </section>
        </fieldset>
        <aside className="bg-card space-y-4 rounded-xl border p-5 xl:sticky xl:top-6">
          <h2 className="font-semibold">{t('Preview of new contracts')}</h2>
          <p className="text-muted-foreground text-sm">
            {t('Calculated before saving.')}
          </p>
          <p className="text-lg font-semibold tabular-nums">
            {valid ? formatPlanPrice(cents) : t('Check the fields')}
          </p>
          <dl className="space-y-2 text-sm">
            {LIMIT_KEYS.map((k) => (
              <div key={k} className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{t(LIMIT_LABELS[k])}</dt>
                <dd>
                  {unlimited[k] ? t('Unlimited') : (capacities[k] ?? '—')}
                </dd>
              </div>
            ))}
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">{t('Optional modules')}</dt>
              <dd>{modules.length}</dd>
            </div>
          </dl>
          <p className="text-muted-foreground text-xs">
            {t(
              'This advertised price does not change existing contracted prices.'
            )}
          </p>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          {success && (
            <p role="status" className="text-sm">
              {success}
            </p>
          )}
          <Button
            type="submit"
            className="w-full"
            disabled={busy || !valid || conflict}
          >
            {busy ? t('Saving...') : t('Save conditions')}
          </Button>
          {conflict && (
            <Button
              type="button"
              variant="outline"
              className="h-auto min-h-10 w-full whitespace-normal"
              disabled={busy}
              onClick={reload}
            >
              {t('Reload current conditions and discard draft')}
            </Button>
          )}
        </aside>
      </form>
      <PlanVersionHistoryList key={current.id} plan={current.plan} />
    </section>
  );
}
