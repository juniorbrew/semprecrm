// ============================================================
// Booking service — the ONE entry point for creating, moving and closing
// appointments. The agenda UI calls it through /api/agenda/*; the AI on
// WhatsApp (delivery C) calls it directly with a service-role client and
// `source: 'ai'`.
//
//   getAvailability   free slots (pure core + busy time from the DB)
//   bookAppointment   re-validates the rules, then books through the
//                     `agenda_book_appointment` RPC, which locks the resource
//                     and lets the exclusion constraint decide races
//   rescheduleAppointment / setAppointmentStatus   same pattern
//
// Callers: the routes pass the user's RLS client as `db` (reads) and the
// service-role client as `writer` (the RPCs are service_role-only). The AI /
// jobs have no user session: pass the SERVICE-ROLE client as both `db` and
// `writer` and set `actorId` to a real agent+ member of the account.
//
// Race safety does not depend on this file: the TS checks only produce a
// precise error message; the database constraint is the guarantee.
// ============================================================

import type { CalendarEvent } from '@/lib/calendar/types';

import { shiftDate } from './ui';

import {
  computeSlots,
  datesBetween,
  explainStart,
  isDateString,
  localDate,
  MAX_RANGE_DAYS,
  type AvailabilityInput,
} from './availability';
import { loadBusy, loadConfig, requireService, resourcesForService, toSchedules, type AgendaDb } from './data';
import { AgendaError, fromRpcError, fromUnavailableReason } from './errors';
import type { AgendaConfig, AgendaResource, AgendaService, AppointmentStatus, BookingSource, Slot } from './types';

const DAY_MS = 86_400_000;

/** Where the booking RPCs run: the server's service-role client (reads use the caller's RLS client). */
export type RpcWriter = Pick<AgendaDb, 'rpc'>;

/** Encaixe: a start up to this long ago still counts (a walk-in whose slot began minutes ago). */
export const ENCAIXE_PAST_GRACE_MINUTES = 60;
const ENCAIXE_MAX_DAYS_AHEAD = 3650;

/**
 * Encaixe (walk-in / override, owner decision 2026-10-25): minimum notice and the
 * max-days-ahead limit are ignored; working hours, exceptions and conflicts still
 * apply. Only a person (source 'agent') may ask for it: the AI and the public API
 * get a 'forbidden' error, so delivery C cannot reach it even by mistake.
 */
export function allowEncaixe(encaixe: boolean | undefined, source: BookingSource | undefined): boolean {
  if (!encaixe) return false;
  if (source !== 'agent') throw new AgendaError('forbidden', 'Encaixe é exclusivo de atendentes.');
  return true;
}

function inputFor(
  config: AgendaConfig,
  service: AgendaService,
  now: Date,
  resources: AgendaResource[],
  busy: Parameters<typeof toSchedules>[2],
  encaixe = false,
): AvailabilityInput {
  return {
    tz: config.timezone,
    now: encaixe ? new Date(now.getTime() - ENCAIXE_PAST_GRACE_MINUTES * 60_000) : now,
    service,
    resources: toSchedules(config, resources, busy),
    rules: encaixe
      ? { ...config.settings, min_notice_minutes: 0, max_days_ahead: ENCAIXE_MAX_DAYS_AHEAD }
      : config.settings,
  };
}

/** The candidates for a request: one named resource, or every active resource that performs the service. */
function candidatesFor(config: AgendaConfig, serviceId: string, resourceId: string | null | undefined): AgendaResource[] {
  const offered = resourcesForService(config, serviceId);
  if (!resourceId) return offered;
  const named = config.resources.find((r) => r.id === resourceId);
  if (!named) throw new AgendaError('not_found', 'Profissional não encontrado.');
  if (!named.is_active) throw new AgendaError('resource_unavailable');
  if (!offered.some((r) => r.id === resourceId)) throw new AgendaError('service_not_offered');
  return [named];
}

// ------------------------------------------------------------
// Availability
// ------------------------------------------------------------

export interface AvailabilityQuery {
  accountId: string;
  serviceId: string;
  /** Omit for "any professional". */
  resourceId?: string | null;
  /** Local dates "YYYY-MM-DD", inclusive. */
  from: string;
  to: string;
  now?: Date;
  /** Encaixe slots (ignore notice and horizon). Needs source 'agent'. */
  encaixe?: boolean;
  source?: BookingSource;
}

export interface AvailabilityResult {
  timezone: string;
  slots: Slot[];
}

