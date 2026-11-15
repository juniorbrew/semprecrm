'use client';

// Settings → Página de agendamento (migration 113): the public page where a
// customer books by themselves. Admin only; needs the `calendar` and
// `booking_page` modules. Everything the customer sees comes from the agenda
// (services, professionals, hours); this screen only picks what the page
// offers and its own rules.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, ExternalLink, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { agendaFetch, useAgendaConfig } from '@/components/agenda/use-agenda-config';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useLanguage } from '@/hooks/use-language';
import { useReadOnly } from '@/hooks/use-read-only';

import { SettingsGroup } from './settings-group';
import { SettingsPanelHead } from './settings-panel-head';

interface PageRow {
  slug: string;
  enabled: boolean;
  title: string | null;
  intro: string | null;
  whatsapp_number: string | null;
  show_prices: boolean;
  service_ids: string[] | null;
  resource_ids: string[] | null;
  min_notice_minutes: number | null;
  max_days_ahead: number | null;
  max_future_per_contact: number;
  allow_cancel: boolean;
  allow_reschedule: boolean;
  change_limit_hours: number;
}

interface Hints {
  suggested_slug: string;
  qr_number: string | null;
  whatsapp_connected: boolean;
}

const DEFAULTS: Omit<PageRow, 'slug' | 'whatsapp_number'> = {
  enabled: false,
  title: null,
  intro: null,
  show_prices: true,
  service_ids: null,
  resource_ids: null,
  min_notice_minutes: null,
  max_days_ahead: null,
  max_future_per_contact: 2,
  allow_cancel: true,
  allow_reschedule: true,
  change_limit_hours: 2,
};

/** Number fields are kept as typed and parsed on save: "" = empty, NaN = not a number. */
function parseNum(value: string): number | null {
  const v = value.trim().replace(',', '.');
  return v ? Number(v) : null;
}

interface NumDraft {
  notice: string;
  days: string;
  future: string;
  change: string;
}

const toDraft = (row: PageRow): NumDraft => ({
  notice: row.min_notice_minutes == null ? '' : String(row.min_notice_minutes / 60),
  days: row.max_days_ahead == null ? '' : String(row.max_days_ahead),
  future: String(row.max_future_per_contact),
  change: String(row.change_limit_hours),
});

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0">
        <p className="text-sm text-foreground">{label}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

