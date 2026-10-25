"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { CalendarCheck, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { useLanguage } from "@/hooks/use-language";
import { formatDateTime, formatTime, type CalendarContactRef, type CalendarEvent } from "@/lib/calendar";
import { localDate } from "@/lib/agenda/availability";
import { useCalendarTimezone } from "@/components/calendar/hooks";
import { ContactPicker } from "@/components/calendar/contact-picker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { AgendaConfig, AppointmentStatus, Slot } from "@/lib/agenda/types";
import {
  canReschedule,
  formatDuration,
  groupSlotsByDay,
  shiftDate,
  STATUS_LABELS,
  statusActions,
  todayIn,
} from "@/lib/agenda/ui";
import { cn } from "@/lib/utils";

import { agendaCopy } from "./copy";
import { agendaFetch, useAgendaConfig } from "./use-agenda-config";

const SELECT_CLASS =
  "h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60";

export interface AppointmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Existing appointment (a calendar event with service_id) = manage mode. */
  event?: CalendarEvent | null;
  /** Create mode: pre-filled customer / conversation (e.g. from the inbox). */
  contact?: CalendarContactRef | null;
  conversationId?: string | null;
  /** Called with the booked / moved / updated appointment. */
  onSaved?: (event: CalendarEvent) => void;
  readOnly?: boolean;
}