export async function getAvailability(db: AgendaDb, q: AvailabilityQuery): Promise<AvailabilityResult> {
  if (!isDateString(q.from) || !isDateString(q.to) || q.to < q.from) {
    throw new AgendaError('validation', 'Período inválido.');
  }
  const encaixe = allowEncaixe(q.encaixe, q.source);
  const dates = datesBetween(q.from, q.to);
  if (dates.length > MAX_RANGE_DAYS || Date.parse(q.to) - Date.parse(q.from) > (MAX_RANGE_DAYS - 1) * DAY_MS) {
    throw new AgendaError('validation', `Consulte no máximo ${MAX_RANGE_DAYS} dias por vez.`);
  }
  const config = await loadConfig(db, q.accountId, { from: dates[0], to: dates[dates.length - 1] });
  const service = requireService(config, q.serviceId);
  const candidates = candidatesFor(config, q.serviceId, q.resourceId);
  if (candidates.length === 0) return { timezone: config.timezone, slots: [] };

  const now = q.now ?? new Date();
  // Local dates -> a UTC window wide enough for any offset (±14h); the busy loader adds the buffers.
  const from = new Date(Date.parse(`${dates[0]}T00:00:00Z`) - 14 * 3_600_000);
  const to = new Date(Date.parse(`${dates[dates.length - 1]}T00:00:00Z`) + DAY_MS + 14 * 3_600_000);
  const busy = await loadBusy(db, q.accountId, candidates, from, to);
  return {
    timezone: config.timezone,
    slots: computeSlots(inputFor(config, service, now, candidates, busy, encaixe), dates),
  };
}

export interface ServiceAvailability {
  service: AgendaService;
  resources: AgendaResource[];
  slots: Slot[];
}

/**
 * Free slots of every active service at once (the AI's offer): one config
 * read and one busy read for all the resources, instead of one per service.
 */
export async function getAvailabilityForServices(
  db: AgendaDb,
  q: { accountId: string; from: string; to: string; now?: Date },
): Promise<{ timezone: string; services: ServiceAvailability[] }> {
  if (!isDateString(q.from) || !isDateString(q.to) || q.to < q.from) throw new AgendaError('validation', 'Período inválido.');
  const dates = datesBetween(q.from, q.to);
  if (dates.length > MAX_RANGE_DAYS) throw new AgendaError('validation', `Consulte no máximo ${MAX_RANGE_DAYS} dias por vez.`);
  const config = await loadConfig(db, q.accountId, { from: dates[0], to: dates[dates.length - 1] });
  const offered = config.services
    .filter((s) => s.is_active)
    .map((service) => ({ service, resources: resourcesForService(config, service.id) }))
    .filter((x) => x.resources.length > 0);
  if (offered.length === 0) return { timezone: config.timezone, services: [] };

  const all = [...new Map(offered.flatMap((x) => x.resources).map((r) => [r.id, r])).values()];
  const from = new Date(Date.parse(`${dates[0]}T00:00:00Z`) - 14 * 3_600_000);
  const to = new Date(Date.parse(`${dates[dates.length - 1]}T00:00:00Z`) + DAY_MS + 14 * 3_600_000);
  const busy = await loadBusy(db, q.accountId, all, from, to);
  const now = q.now ?? new Date();
  return {
    timezone: config.timezone,
    services: offered.map(({ service, resources }) => ({
      service,
      resources,
      slots: computeSlots(inputFor(config, service, now, resources, busy), dates),
    })),
  };
}

// ------------------------------------------------------------
// Booking
// ------------------------------------------------------------

export interface BookInput {
  accountId: string;
  /** Who is acting. Required for service-role callers (the AI); ignored for user sessions (auth.uid() wins). */
  actorId?: string | null;
  serviceId: string;
  /** null / omitted = any professional that is free. */
  resourceId?: string | null;
  contactId: string;
  conversationId?: string | null;
  startsAt: string;
  notes?: string | null;
  source?: BookingSource;
  status?: Extract<AppointmentStatus, 'scheduled' | 'confirmed'>;
  /** Same key = same appointment (retries, double clicks, webhook replays). */
  idempotencyKey?: string | null;
  /** Encaixe: ignore minimum notice and the day horizon (hours and conflicts still apply). Only source 'agent'. */
  encaixe?: boolean;
  now?: Date;
}

/** Exceptions only matter around the requested start (±1 day covers any zone offset). */
function exceptionWindow(startMs: number): { from: string; to: string } {
  const day = new Date(startMs).toISOString().slice(0, 10);
  return { from: shiftDate(day, -1), to: shiftDate(day, 1) };
}

