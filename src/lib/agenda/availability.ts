// ============================================================
// Availability — pure core (no I/O). Given a service, the resources that
// can perform it and their schedules, answer "which start times are free?"
// and "why is this start not bookable?" with the SAME rules.
//
// Time model: working hours are wall-clock minutes in the account timezone
// (`accounts.preferences.business_hours.timezone`); everything stored and
// returned is UTC ISO. Wall clock -> instant goes through `fromZonedParts`
// (DST-safe), so a day boundary is the zone midnight, not the UTC one.
//
// Rules, in order:
//   minimum notice  start >= now + min_notice_minutes
//   max days ahead  start < start of day(now) + (max_days_ahead + 1) days
//   working hours   [start, start + duration] inside ONE working interval of
//                   that local date (weekly hours + extra_hours, unless a
//                   day_off exception closes the day)
//   busy            [start - buffer_before, end + buffer_after] must not touch
//                   any busy interval (existing appointments' own blocks and
//                   the professional's other events); half-open overlap
// Slots are generated on a grid of `slot_step_minutes` anchored at midnight.
// ============================================================

import { addDaysIn, fromZonedParts, startOfDayIn, zonedParts } from '@/lib/calendar/range';

import type { AgendaSettings, DayException, Slot, WorkingInterval } from './types';

const MIN_MS = 60_000;
/** Longest range one call may scan (the UI asks for a week or a month). */
export const MAX_RANGE_DAYS = 62;

export interface ServiceTiming {
  duration_minutes: number;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
}

export interface BusyInterval {
  starts_at: string;
  ends_at: string;
}

export interface ResourceSchedule {
  id: string;
  hours: readonly WorkingInterval[];
  exceptions: readonly DayException[];
  busy: readonly BusyInterval[];
}

export interface AvailabilityInput {
  tz: string;
  now: Date;
  service: ServiceTiming;
  resources: readonly ResourceSchedule[];
  rules: AgendaSettings;
}

export type UnavailableReason = 'min_notice' | 'max_ahead' | 'outside_hours' | 'busy';

interface MinuteRange {
  start: number;
  end: number;
}

