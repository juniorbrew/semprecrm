'use client';

import { useId, useState } from 'react';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { agendaCopy, type AgendaCopy } from '@/components/agenda/copy';
import { agendaFetch, useAgendaConfig } from '@/components/agenda/use-agenda-config';
import { useCalendarMembers } from '@/components/calendar/hooks';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useCan } from '@/hooks/use-can';
import { useLanguage } from '@/hooks/use-language';
import { useReadOnly } from '@/hooks/use-read-only';
import type {
  AgendaConfig,
  AgendaResource,
  AgendaService,
  AgendaSettings,
  DayException,
} from '@/lib/agenda/types';
import { SLOT_STEP_OPTIONS } from '@/lib/agenda/types';
import {
  emptyWeek,
  formatDuration,
  formatPrice,
  parsePriceToCents,
  summarizeDay,
  WEEKDAY_NAMES,
  WEEKDAY_ORDER,
  weekFromRows,
  weekToRows,
  type WeeklyDraft,
} from '@/lib/agenda/ui';

import { SettingsChip } from './settings-chip';
import { SettingsGroup } from './settings-group';
import { SettingsPanelHead } from './settings-panel-head';

const FIELD =
  'h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50';

function Field({ label, children }: { label: string; children: (id: string) => React.ReactNode }) {
  const id = useId();
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children(id)}
    </div>
  );
}

/**
 * Settings → Serviços e horários (admin+): booking rules, services,
 * professionals / rooms with their services, weekly hours and exceptions.
 * Module `calendar`; writes go through /api/agenda/* (read-only accounts get 402).
 */