function parseStart(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new AgendaError('validation', 'Horário inválido.');
  return ms;
}

async function rpcEvent(
  db: RpcWriter,
  fn: string,
  args: Record<string, unknown>,
): Promise<CalendarEvent> {
  const res = await db.rpc(fn, args);
  if (res.error) throw fromRpcError(res.error);
  if (!res.data) throw new AgendaError('internal');
  return res.data as CalendarEvent;
}

export async function bookAppointment(db: AgendaDb, input: BookInput, writer: RpcWriter = db): Promise<CalendarEvent> {
  const startMs = parseStart(input.startsAt);
  const source = input.source ?? 'agent';
  const encaixe = allowEncaixe(input.encaixe, source);

  // A retry with the same key returns the original even though its own slot is now busy.
  if (input.idempotencyKey) {
    const prior = await db
      .from('calendar_events')
      .select('*')
      .eq('account_id', input.accountId)
      .eq('idempotency_key', input.idempotencyKey)
      .maybeSingle();
    if (prior.error) throw fromRpcError(prior.error);
    if (prior.data) {
      const p = prior.data as CalendarEvent;
      if (p.service_id !== input.serviceId || p.contact_id !== input.contactId || Date.parse(p.starts_at) !== startMs) {
        throw new AgendaError('idempotency_conflict');
      }
      return p;
    }
  }

  const config = await loadConfig(db, input.accountId, exceptionWindow(startMs));
  const service = requireService(config, input.serviceId);
  const candidates = candidatesFor(config, input.serviceId, input.resourceId);
  if (candidates.length === 0) throw new AgendaError('resource_unavailable', 'Nenhum profissional realiza esse serviço.');

  const now = input.now ?? new Date();
  const around = new Date(startMs);
  const busy = await loadBusy(db, input.accountId, candidates, around, new Date(startMs + service.duration_minutes * 60_000));
  const availability = inputFor(config, service, now, candidates, busy, encaixe);

  let lastError: AgendaError | null = null;
  for (const schedule of availability.resources) {
    const reason = explainStart(availability, schedule, startMs);
    if (reason) {
      lastError = pickError(lastError, fromUnavailableReason(reason));
      continue;
    }
    try {
      return await rpcEvent(writer, 'agenda_book_appointment', {
        p_account_id: input.accountId,
        p_service_id: input.serviceId,
        p_resource_id: schedule.id,
        p_contact_id: input.contactId,
        p_starts_at: new Date(startMs).toISOString(),
        p_conversation_id: input.conversationId ?? null,
        p_source: source,
        p_notes: input.notes ?? null,
        p_idempotency_key: input.idempotencyKey ?? null,
        p_status: input.status ?? 'scheduled',
        p_actor: input.actorId ?? null,
        p_override: encaixe,
      });
    } catch (err) {
      // Lost the race (or the member got busy in between): try the next professional.
      if (err instanceof AgendaError && (err.code === 'slot_taken' || err.code === 'busy' || err.code === 'resource_unavailable')) {
        lastError = pickError(lastError, err);
        continue;
      }
      throw err;
    }
  }
  throw lastError ?? new AgendaError('slot_taken');
}

/** Prefer the most informative reason when several professionals were tried. */
const RANK: Record<string, number> = { slot_taken: 5, busy: 4, outside_hours: 3, min_notice: 2, max_ahead: 1 };
function pickError(current: AgendaError | null, next: AgendaError): AgendaError {
  if (!current) return next;
  return (RANK[next.code] ?? 0) > (RANK[current.code] ?? 0) ? next : current;
}

// ------------------------------------------------------------
// Reschedule / status
// ------------------------------------------------------------

export interface RescheduleInput {
  accountId: string;
  eventId: string;
  startsAt: string;
  /** Move to another professional too (optional). */
  resourceId?: string | null;
  /** Encaixe: ignore minimum notice and the day horizon. Needs source 'agent' (explicit) and an actor. */
  encaixe?: boolean;
  source?: BookingSource;
  /** The person moving it (agent+). Required for an encaixe; the RPC checks the membership. */
  actorId?: string | null;
  now?: Date;
}

