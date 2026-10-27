// ============================================================
// Agenda for the AI agent (delivery C, skill `book_appointment`).
//
//   loadAgendaOffer   the free times the model may offer (prompt data)
//   bookForAi         books what the model chose, by NAME + local time,
//                     through bookAppointment with source 'ai': same rules
//                     as a person, no encaixe, and the DB constraint
//                     decides races.
//
// Callers pass the SERVICE-ROLE client (no user session); every read and
// the RPC are scoped to `accountId`.
// ============================================================

import type { AgendaOffer } from '@/lib/ai/skills';
import { SKILL_LIMITS } from '@/lib/ai/skills';
import type { BookResult } from '@/lib/ai/skills-exec';
import type { CalendarEvent } from '@/lib/calendar/types';

import { minuteToInstant } from './availability';
import { loadConfig, loadTimezone, resourcesForService, type AgendaDb } from './data';
import { isAgendaError } from './errors';
import { bookAppointment, getAvailabilityForServices } from './service';
import { groupSlotsByDay, shiftDate, timeToMinutes, todayIn } from './ui';

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim();

function hhmm(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

/** At most `n` items spread over the whole list (morning AND afternoon), in order. */
export function spread<T>(list: readonly T[], n: number): T[] {
  if (list.length <= n) return [...list];
  if (n <= 1) return list.slice(0, n);
  return Array.from({ length: n }, (_, i) => list[Math.round((i * (list.length - 1)) / (n - 1))]);
}

function dayLabel(date: string, tz: string): string {
  // Noon of that local date: safely inside the day whatever the offset.
  const at = minuteToInstant(date, 12 * 60, tz);
  return new Intl.DateTimeFormat('pt-BR', { timeZone: tz, weekday: 'short', day: '2-digit', month: '2-digit' }).format(at);
}

export async function loadAgendaOffer(db: AgendaDb, accountId: string, now: Date = new Date()): Promise<AgendaOffer> {
  const tz = await loadTimezone(db, accountId);
  const from = todayIn(tz, now);
  const { timezone, services } = await getAvailabilityForServices(db, {
    accountId,
    from,
    to: shiftDate(from, SKILL_LIMITS.agendaDaysAhead - 1),
    now,
  });
  return {
    timezone,
    services: services.slice(0, SKILL_LIMITS.agendaServicesMax).map(({ service, resources, slots }) => ({
      name: service.name,
      minutes: service.duration_minutes,
      professionals: resources.map((r) => r.name),
      days: groupSlotsByDay(slots, timezone)
        .slice(0, SKILL_LIMITS.agendaDaysMax)
        .map((d) => ({
          date: d.date,
          label: dayLabel(d.date, timezone),
          times: spread(d.slots, SKILL_LIMITS.agendaTimesPerDayMax).map((sl) => hhmm(sl.starts_at, timezone)),
        })),
    })),
  };
}

export interface AiBookInput {
  accountId: string;
  contactId: string;
  conversationId: string;
  /** Same key on a retried job = the same appointment, never a second one. */
  idempotencyKey: string;
  service: string;
  /** Local to the agenda's timezone, as offered. */
  date: string;
  time: string;
  professional: string | null;
  now?: Date;
}

const TAKEN = new Set(['slot_taken', 'busy']);
const UNAVAILABLE = new Set([
  'validation',
  'outside_hours',
  'min_notice',
  'max_ahead',
  'resource_unavailable',
  'service_not_offered',
  'service_unavailable',
]);

const ACTIVE = ['scheduled', 'confirmed'];

async function eventByKey(db: AgendaDb, accountId: string, key: string): Promise<CalendarEvent | null> {
  const res = await db.from('calendar_events').select('*').eq('account_id', accountId).eq('idempotency_key', key).maybeSingle();
  if (res.error) throw new Error(`agenda read failed: ${res.error.message}`);
  return (res.data as CalendarEvent | null) ?? null;
}

export async function bookForAi(db: AgendaDb, input: AiBookInput): Promise<BookResult> {
  // One booking per job: a retry whose model output changed (other time, other
  // position) gets the appointment already made, never a second one.
  const prior = await eventByKey(db, input.accountId, input.idempotencyKey);
  if (prior) {
    if (!ACTIVE.includes(prior.status as string)) return { ok: false, reason: 'unavailable' };
    const config = await loadConfig(db, input.accountId, { from: input.date, to: input.date });
    return {
      ok: true,
      service: config.services.find((s) => s.id === prior.service_id)?.name ?? input.service,
      professional: config.resources.find((r) => r.id === prior.resource_id)?.name ?? null,
      startsAt: prior.starts_at,
      timezone: config.timezone,
    };
  }

  // A customer (or a message written to steer the AI) cannot fill the agenda.
  const upcoming = await db
    .from('calendar_events')
    .select('id')
    .eq('account_id', input.accountId)
    .eq('contact_id', input.contactId)
    .in('status', ACTIVE)
    .gt('starts_at', (input.now ?? new Date()).toISOString())
    .limit(SKILL_LIMITS.agendaFutureMaxPerContact);
  if (upcoming.error) throw new Error(`agenda read failed: ${upcoming.error.message}`);
  if ((upcoming.data ?? []).length >= SKILL_LIMITS.agendaFutureMaxPerContact) return { ok: false, reason: 'limit' };

  const config = await loadConfig(db, input.accountId, { from: shiftDate(input.date, -1), to: shiftDate(input.date, 1) });
  const service = config.services.find((s) => s.is_active && fold(s.name) === fold(input.service));
  if (!service) return { ok: false, reason: 'no_service' };
  const offered = resourcesForService(config, service.id);
  let resourceId: string | null = null;
  if (input.professional) {
    const named = offered.find((r) => fold(r.name) === fold(input.professional as string));
    if (!named) return { ok: false, reason: 'no_professional' };
    resourceId = named.id;
  }
  const minute = timeToMinutes(input.time);
  if (minute === null) return { ok: false, reason: 'unavailable' };

  try {
    const event = await bookAppointment(
      db,
      {
        accountId: input.accountId,
        actorId: null,
        serviceId: service.id,
        resourceId,
        contactId: input.contactId,
        conversationId: input.conversationId,
        startsAt: minuteToInstant(input.date, minute, config.timezone).toISOString(),
        source: 'ai',
        idempotencyKey: input.idempotencyKey,
        now: input.now,
      },
      db,
    );
    const pro = config.resources.find((r) => r.id === event.resource_id);
    return { ok: true, service: service.name, professional: pro?.name ?? null, startsAt: event.starts_at, timezone: config.timezone };
  } catch (err) {
    if (isAgendaError(err) && TAKEN.has(err.code)) return { ok: false, reason: 'taken' };
    if (isAgendaError(err) && UNAVAILABLE.has(err.code)) return { ok: false, reason: 'unavailable' };
    throw err;
  }
}