export function AgendaServicesSettings() {
  const { language } = useLanguage();
  const copy = agendaCopy(language);
  const { config, loading, error, reload } = useAgendaConfig();
  const canEdit = useCan('edit-settings');
  const { readOnly } = useReadOnly();
  const [service, setService] = useState<Partial<AgendaService> | null>(null);
  const [resource, setResource] = useState<Partial<AgendaResource> | null>(null);
  const disabled = !canEdit || readOnly;

  if (loading) {
    return (
      <p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> …
      </p>
    );
  }
  if (!config) return <p className="text-sm text-destructive">{error}</p>;

  async function remove(url: string) {
    if (!window.confirm(copy.deleteConfirm)) return;
    try {
      await agendaFetch(url, { method: 'DELETE' });
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : copy.failed);
    }
  }

  return (
    <div className="space-y-8">
      <SettingsPanelHead title={copy.settingsTitle} description={copy.settingsDescription} />
      {disabled && <p className="text-sm text-muted-foreground">{copy.readOnly}</p>}

      <RulesGroup settings={config.settings} copy={copy} disabled={disabled} onSaved={reload} />

      <SettingsGroup
        title={copy.services}
        description={copy.servicesHint}
        action={
          <Button size="sm" disabled={disabled} onClick={() => setService({ duration_minutes: 30, buffer_before_minutes: 0, buffer_after_minutes: 0, is_active: true })}>
            <Plus className="size-3.5" /> {copy.newService}
          </Button>
        }
      >
        {config.services.length === 0 ? (
          <p className="text-sm text-muted-foreground">{copy.empty}</p>
        ) : (
          <ul className="divide-y divide-border">
            {config.services.map((s) => (
              <li key={s.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground" data-no-translate>{s.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatDuration(s.duration_minutes)}
                    {s.price_cents !== null ? ` · ${formatPrice(s.price_cents, language)}` : ''}
                    {s.buffer_before_minutes + s.buffer_after_minutes > 0 ? ` · +${s.buffer_before_minutes + s.buffer_after_minutes} min` : ''}
                  </p>
                </div>
                {!s.is_active && <SettingsChip>{copy.inactive}</SettingsChip>}
                <Button variant="ghost" size="icon-sm" aria-label={`${copy.editService}: ${s.name}`} disabled={disabled} onClick={() => setService(s)}>
                  <Pencil className="size-3.5" />
                </Button>
                <Button variant="ghost" size="icon-sm" aria-label={`${copy.remove}: ${s.name}`} disabled={disabled} onClick={() => void remove(`/api/agenda/services/${s.id}`)}>
                  <Trash2 className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SettingsGroup>

      <SettingsGroup
        title={copy.professionals}
        description={copy.professionalsHint}
        action={
          <Button size="sm" disabled={disabled || config.services.length === 0} onClick={() => setResource({ kind: 'professional', is_active: true })}>
            <Plus className="size-3.5" /> {copy.newProfessional}
          </Button>
        }
      >
        {config.resources.length === 0 ? (
          <p className="text-sm text-muted-foreground">{copy.empty}</p>
        ) : (
          <ul className="divide-y divide-border">
            {config.resources.map((r) => {
              const week = weekFromRows(config.working_hours.filter((h) => h.resource_id === r.id));
              const names = config.services
                .filter((s) => config.resource_services.some((l) => l.resource_id === r.id && l.service_id === s.id))
                .map((s) => s.name)
                .join(', ');
              return (
                <li key={r.id} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground" data-no-translate>{r.name}</p>
                    <p className="truncate text-xs text-muted-foreground" data-no-translate>
                      {copy.kinds[r.kind]}
                      {names ? ` · ${names}` : ''}
                      {WEEKDAY_ORDER.some((d) => week[d].length > 0) ? '' : ` · ${copy.closed}`}
                    </p>
                  </div>
                  {!r.is_active && <SettingsChip>{copy.inactive}</SettingsChip>}
                  <Button variant="ghost" size="icon-sm" aria-label={`${copy.editProfessional}: ${r.name}`} disabled={disabled} onClick={() => setResource(r)}>
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label={`${copy.remove}: ${r.name}`} disabled={disabled} onClick={() => void remove(`/api/agenda/resources/${r.id}`)}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </SettingsGroup>

      {service && (
        <ServiceDialog
          initial={service}
          copy={copy}
          onClose={() => setService(null)}
          onSaved={async () => {
            setService(null);
            await reload();
          }}
        />
      )}
      {resource && (
        <ResourceDialog
          initial={resource}
          config={config}
          copy={copy}
          onClose={() => setResource(null)}
          onSaved={async () => {
            setResource(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}

function RulesGroup({ settings, copy, disabled, onSaved }: { settings: AgendaSettings; copy: AgendaCopy; disabled: boolean; onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useState(settings);
  const [busy, setBusy] = useState(false);
  const num = (key: keyof AgendaSettings) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setDraft((d) => ({ ...d, [key]: Number(e.target.value) }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await agendaFetch('/api/agenda/settings', { method: 'PUT', body: JSON.stringify(draft) });
      toast.success(copy.saved);
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : copy.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsGroup title={copy.rules} description={copy.rulesHint}>
      <form onSubmit={save} className="grid gap-4 sm:grid-cols-3">
        <Field label={`${copy.minNotice} (${copy.minutes})`}>
          {(id) => <Input id={id} type="number" min={0} max={43200} step={15} value={draft.min_notice_minutes} onChange={num('min_notice_minutes')} disabled={disabled} />}
        </Field>
        <Field label={`${copy.maxDaysAhead} (${copy.days})`}>
          {(id) => <Input id={id} type="number" min={1} max={365} value={draft.max_days_ahead} onChange={num('max_days_ahead')} disabled={disabled} />}
        </Field>
        <Field label={`${copy.slotStep} (${copy.minutes})`}>
          {(id) => (
            <select id={id} className={FIELD} value={draft.slot_step_minutes} onChange={num('slot_step_minutes')} disabled={disabled}>
              {SLOT_STEP_OPTIONS.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          )}
        </Field>
        <div className="sm:col-span-3">
          <Button type="submit" size="sm" disabled={disabled || busy}>{copy.save}</Button>
        </div>
      </form>
    </SettingsGroup>
  );
}

function ServiceDialog({ initial, copy, onClose, onSaved }: { initial: Partial<AgendaService>; copy: AgendaCopy; onClose: () => void; onSaved: () => Promise<void> }) {
  const { language } = useLanguage();
  const [name, setName] = useState(initial.name ?? '');
  const [duration, setDuration] = useState(String(initial.duration_minutes ?? 30));
  const [price, setPrice] = useState(initial.price_cents != null ? formatPrice(initial.price_cents, language) : '');
  const [before, setBefore] = useState(String(initial.buffer_before_minutes ?? 0));
  const [after, setAfter] = useState(String(initial.buffer_after_minutes ?? 0));
  const [active, setActive] = useState(initial.is_active ?? true);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const body = {
        name: name.trim(),
        duration_minutes: Number(duration),
        price_cents: parsePriceToCents(price),
        buffer_before_minutes: Number(before),
        buffer_after_minutes: Number(after),
        is_active: active,
      };
      await agendaFetch(initial.id ? `/api/agenda/services/${initial.id}` : '/api/agenda/services', {
        method: initial.id ? 'PATCH' : 'POST',
        body: JSON.stringify(body),
      });
      toast.success(copy.saved);
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : copy.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{initial.id ? copy.editService : copy.newService}</DialogTitle>
          <DialogDescription className="sr-only">{copy.servicesHint}</DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="grid gap-3">
          <Field label={copy.name}>{(id) => <Input id={id} value={name} maxLength={120} required onChange={(e) => setName(e.target.value)} data-no-translate />}</Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={copy.duration}>{(id) => <Input id={id} type="number" min={5} max={1440} step={5} required value={duration} onChange={(e) => setDuration(e.target.value)} />}</Field>
            <Field label={copy.price}>{(id) => <Input id={id} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />}</Field>
            <Field label={copy.bufferBefore}>{(id) => <Input id={id} type="number" min={0} max={240} step={5} value={before} onChange={(e) => setBefore(e.target.value)} />}</Field>
            <Field label={copy.bufferAfter}>{(id) => <Input id={id} type="number" min={0} max={240} step={5} value={after} onChange={(e) => setAfter(e.target.value)} />}</Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-primary" checked={active} onChange={(e) => setActive(e.target.checked)} />
            {copy.active}
          </label>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>{copy.cancel}</Button>
            <Button type="submit" disabled={busy || !name.trim()}>{copy.save}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ResourceDialog({ initial, config, copy, onClose, onSaved }: { initial: Partial<AgendaResource>; config: AgendaConfig; copy: AgendaCopy; onClose: () => void; onSaved: () => Promise<void> }) {
  const { language } = useLanguage();
  const lang = language === 'en-US' ? 'en-US' : 'pt-BR';
  const { members } = useCalendarMembers();
  const [name, setName] = useState(initial.name ?? '');
  const [kind, setKind] = useState(initial.kind ?? 'professional');
  const [userId, setUserId] = useState(initial.user_id ?? '');
  const [active, setActive] = useState(initial.is_active ?? true);
  const [serviceIds, setServiceIds] = useState<string[]>(
    initial.id ? config.resource_services.filter((l) => l.resource_id === initial.id).map((l) => l.service_id) : [],
  );
  const [week, setWeek] = useState<WeeklyDraft>(() =>
    initial.id ? weekFromRows(config.working_hours.filter((h) => h.resource_id === initial.id)) : defaultWeek(),
  );
  const [exceptions, setExceptions] = useState<Pick<DayException, 'on_date' | 'kind' | 'start_minute' | 'end_minute' | 'note'>[]>(
    initial.id ? config.exceptions.filter((e) => e.resource_id === initial.id).map(({ on_date, kind, start_minute, end_minute, note }) => ({ on_date, kind, start_minute, end_minute, note: note ?? null })) : [],
  );
  const [busy, setBusy] = useState(false);
  const [weekError, setWeekError] = useState<string | null>(null);

  function updateRange(day: number, i: number, field: 'start' | 'end', value: string) {
    setWeek((w) => ({ ...w, [day]: w[day].map((r, idx) => (idx === i ? { ...r, [field]: value } : r)) }));
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const parsed = weekToRows(week);
    if (parsed.error) {
      setWeekError(`${WEEKDAY_NAMES[lang][parsed.weekday ?? 0]}: ${copy.weekErrors[parsed.error]}`);
      return;
    }
    setWeekError(null);
    setBusy(true);
    try {
      const body = {
        name: name.trim(),
        kind,
        user_id: userId || null,
        is_active: active,
        service_ids: serviceIds,
        hours: parsed.rows,
        exceptions,
      };
      await agendaFetch(initial.id ? `/api/agenda/resources/${initial.id}` : '/api/agenda/resources', {
        method: initial.id ? 'PATCH' : 'POST',
        body: JSON.stringify(body),
      });
      toast.success(copy.saved);
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : copy.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{initial.id ? copy.editProfessional : copy.newProfessional}</DialogTitle>
          <DialogDescription className="sr-only">{copy.professionalsHint}</DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="grid gap-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={copy.name}>{(id) => <Input id={id} value={name} maxLength={120} required onChange={(e) => setName(e.target.value)} data-no-translate />}</Field>
            <Field label={copy.kind}>
              {(id) => (
                <select id={id} className={FIELD} value={kind} onChange={(e) => setKind(e.target.value as AgendaResource['kind'])}>
                  {Object.entries(copy.kinds).map(([k, label]) => (
                    <option key={k} value={k}>{label}</option>
                  ))}
                </select>
              )}
            </Field>
            <Field label={copy.linkedMember}>
              {(id) => (
                <select id={id} className={FIELD} value={userId} onChange={(e) => setUserId(e.target.value)}>
                  <option value="">{copy.noMember}</option>
                  {members.map((m) => (
                    <option key={m.user_id} value={m.user_id}>{m.full_name?.trim() || m.email}</option>
                  ))}
                </select>
              )}
            </Field>
            <label className="flex items-center gap-2 self-end pb-2 text-sm">
              <input type="checkbox" className="size-4 accent-primary" checked={active} onChange={(e) => setActive(e.target.checked)} />
              {copy.active}
            </label>
          </div>

          <fieldset className="grid gap-2">
            <legend className="mb-1 text-xs font-medium text-muted-foreground">{copy.offeredServices}</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {config.services.map((s) => (
                <label key={s.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={serviceIds.includes(s.id)}
                    onChange={(e) => setServiceIds((ids) => (e.target.checked ? [...ids, s.id] : ids.filter((x) => x !== s.id)))}
                  />
                  <span data-no-translate>{s.name}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="grid gap-2">
            <legend className="mb-1 text-xs font-medium text-muted-foreground">{copy.weeklyHours}</legend>
            {WEEKDAY_ORDER.map((day) => (
              <div key={day} className="grid grid-cols-[6rem_1fr] items-start gap-2">
                <span className="pt-1.5 text-sm text-foreground">{WEEKDAY_NAMES[lang][day]}</span>
                <div className="grid gap-1.5">
                  {week[day].length === 0 && <span className="pt-1.5 text-xs text-muted-foreground">{copy.closed}</span>}
                  {week[day].map((r, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <Input aria-label={`${WEEKDAY_NAMES[lang][day]} ${copy.start}`} type="time" className="h-8 w-28" value={r.start} onChange={(e) => updateRange(day, i, 'start', e.target.value)} />
                      <span aria-hidden="true">–</span>
                      <Input aria-label={`${WEEKDAY_NAMES[lang][day]} ${copy.end}`} type="time" className="h-8 w-28" value={r.end} onChange={(e) => updateRange(day, i, 'end', e.target.value)} />
                      <Button type="button" variant="ghost" size="icon-sm" aria-label={`${copy.removeInterval} (${WEEKDAY_NAMES[lang][day]} ${summarizeDay([r])})`} onClick={() => setWeek((w) => ({ ...w, [day]: w[day].filter((_, idx) => idx !== i) }))}>
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  ))}
                  <div>
                    <Button type="button" variant="ghost" size="xs" onClick={() => setWeek((w) => ({ ...w, [day]: [...w[day], { start: w[day].length ? w[day][w[day].length - 1].end : '09:00', end: '18:00' }] }))}>
                      <Plus className="size-3" /> {copy.addInterval}
                    </Button>
                  </div>
                </div>
              </div>
            ))}
            {weekError && <p role="alert" className="text-xs text-destructive">{weekError}</p>}
          </fieldset>

          <fieldset className="grid gap-2">
            <legend className="mb-1 text-xs font-medium text-muted-foreground">{copy.exceptions}</legend>
            <p className="text-xs text-muted-foreground">{copy.exceptionsHint}</p>
            {exceptions.map((ex, i) => (
              <div key={i} className="flex flex-wrap items-center gap-1.5">
                <Input aria-label={copy.date} type="date" required className="h-8 w-40" value={ex.on_date} onChange={(e) => setExceptions((l) => l.map((x, idx) => (idx === i ? { ...x, on_date: e.target.value } : x)))} />
                <select aria-label={copy.kind} className={`${FIELD} h-8 w-44`} value={ex.kind} onChange={(e) => setExceptions((l) => l.map((x, idx) => (idx === i ? (e.target.value === 'day_off' ? { ...x, kind: 'day_off', start_minute: null, end_minute: null } : { ...x, kind: 'extra_hours', start_minute: 540, end_minute: 720 }) : x)))}>
                  <option value="day_off">{copy.dayOff}</option>
                  <option value="extra_hours">{copy.extraHours}</option>
                </select>
                {ex.kind === 'extra_hours' && (
                  <>
                    <Input aria-label={copy.start} type="time" className="h-8 w-28" value={minutesValue(ex.start_minute)} onChange={(e) => setExceptions((l) => l.map((x, idx) => (idx === i ? { ...x, start_minute: toMinutes(e.target.value) } : x)))} />
                    <span aria-hidden="true">–</span>
                    <Input aria-label={copy.end} type="time" className="h-8 w-28" value={minutesValue(ex.end_minute)} onChange={(e) => setExceptions((l) => l.map((x, idx) => (idx === i ? { ...x, end_minute: toMinutes(e.target.value) } : x)))} />
                  </>
                )}
                <Button type="button" variant="ghost" size="icon-sm" aria-label={`${copy.remove} ${ex.on_date}`} onClick={() => setExceptions((l) => l.filter((_, idx) => idx !== i))}>
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
            <div>
              <Button type="button" variant="ghost" size="xs" onClick={() => setExceptions((l) => [...l, { on_date: '', kind: 'day_off', start_minute: null, end_minute: null, note: null }])}>
                <Plus className="size-3" /> {copy.addException}
              </Button>
            </div>
          </fieldset>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>{copy.cancel}</Button>
            <Button type="submit" disabled={busy || !name.trim()}>{copy.save}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function defaultWeek(): WeeklyDraft {
  const w = emptyWeek();
  for (const d of [1, 2, 3, 4, 5]) w[d] = [{ start: '09:00', end: '18:00' }];
  return w;
}

function minutesValue(m: number | null): string {
  if (m === null) return '';
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function toMinutes(v: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(v);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