export async function rescheduleAppointment(db: AgendaDb, input: RescheduleInput, writer: RpcWriter = db): Promise<CalendarEvent> {
  const encaixe = allowEncaixe(input.encaixe, input.source);
  if (encaixe && !input.actorId) throw new AgendaError('forbidden', 'Encaixe é exclusivo de atendentes.');
  const startMs = parseStart(input.startsAt);
  const found = await db
    .from('calendar_events')
    .select('id, service_id, resource_id, status, starts_at, ends_at')
    .eq('account_id', input.accountId)
    .eq('id', input.eventId)
    .maybeSingle();
  if (found.error) throw fromRpcError(found.error);
  const ev = found.data as { service_id: string | null; resource_id: string | null; status: string } | null;
  if (!ev || !ev.service_id || !ev.resource_id) throw new AgendaError('not_found', 'Agendamento não encontrado.');
  if (ev.status !== 'scheduled' && ev.status !== 'confirmed') throw new AgendaError('not_reschedulable');

  const config = await loadConfig(db, input.accountId, exceptionWindow(startMs));
  const service = config.services.find((s) => s.id === ev.service_id);
  if (!service) throw new AgendaError('not_found', 'Serviço não encontrado.');
  const targetId = input.resourceId ?? ev.resource_id;
  const candidates = candidatesFor(config, service.id, targetId);

  const busy = await loadBusy(
    db,
    input.accountId,
    candidates,
    new Date(startMs),
    new Date(startMs + service.duration_minutes * 60_000),
    input.eventId,
  );
  const availability = inputFor(config, service, input.now ?? new Date(), candidates, busy, encaixe);
  const reason = explainStart(availability, availability.resources[0], startMs);
  if (reason) throw fromUnavailableReason(reason);

  return rpcEvent(writer, 'agenda_reschedule_appointment', {
    p_account_id: input.accountId,
    p_event_id: input.eventId,
    p_starts_at: new Date(startMs).toISOString(),
    p_resource_id: input.resourceId ?? null,
    p_override: encaixe,
    p_source: input.source ?? 'agent',
    p_actor: input.actorId ?? null,
  });
}

export async function setAppointmentStatus(
  db: AgendaDb,
  input: { accountId: string; eventId: string; status: AppointmentStatus; now?: Date },
  writer: RpcWriter = db,
): Promise<CalendarEvent> {
  // Reopening a closed appointment takes its time back: hours, notice and horizon apply again.
  if (input.status === 'scheduled' || input.status === 'confirmed') {
    const ev = await getAppointment(db, input.accountId, input.eventId);
    if (ev && (ev.status === 'cancelled' || ev.status === 'no_show') && ev.service_id && ev.resource_id) {
      const startMs = Date.parse(ev.starts_at);
      const config = await loadConfig(db, input.accountId, exceptionWindow(startMs));
      const service = config.services.find((s) => s.id === ev.service_id);
      const resource = config.resources.find((r) => r.id === ev.resource_id);
      if (!service || !resource) throw new AgendaError('not_found');
      if (!resource.is_active) throw new AgendaError('resource_unavailable');
      const busy = await loadBusy(db, input.accountId, [resource], new Date(startMs), new Date(Date.parse(ev.ends_at)), ev.id);
      const availability = inputFor(config, service, input.now ?? new Date(), [resource], busy);
      const reason = explainStart(availability, availability.resources[0], startMs);
      if (reason) throw fromUnavailableReason(reason);
    }
  }
  return rpcEvent(writer, 'agenda_set_appointment_status', {
    p_account_id: input.accountId,
    p_event_id: input.eventId,
    p_status: input.status,
  });
}

/** One appointment of the account (a calendar event with a service), or null. */
export async function getAppointment(db: AgendaDb, accountId: string, eventId: string): Promise<CalendarEvent | null> {
  const res = await db
    .from('calendar_events')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', eventId)
    .not('service_id', 'is', null)
    .maybeSingle();
  if (res.error) throw fromRpcError(res.error);
  return (res.data as CalendarEvent | null) ?? null;
}

/** A contact's upcoming open appointments (scheduled / confirmed), soonest first. */
export async function listUpcomingForContact(
  db: AgendaDb,
  input: { accountId: string; contactId: string; now?: Date; limit?: number },
): Promise<CalendarEvent[]> {
  const res = await db
    .from('calendar_events')
    .select('*')
    .eq('account_id', input.accountId)
    .eq('contact_id', input.contactId)
    .not('service_id', 'is', null)
    .in('status', ['scheduled', 'confirmed'])
    .gte('ends_at', (input.now ?? new Date()).toISOString())
    .order('starts_at')
    .limit(input.limit ?? 20);
  if (res.error) throw fromRpcError(res.error);
  return (res.data ?? []) as CalendarEvent[];
}

/** Local date ("YYYY-MM-DD") of a start in the account zone — for the UI to jump to a day. */
export function appointmentLocalDate(startsAt: string, timezone: string): string {
  return localDate(new Date(startsAt), timezone);
}
