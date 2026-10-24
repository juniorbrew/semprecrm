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
// Race safety does not depend on this file: the TS checks only produce a
// precise error message; the database constraint is the guarantee.
// ============================================================

import type { CalendarEvent } from '@/lib/calendar/types';

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

function inputFor(config: AgendaConfig, service: AgendaService, now: Date, resources: AgendaResource[], busy: Parameters<typeof toSchedules>[2]): AvailabilityInput {
  return {
    tz: config.timezone,
    now,
    service,
    resources: toSchedules(config, resources, busy),
    rules: config.settings,
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
}

export interface AvailabilityResult {
  timezone: string;
  slots: Slot[];
}

export async function getAvailability(db: AgendaDb, q: AvailabilityQuery): Promise<AvailabilityResult> {
  if (!isDateString(q.from) || !isDateString(q.to) || q.to < q.from) {
    throw new AgendaError('validation', 'Período inválido.');
  }
  const dates = datesBetween(q.from, q.to);
  if (dates.length > MAX_RANGE_DAYS || Date.parse(q.to) - Date.parse(q.from) > (MAX_RANGE_DAYS - 1) * DAY_MS) {
    throw new AgendaError('validation', `Consulte no máximo ${MAX_RANGE_DAYS} dias por vez.`);
  }
  const config = await loadConfig(db, q.accountId);
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
    slots: computeSlots(inputFor(config, service, now, candidates, busy), dates),
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
  now?: Date;
}

function parseStart(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new AgendaError('validation', 'Horário inválido.');
  return ms;
}

async function rpcEvent(
  db: AgendaDb,
  fn: string,
  args: Record<string, unknown>,
): Promise<CalendarEvent> {
  const res = await db.rpc(fn, args);
  if (res.error) throw fromRpcError(res.error);
  if (!res.data) throw new AgendaError('internal');
  return res.data as CalendarEvent;
}

export async function bookAppointment(db: AgendaDb, input: BookInput): Promise<CalendarEvent> {
  const startMs = parseStart(input.startsAt);
  const source = input.source ?? 'agent';

  // A retry with the same key returns the original even though its own slot is now busy.
  if (input.idempotencyKey) {
    const prior = await db
      .from('calendar_events')
      .select('*')
      .eq('account_id', input.accountId)
      .eq('idempotency_key', input.idempotencyKey)
      .maybeSingle();
    if (prior.error) throw fromRpcError(prior.error);
    if (prior.data) return prior.data as CalendarEvent;
  }

  const config = await loadConfig(db, input.accountId);
  const service = requireService(config, input.serviceId);
  const candidates = candidatesFor(config, input.serviceId, input.resourceId);
  if (candidates.length === 0) throw new AgendaError('resource_unavailable', 'Nenhum profissional realiza esse serviço.');

  const now = input.now ?? new Date();
  const around = new Date(startMs);
  const busy = await loadBusy(db, input.accountId, candidates, around, new Date(startMs + service.duration_minutes * 60_000));
  const availability = inputFor(config, service, now, candidates, busy);

  let lastError: AgendaError | null = null;
  for (const schedule of availability.resources) {
    const reason = explainStart(availability, schedule, startMs);
    if (reason) {
      lastError = pickError(lastError, fromUnavailableReason(reason));
      continue;
    }
    try {
      return await rpcEvent(db, 'agenda_book_appointment', {
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
      });
    } catch (err) {
      // Lost the race (or the member got busy in between): try the next professional.
      if (err instanceof AgendaError && (err.code === 'slot_taken' || err.code === 'busy')) {
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
  now?: Date;
}

export async function rescheduleAppointment(db: AgendaDb, input: RescheduleInput): Promise<CalendarEvent> {
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

  const config = await loadConfig(db, input.accountId);
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
  const availability = inputFor(config, service, input.now ?? new Date(), candidates, busy);
  const reason = explainStart(availability, availability.resources[0], startMs);
  if (reason) throw fromUnavailableReason(reason);

  return rpcEvent(db, 'agenda_reschedule_appointment', {
    p_account_id: input.accountId,
    p_event_id: input.eventId,
    p_starts_at: new Date(startMs).toISOString(),
    p_resource_id: input.resourceId ?? null,
  });
}

export async function setAppointmentStatus(
  db: AgendaDb,
  input: { accountId: string; eventId: string; status: AppointmentStatus },
): Promise<CalendarEvent> {
  return rpcEvent(db, 'agenda_set_appointment_status', {
    p_account_id: input.accountId,
    p_event_id: input.eventId,
    p_status: input.status,
  });
}

/** Local date ("YYYY-MM-DD") of a start in the account zone — for the UI to jump to a day. */
export function appointmentLocalDate(startsAt: string, timezone: string): string {
  return localDate(new Date(startsAt), timezone);
}