/** Day-by-day free-slot picker for one service (and one professional or "any"). */
function SlotPicker({
  serviceId,
  resourceId,
  tz,
  selected,
  onSelect,
  labelId,
  refreshKey = 0,
  initialDate,
}: {
  serviceId: string;
  resourceId: string;
  tz: string;
  selected: string | null;
  onSelect: (slot: Slot) => void;
  labelId: string;
  /** Bump to refetch (e.g. after a booking lost the race). */
  refreshKey?: number;
  /** First day shown (default: today). */
  initialDate?: string;
}) {
  const { language } = useLanguage();
  const copy = agendaCopy(language);
  const [date, setDate] = useState(() => initialDate ?? todayIn(tz));
  const [searching, setSearching] = useState(false);
  const [none, setNone] = useState(false);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dateId = useId();

  useEffect(() => {
    let cancelled = false;
    const q = new URLSearchParams({ service_id: serviceId, from: date, to: date });
    if (resourceId) q.set("resource_id", resourceId);
    agendaFetch<{ slots: Slot[] }>(`/api/agenda/availability?${q}`)
      .then((res) => {
        if (cancelled) return;
        setSlots(res.slots);
        setError(null);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setSlots([]);
        setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [serviceId, resourceId, date, refreshKey]);

  async function jumpToNextFreeDay() {
    setSearching(true);
    setNone(false);
    try {
      const q = new URLSearchParams({ service_id: serviceId, from: shiftDate(date, 1), to: shiftDate(date, 30) });
      if (resourceId) q.set("resource_id", resourceId);
      const res = await agendaFetch<{ slots: Slot[] }>(`/api/agenda/availability?${q}`);
      const next = groupSlotsByDay(res.slots, tz)[0];
      if (next) {
        setSlots(null);
        setDate(next.date);
      } else {
        setNone(true);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : copy.failed);
    } finally {
      setSearching(false);
    }
  }

  const day = useMemo(() => groupSlotsByDay(slots ?? [], tz)[0]?.slots ?? [], [slots, tz]);

  return (
    <div className="grid gap-2" role="group" aria-labelledby={labelId}>
      <div className="flex items-center gap-1.5">
        <Button type="button" variant="outline" size="icon-sm" aria-label={copy.prevDay} onClick={() => { setSlots(null); setDate((d) => shiftDate(d, -1)); }}>
          <ChevronLeft className="size-4" />
        </Button>
        <label htmlFor={dateId} className="sr-only">{copy.date}</label>
        <Input id={dateId} type="date" value={date} onChange={(e) => { if (e.target.value) { setSlots(null); setDate(e.target.value); } }} className="h-8 w-40" />
        <Button type="button" variant="outline" size="icon-sm" aria-label={copy.nextDay} onClick={() => { setSlots(null); setDate((d) => shiftDate(d, 1)); }}>
          <ChevronRight className="size-4" />
        </Button>
      </div>
      <div aria-live="polite" className="min-h-9">
        {slots === null ? (
          <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> {copy.loadingSlots}
          </p>
        ) : error ? (
          <p className="text-xs text-destructive">{error}</p>
        ) : day.length === 0 ? (
          <div className="grid gap-1.5">
            <p className="text-xs text-muted-foreground">{none ? copy.noFreeDay : copy.noSlots}</p>
            <div>
              <Button type="button" variant="outline" size="xs" disabled={searching} onClick={() => void jumpToNextFreeDay()}>
                {searching ? <Loader2 className="size-3 animate-spin" /> : null}
                {copy.nextFreeDay}
              </Button>
            </div>
          </div>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {day.map((slot) => (
              <li key={slot.starts_at}>
                <button
                  type="button"
                  aria-pressed={selected === slot.starts_at}
                  onClick={() => onSelect(slot)}
                  className={cn(
                    "h-8 rounded-md border px-2.5 text-xs font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    selected === slot.starts_at
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background text-foreground hover:bg-muted",
                  )}
                >
                  {formatTime(slot.starts_at, language, tz)}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}

function newKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

/**
 * Book (service -> professional or "any" -> free slot -> customer) or manage
 * (reschedule / confirm / cancel / done / no-show) an appointment. All writes
 * go through /api/agenda/appointments, which re-checks every rule.
 */
export function AppointmentDialog({ open, onOpenChange, event, contact, conversationId, onSaved, readOnly }: AppointmentDialogProps) {
  const { language } = useLanguage();
  const copy = agendaCopy(language);
  const tz = useCalendarTimezone();
  const { config, loading, error, reload } = useAgendaConfig(open);
  const manage = !!event?.service_id;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg" data-testid="appointment-dialog">
        <DialogHeader>
          <DialogTitle>{manage ? copy.appointment : copy.scheduleService}</DialogTitle>
          <DialogDescription data-no-translate>{manage ? event?.title : contact?.name || contact?.phone || copy.pickContact}</DialogDescription>
        </DialogHeader>
        {error && !config ? (
          <div className="grid gap-2 text-sm" role="alert">
            <p className="text-destructive">{copy.loadFailed}</p>
            <div>
              <Button type="button" variant="outline" size="sm" onClick={() => void reload()}>{copy.retry}</Button>
            </div>
          </div>
        ) : loading || !config ? (
          <p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {copy.loadingSlots}
          </p>
        ) : manage && event ? (
          <ManageBody config={config} tz={tz} event={event} readOnly={readOnly} onSaved={onSaved} onClose={() => onOpenChange(false)} />
        ) : (
          <BookBody
            config={config}
            tz={tz}
            contact={contact ?? null}
            conversationId={conversationId ?? null}
            readOnly={readOnly}
            onSaved={(ev) => {
              onSaved?.(ev);
              onOpenChange(false);
            }}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function BookBody({
  config,
  tz,
  contact: initialContact,
  conversationId,
  readOnly,
  onSaved,
  onClose,
}: {
  config: AgendaConfig;
  tz: string;
  contact: CalendarContactRef | null;
  conversationId: string | null;
  readOnly?: boolean;
  onSaved: (event: CalendarEvent) => void;
  onClose: () => void;
}) {
  const { language } = useLanguage();
  const copy = agendaCopy(language);
  const services = config.services.filter((s) => s.is_active);
  const [serviceId, setServiceId] = useState("");
  const [resourceId, setResourceId] = useState("");
  const [slot, setSlot] = useState<Slot | null>(null);
  const [contact, setContact] = useState<CalendarContactRef | null>(initialContact);
  const [notes, setNotes] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const key = useRef(newKey());
  const ids = { service: useId(), professional: useId(), when: useId(), notes: useId() };

  const resources = useMemo(() => {
    const offered = new Set(config.resource_services.filter((l) => l.service_id === serviceId).map((l) => l.resource_id));
    return config.resources.filter((r) => r.is_active && offered.has(r.id));
  }, [config, serviceId]);
  const service = services.find((s) => s.id === serviceId);

  // A new service / professional / time / customer is a different request: new idempotency key.
  useEffect(() => {
    key.current = newKey();
  }, [serviceId, resourceId, slot?.starts_at, contact?.id]);

  const submit = useCallback(async () => {
    if (!service || !slot || !contact) return;
    setBusy(true);
    try {
      const { appointment } = await agendaFetch<{ appointment: CalendarEvent }>("/api/agenda/appointments", {
        method: "POST",
        body: JSON.stringify({
          service_id: service.id,
          resource_id: resourceId || null,
          contact_id: contact.id,
          conversation_id: conversationId,
          starts_at: slot.starts_at,
          notes: notes.trim() || null,
          status: confirmed ? "confirmed" : "scheduled",
          idempotency_key: key.current,
        }),
      });
      toast.success(copy.booked);
      key.current = newKey();
      onSaved(appointment);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : copy.failed);
      setSlot(null);
      setRefreshKey((k) => k + 1);
    } finally {
      setBusy(false);
    }
  }, [service, slot, contact, resourceId, conversationId, notes, confirmed, copy, onSaved]);

  if (services.length === 0) {
    return (
      <div className="grid gap-1 text-sm">
        <p className="font-medium text-foreground">{copy.noServices}</p>
        <p className="text-muted-foreground">{copy.noServicesHint}</p>
      </div>
    );
  }

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="grid gap-1.5">
        <label htmlFor={ids.service} className="text-xs font-medium text-muted-foreground">{copy.service}</label>
        <select
          id={ids.service}
          value={serviceId}
          required
          className={SELECT_CLASS}
          onChange={(e) => {
            setServiceId(e.target.value);
            setResourceId("");
            setSlot(null);
          }}
        >
          <option value="">{copy.chooseService}</option>
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {formatDuration(s.duration_minutes)}
            </option>
          ))}
        </select>
      </div>

      {service && (
        <>
          <div className="grid gap-1.5">
            <label htmlFor={ids.professional} className="text-xs font-medium text-muted-foreground">{copy.professional}</label>
            <select
              id={ids.professional}
              value={resourceId}
              className={SELECT_CLASS}
              onChange={(e) => {
                setResourceId(e.target.value);
                setSlot(null);
              }}
            >
              <option value="">{copy.anyProfessional}</option>
              {resources.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>

          <div className="grid gap-1.5">
            <span id={ids.when} className="text-xs font-medium text-muted-foreground">{copy.time}</span>
            <SlotPicker
              serviceId={service.id}
              resourceId={resourceId}
              tz={tz}
              selected={slot?.starts_at ?? null}
              onSelect={setSlot}
              labelId={ids.when}
              refreshKey={refreshKey}
            />
          </div>

          <div className="grid gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">{copy.contact}</span>
            <ContactPicker contact={contact} onChange={setContact} />
          </div>

          <div className="grid gap-1.5">
            <label htmlFor={ids.notes} className="text-xs font-medium text-muted-foreground">{copy.notes}</label>
            <Textarea id={ids.notes} rows={2} maxLength={1000} value={notes} placeholder={copy.notesPlaceholder} onChange={(e) => setNotes(e.target.value)} />
          </div>

          <label className="flex items-center gap-2 text-sm text-foreground">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="size-4 accent-primary" />
            {copy.confirmNow}
          </label>
        </>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>{copy.cancel}</Button>
        <Button type="submit" disabled={busy || readOnly || !service || !slot || !contact}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <CalendarCheck className="size-4" />}
          {busy ? copy.booking : copy.book}
        </Button>
      </div>
    </form>
  );
}

function ManageBody({
  config,
  tz,
  event,
  readOnly,
  onSaved,
  onClose,
}: {
  config: AgendaConfig;
  tz: string;
  event: CalendarEvent;
  readOnly?: boolean;
  onSaved?: (event: CalendarEvent) => void;
  onClose: () => void;
}) {
  const { language } = useLanguage();
  const copy = agendaCopy(language);
  const [current, setCurrent] = useState(event);
  const [moving, setMoving] = useState(false);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [resourceId, setResourceId] = useState(event.resource_id ?? "");
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const whenId = useId();

  const service = config.services.find((s) => s.id === current.service_id);
  const resource = config.resources.find((r) => r.id === current.resource_id);
  const resources = config.resources.filter(
    (r) => r.is_active && config.resource_services.some((l) => l.resource_id === r.id && l.service_id === current.service_id),
  );

  async function patch(body: Record<string, unknown>, message: string) {
    setBusy(true);
    try {
      const { appointment } = await agendaFetch<{ appointment: CalendarEvent }>(`/api/agenda/appointments/${current.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      const merged = { ...current, ...appointment, contact: current.contact };
      setCurrent(merged);
      setMoving(false);
      setSlot(null);
      toast.success(message);
      onSaved?.(merged);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : copy.failed);
      setSlot(null);
      setRefreshKey((k) => k + 1);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">{copy.service}</dt>
        <dd className="text-foreground">{service ? `${service.name} · ${formatDuration(service.duration_minutes)}` : current.title}</dd>
        <dt className="text-muted-foreground">{copy.professional}</dt>
        <dd className="text-foreground" data-no-translate>{resource ? `${resource.name}${resource.is_active ? "" : ` (${copy.inactive})`}` : "—"}</dd>
        <dt className="text-muted-foreground">{copy.time}</dt>
        <dd className="text-foreground">{formatDateTime(current.starts_at, language, tz)}</dd>
        <dt className="text-muted-foreground">{copy.contact}</dt>
        <dd className="text-foreground" data-no-translate>{current.contact?.name ?? current.contact?.phone ?? "—"}</dd>
        <dt className="text-muted-foreground">{copy.status}</dt>
        <dd className="font-medium text-foreground">{STATUS_LABELS[language === "en-US" ? "en-US" : "pt-BR"][current.status as AppointmentStatus] ?? current.status}</dd>
      </dl>

      {!readOnly && (
        <div className="flex flex-wrap gap-2">
          {canReschedule(current.status) && (
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setMoving((v) => !v)} aria-expanded={moving}>
              {copy.reschedule}
            </Button>
          )}
          {statusActions(current.status).map((status) => (
            <Button
              key={status}
              type="button"
              size="sm"
              variant={status === "cancelled" ? "destructive" : "outline"}
              disabled={busy}
              onClick={() => void patch({ status }, copy.statusChanged)}
            >
              {copy.markAs[status]}
            </Button>
          ))}
        </div>
      )}

      {moving && service && (
        <div className="grid gap-3 rounded-lg border border-border p-3">
          <div className="grid gap-1.5">
            <label className="text-xs font-medium text-muted-foreground" htmlFor={`${whenId}-res`}>{copy.professional}</label>
            <select
              id={`${whenId}-res`}
              value={resourceId}
              className={SELECT_CLASS}
              onChange={(e) => {
                setResourceId(e.target.value);
                setSlot(null);
              }}
            >
              {resources.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>
          <span id={whenId} className="text-xs font-medium text-muted-foreground">{copy.time}</span>
          <SlotPicker serviceId={service.id} resourceId={resourceId} tz={tz} selected={slot?.starts_at ?? null} onSelect={setSlot} labelId={whenId} refreshKey={refreshKey} initialDate={maxDate(todayIn(tz), localDate(new Date(current.starts_at), tz))} />
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              disabled={busy || !slot}
              onClick={() =>
                void patch(
                  { starts_at: slot?.starts_at, ...(resourceId && resourceId !== current.resource_id ? { resource_id: resourceId } : {}) },
                  copy.moved,
                )
              }
            >
              {copy.rescheduleConfirm}
            </Button>
          </div>
        </div>
      )}

      <div className="flex justify-end">
        <Button type="button" variant="outline" onClick={onClose}>{copy.close}</Button>
      </div>
    </div>
  );
}