export function BookingPageSettings() {
  const { t } = useLanguage();
  const { readOnly } = useReadOnly();
  const { config } = useAgendaConfig();
  const [hints, setHints] = useState<Hints | null>(null);
  const [form, setForm] = useState<PageRow | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nums, setNums] = useState<NumDraft>({ notice: '', days: '', future: '2', change: '2' });
  /** The address as saved: the copy / open link must exist. */
  const [savedSlug, setSavedSlug] = useState<string | null>(null);
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    agendaFetch<{ page: PageRow | null; hints: Hints }>('/api/agenda/pagina')
      .then(({ page, hints: h }) => {
        setHints(h);
        setSaved(!!page);
        setSavedSlug(page?.enabled ? page.slug : null);
        const row = page ?? { ...DEFAULTS, slug: h.suggested_slug, whatsapp_number: h.qr_number };
        setForm(row);
        setNums(toDraft(row));
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : t('Could not load.')));
  }, [t]);

  const services = useMemo(() => (config?.services ?? []).filter((s) => s.is_active), [config]);
  const resources = useMemo(() => (config?.resources ?? []).filter((r) => r.is_active), [config]);
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const link = savedSlug ? `${origin}/agendar/${savedSlug}` : '';

  if (error && !form) return <p className="text-sm text-destructive">{error}</p>;
  if (!form || !hints) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden /> {t('Loading…')}
      </p>
    );
  }

  const set = <K extends keyof PageRow>(key: K, value: PageRow[K]) => setForm((f) => (f ? { ...f, [key]: value } : f));

  /** Checkbox list where "all checked" is stored as null (= everything the agenda has, now and later). */
  const toggleIn = (key: 'service_ids' | 'resource_ids', all: string[], id: string, on: boolean) => {
    const current = new Set(form[key] ?? all);
    if (on) current.add(id);
    else current.delete(id);
    const next = all.filter((x) => current.has(x));
    set(key, next.length === all.length ? null : next);
  };

  const save = async () => {
    const notice = parseNum(nums.notice);
    const days = parseNum(nums.days);
    const future = parseNum(nums.future);
    const change = parseNum(nums.change);
    const bad =
      (notice != null && !(notice >= 0 && notice <= 720)) ? t('Minimum notice (hours)') + ': 0–720'
      : (days != null && !(Number.isInteger(days) && days >= 1 && days <= 365)) ? t('Up to how many days ahead') + ': 1–365'
      : !(future != null && Number.isInteger(future) && future >= 1 && future <= 10) ? t('Upcoming bookings per customer') + ': 1–10'
      : !(change != null && Number.isInteger(change) && change >= 0 && change <= 720) ? t('Changes allowed until (hours before)') + ': 0–720'
      : null;
    if (bad) {
      setError(bad);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await agendaFetch<{ page: PageRow }>('/api/agenda/pagina', {
        method: 'PUT',
        body: JSON.stringify({
          ...form,
          min_notice_minutes: notice == null ? null : Math.round(notice * 60),
          max_days_ahead: days,
          max_future_per_contact: future,
          change_limit_hours: change,
        }),
      });
      setForm(res.page);
      setNums(toDraft(res.page));
      setSavedSlug(res.page.enabled ? res.page.slug : null);
      setSaved(true);
      toast.success(t('Booking page saved'));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not save.'));
    } finally {
      setSaving(false);
    }
  };

  const disabled = readOnly || saving;
  const noWhatsapp = !hints.whatsapp_connected || !form.whatsapp_number;

  return (
    <div>
      <SettingsPanelHead
        title={t('Booking page')}
        description={t('A link where your customers see the free times and book by themselves. It uses your services, professionals and hours.')}
      />

      <SettingsGroup title={t('Page')}>
        <Row label={t('Page on')} hint={t('When off, the link shows "page not found".')}>
          <Switch checked={form.enabled} onCheckedChange={(v) => set('enabled', v)} disabled={disabled} aria-label={t('Page on')} />
        </Row>
        <label className="mt-3 flex flex-col gap-1.5 text-sm">
          {t('Address')}
          <div className="flex items-center gap-2">
            <span className="hidden text-muted-foreground sm:inline">{origin}/agendar/</span>
            <Input value={form.slug} onChange={(e) => set('slug', e.target.value.toLowerCase())} maxLength={40} disabled={disabled} />
          </div>
          <span className="text-xs text-muted-foreground">{t('Lowercase letters, numbers and hyphen.')}</span>
        </label>
        {saved && link && (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(link).then(() => toast.success(t('Link copied')));
              }}
            >
              <Copy className="size-4" aria-hidden /> {t('Copy link')}
            </Button>
            <a href={link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline">
              <ExternalLink className="size-4" aria-hidden /> {t('Open page')}
            </a>
          </div>
        )}
        <label className="mt-4 flex flex-col gap-1.5 text-sm">
          {t('Name on the page (optional)')}
          <Input value={form.title ?? ''} onChange={(e) => set('title', e.target.value)} maxLength={80} disabled={disabled} />
        </label>
        <label className="mt-3 flex flex-col gap-1.5 text-sm">
          {t('Welcome text (optional)')}
          <Textarea value={form.intro ?? ''} onChange={(e) => set('intro', e.target.value)} maxLength={500} rows={2} disabled={disabled} />
        </label>
      </SettingsGroup>

      <SettingsGroup
        title={t('Phone confirmation')}
        description={t('The customer confirms their phone once by sending a code to this WhatsApp. Without a connected WhatsApp nobody can book online.')}
      >
        <label className="flex flex-col gap-1.5 text-sm">
          {t('WhatsApp number that receives the code (with country code and area code)')}
          <Input
            value={form.whatsapp_number ?? ''}
            onChange={(e) => set('whatsapp_number', e.target.value)}
            inputMode="tel"
            placeholder="5511987654321"
            disabled={disabled}
          />
        </label>
        {noWhatsapp && (
          <p role="status" className="mt-2 rounded-lg bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
            {hints.whatsapp_connected
              ? t('Type the number of the connected WhatsApp to let customers book.')
              : t('No WhatsApp connected: the page shows "unavailable" until you connect one in Settings → WhatsApp.')}
          </p>
        )}
      </SettingsGroup>

      <SettingsGroup title={t('What the page offers')} description={t('Only active services with at least one professional show up.')}>
        <Row label={t('Show prices')}>
          <Switch checked={form.show_prices} onCheckedChange={(v) => set('show_prices', v)} disabled={disabled} aria-label={t('Show prices')} />
        </Row>
        <fieldset className="mt-3">
          <legend className="text-sm">{t('Services')}</legend>
          {services.length === 0 && <p className="text-xs text-muted-foreground">{t('Create services in Services and hours first.')}</p>}
          <div className="mt-1 grid gap-1 sm:grid-cols-2">
            {services.map((s) => (
              <label key={s.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={!form.service_ids || form.service_ids.includes(s.id)}
                  onChange={(e) => toggleIn('service_ids', services.map((x) => x.id), s.id, e.target.checked)}
                  disabled={disabled}
                />
                {s.name}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="mt-3">
          <legend className="text-sm">{t('Professionals')}</legend>
          <div className="mt-1 grid gap-1 sm:grid-cols-2">
            {resources.map((r) => (
              <label key={r.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={!form.resource_ids || form.resource_ids.includes(r.id)}
                  onChange={(e) => toggleIn('resource_ids', resources.map((x) => x.id), r.id, e.target.checked)}
                  disabled={disabled}
                />
                {r.name}
              </label>
            ))}
          </div>
        </fieldset>
      </SettingsGroup>

      <SettingsGroup
        title={t('Online booking rules')}
        description={t('They add to the agenda rules: the stricter one wins. Empty = use the agenda rule.')}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1.5 text-sm">
            {t('Minimum notice (hours)')}
            <Input value={nums.notice} onChange={(e) => setNums((n) => ({ ...n, notice: e.target.value }))} inputMode="decimal" disabled={disabled} />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            {t('Up to how many days ahead')}
            <Input
              value={nums.days}
              onChange={(e) => setNums((n) => ({ ...n, days: e.target.value }))}
              inputMode="numeric"
              disabled={disabled}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            {t('Upcoming bookings per customer')}
            <Input
              value={nums.future}
              onChange={(e) => setNums((n) => ({ ...n, future: e.target.value }))}
              inputMode="numeric"
              disabled={disabled}
            />
          </label>
        </div>
        <Row label={t('Customer can cancel')}>
          <Switch checked={form.allow_cancel} onCheckedChange={(v) => set('allow_cancel', v)} disabled={disabled} aria-label={t('Customer can cancel')} />
        </Row>
        <Row label={t('Customer can reschedule')}>
          <Switch
            checked={form.allow_reschedule}
            onCheckedChange={(v) => set('allow_reschedule', v)}
            disabled={disabled}
            aria-label={t('Customer can reschedule')}
          />
        </Row>
        <label className="mt-2 flex max-w-xs flex-col gap-1.5 text-sm">
          {t('Changes allowed until (hours before)')}
          <Input
            value={nums.change}
            onChange={(e) => setNums((n) => ({ ...n, change: e.target.value }))}
            inputMode="numeric"
            disabled={disabled}
          />
        </label>
      </SettingsGroup>

      {error && (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {error}
        </p>
      )}
      <Button onClick={() => void save()} disabled={disabled}>
        {saving && <Loader2 className="size-4 animate-spin" aria-hidden />} {t('Save')}
      </Button>
    </div>
  );
}