// ------------------------------------------------------------
// Dates
// ------------------------------------------------------------

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDateString(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function parseDate(date: string): { year: number; month: number; day: number } {
  const m = DATE_RE.exec(date);
  if (!m) throw new RangeError(`Invalid date: ${date}`);
  return { year: +m[1], month: +m[2], day: +m[3] };
}

/** 0 = Sunday … 6 = Saturday of a calendar date (zone independent). */
export function weekdayOf(date: string): number {
  const { year, month, day } = parseDate(date);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Inclusive list of "YYYY-MM-DD" between `from` and `to` (capped at MAX_RANGE_DAYS). */
export function datesBetween(from: string, to: string): string[] {
  const a = parseDate(from);
  const b = parseDate(to);
  const start = Date.UTC(a.year, a.month - 1, a.day);
  const end = Date.UTC(b.year, b.month - 1, b.day);
  const out: string[] = [];
  for (let t = start; t <= end && out.length < MAX_RANGE_DAYS; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** The instant at which the zone shows `minute` (0–1440) on `date`. */
export function minuteToInstant(date: string, minute: number, tz: string): Date {
  const { year, month, day } = parseDate(date);
  return fromZonedParts({ year, month, day, hour: Math.floor(minute / 60), minute: minute % 60 }, tz);
}

/** "YYYY-MM-DD" of an instant in the zone. */
export function localDate(instant: Date | number, tz: string): string {
  const p = zonedParts(instant, tz);
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

// ------------------------------------------------------------
// Working intervals of one local date
// ------------------------------------------------------------

function mergeRanges(ranges: MinuteRange[]): MinuteRange[] {
  const sorted = ranges.filter((r) => r.end > r.start).sort((x, y) => x.start - y.start || x.end - y.end);
  const out: MinuteRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** Weekly hours + extra hours of `date`; a `day_off` closes the whole day. */
export function intervalsForDate(
  date: string,
  hours: readonly WorkingInterval[],
  exceptions: readonly DayException[],
): MinuteRange[] {
  const todays = exceptions.filter((e) => e.on_date === date);
  if (todays.some((e) => e.kind === 'day_off')) return [];
  const weekday = weekdayOf(date);
  const ranges: MinuteRange[] = hours
    .filter((h) => h.weekday === weekday)
    .map((h) => ({ start: h.start_minute, end: h.end_minute }));
  for (const e of todays) {
    if (e.kind === 'extra_hours' && e.start_minute !== null && e.end_minute !== null) {
      ranges.push({ start: e.start_minute, end: e.end_minute });
    }
  }
  return mergeRanges(ranges);
}

// ------------------------------------------------------------
// Rules
// ------------------------------------------------------------

function blockOf(startMs: number, svc: ServiceTiming): [number, number] {
  return [
    startMs - svc.buffer_before_minutes * MIN_MS,
    startMs + (svc.duration_minutes + svc.buffer_after_minutes) * MIN_MS,
  ];
}

const busyCache = new WeakMap<readonly BusyInterval[], [number, number][]>();

/** Busy intervals as epoch ms, parsed once per list (wide scans test thousands of starts). */
function parsedBusy(busy: readonly BusyInterval[]): [number, number][] {
  let out = busyCache.get(busy);
  if (!out) {
    out = busy.map((b) => [Date.parse(b.starts_at), Date.parse(b.ends_at)] as [number, number]);
    busyCache.set(busy, out);
  }
  return out;
}

function overlapsAny(from: number, to: number, busy: readonly BusyInterval[]): boolean {
  return parsedBusy(busy).some(([s, e]) => s < to && e > from);
}

interface Precomputed {
  /** First start that is too far ahead (ms). */
  horizon: number;
  /** Working intervals per local date, as epoch ms. */
  open: Map<string, [number, number][]>;
}

/** First start that is too far ahead (exclusive limit). */
export function horizonMs(now: Date, tz: string, maxDaysAhead: number): number {
  return addDaysIn(startOfDayIn(now, tz), maxDaysAhead + 1, tz).getTime();
}

/**
 * Why `startMs` cannot be booked for this resource, or null when it can.
 * Used by the booking service (so the error names the real reason) and,
 * through `computeSlots`, to build the free-slot list.
 */
export function explainStart(
  input: AvailabilityInput,
  resource: ResourceSchedule,
  startMs: number,
  pre?: Precomputed,
): UnavailableReason | null {
  const { tz, now, service, rules } = input;
  if (startMs < now.getTime() + rules.min_notice_minutes * MIN_MS) return 'min_notice';
  if (startMs >= (pre?.horizon ?? horizonMs(now, tz, rules.max_days_ahead))) return 'max_ahead';

  const date = localDate(startMs, tz);
  const endMs = startMs + service.duration_minutes * MIN_MS;
  const ranges =
    pre?.open.get(`${resource.id}|${date}`) ??
    intervalsForDate(date, resource.hours, resource.exceptions).map(
      (r) => [minuteToInstant(date, r.start, tz).getTime(), minuteToInstant(date, r.end, tz).getTime()] as [number, number],
    );
  const inside = ranges.some(([open, close]) => startMs >= open && endMs <= close);
  if (!inside) return 'outside_hours';

  const [from, to] = blockOf(startMs, service);
  if (overlapsAny(from, to, resource.busy)) return 'busy';
  return null;
}

/** Grid starts (ms) of one resource on one local date, before the notice / busy rules. */
function gridStarts(date: string, resource: ResourceSchedule, input: AvailabilityInput): number[] {
  const { tz, service, rules } = input;
  const step = Math.max(1, rules.slot_step_minutes);
  const out: number[] = [];
  for (const r of intervalsForDate(date, resource.hours, resource.exceptions)) {
    const closes = minuteToInstant(date, r.end, tz).getTime();
    for (let m = Math.ceil(r.start / step) * step; m < r.end; m += step) {
      const start = minuteToInstant(date, m, tz).getTime();
      if (start + service.duration_minutes * MIN_MS > closes) break;
      // A DST gap maps two labels onto one instant: keep it once.
      if (out.length > 0 && start <= out[out.length - 1]) continue;
      out.push(start);
    }
  }
  return out;
}

/**
 * Free slots for `dates` (local "YYYY-MM-DD", already inclusive-expanded).
 * One entry per start time, listing every resource that can take it.
 */
export function computeSlots(input: AvailabilityInput, dates: readonly string[]): Slot[] {
  const byStart = new Map<number, string[]>();
  // Hoisted: the horizon is the same for every start; working intervals are per (resource, date).
  const pre: Precomputed = { horizon: horizonMs(input.now, input.tz, input.rules.max_days_ahead), open: new Map() };
  for (const date of dates) {
    for (const resource of input.resources) {
      pre.open.set(
        `${resource.id}|${date}`,
        intervalsForDate(date, resource.hours, resource.exceptions).map(
          (r) => [minuteToInstant(date, r.start, input.tz).getTime(), minuteToInstant(date, r.end, input.tz).getTime()] as [number, number],
        ),
      );
      for (const start of gridStarts(date, resource, input)) {
        if (explainStart(input, resource, start, pre) !== null) continue;
        const list = byStart.get(start);
        if (list) list.push(resource.id);
        else byStart.set(start, [resource.id]);
      }
    }
  }
  const durMs = input.service.duration_minutes * MIN_MS;
  return [...byStart.entries()]
    .sort(([a], [b]) => a - b)
    .map(([start, ids]) => ({
      starts_at: new Date(start).toISOString(),
      ends_at: new Date(start + durMs).toISOString(),
      resource_ids: ids,
    }));
}
