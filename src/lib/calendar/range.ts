// ============================================================
// Calendar grids and timezone arithmetic — pure, no I/O.
//
// Every instant is a UTC `Date`; every *calendar* notion (day, week,
// month, "09:30") is computed in the account timezone through `Intl`
// so a Manaus account and a São Paulo account see their own
// midnight, and DST never shifts a day boundary by an hour. No extra
// dependency: `Intl.DateTimeFormat` gives us the wall-clock parts of
// an instant, and the inverse (`fromZonedParts`) is a two-step offset
// fix-up that converges for every real zone.
// ============================================================

import type { CalendarEvent } from '@/types';

import type { CalendarView } from './types';

export const DEFAULT_TIMEZONE = 'America/Sao_Paulo';
export const MINUTES_PER_DAY = 1440;
/** The grid snaps drags / clicks to this many minutes. */
export const SNAP_MINUTES = 30;
/** Week / day views scroll to this hour on open. */
export const DEFAULT_SCROLL_HOUR = 6;

const DAY_MS = 86_400_000;

// ------------------------------------------------------------
// Wall-clock parts <-> instants
// ------------------------------------------------------------

export interface ZonedParts {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    partsCache.set(tz, f);
  }
  return f;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Whether `tz` is an IANA zone this runtime knows. */
export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    formatterFor(tz);
    return true;
  } catch {
    return false;
  }
}

/** Normalise a preferences timezone; unknown values fall back to the default. */
export function safeTimezone(tz: unknown): string {
  return isValidTimezone(tz) ? tz : DEFAULT_TIMEZONE;
}

/** Wall-clock parts of `instant` in `tz`. */
export function zonedParts(instant: Date | number, tz: string): ZonedParts {
  const parts = formatterFor(tz).formatToParts(new Date(instant));
  const out: ZonedParts = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0, weekday: 0 };
  for (const p of parts) {
    switch (p.type) {
      case 'year':
        out.year = Number(p.value);
        break;
      case 'month':
        out.month = Number(p.value);
        break;
      case 'day':
        out.day = Number(p.value);
        break;
      case 'hour':
        out.hour = Number(p.value) % 24;
        break;
      case 'minute':
        out.minute = Number(p.value);
        break;
      case 'second':
        out.second = Number(p.value);
        break;
      case 'weekday':
        out.weekday = Math.max(0, WEEKDAYS.indexOf(p.value));
        break;
    }
  }
  return out;
}

/** Offset (ms) of `tz` at `instant`: wall-clock-as-UTC minus the instant. */
export function zonedOffsetMs(instant: Date | number, tz: string): number {
  const p = zonedParts(instant, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const t = new Date(instant).getTime();
  return asUtc - Math.floor(t / 1000) * 1000;
}

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
}

/**
 * The instant at which `tz` shows the given wall clock. Fields may
 * overflow (day 32, hour 25, month 13) and are normalised the way
 * `Date.UTC` does, which is what makes "add N days" trivial. On a DST
 * gap the instant after the gap is returned; on a fold, the first.
 */
export function fromZonedParts(wc: WallClock, tz: string): Date {
  const naive = Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour ?? 0, wc.minute ?? 0, wc.second ?? 0);
  // First guess with the offset at the naive instant, then re-read the
  // offset at the guess — that second pass is exact except inside a
  // transition, where we pick the later candidate.
  const guess = naive - zonedOffsetMs(naive, tz);
  const fixed = naive - zonedOffsetMs(guess, tz);
  if (fixed === guess) return new Date(fixed);
  const check = naive - zonedOffsetMs(fixed, tz);
  return new Date(check === fixed ? fixed : Math.max(guess, fixed));
}

// ------------------------------------------------------------
// Day / week / month boundaries in a zone
// ------------------------------------------------------------

export function startOfDayIn(instant: Date | number, tz: string): Date {
  const p = zonedParts(instant, tz);
  return fromZonedParts({ year: p.year, month: p.month, day: p.day }, tz);
}

/** `n` calendar days after the day containing `instant` (start of that day). */
export function addDaysIn(instant: Date | number, n: number, tz: string): Date {
  const p = zonedParts(instant, tz);
  return fromZonedParts({ year: p.year, month: p.month, day: p.day + n }, tz);
}

export function startOfWeekIn(instant: Date | number, tz: string, weekStartsOn = 0): Date {
  const p = zonedParts(instant, tz);
  const back = (p.weekday - weekStartsOn + 7) % 7;
  return fromZonedParts({ year: p.year, month: p.month, day: p.day - back }, tz);
}

export function startOfMonthIn(instant: Date | number, tz: string): Date {
  const p = zonedParts(instant, tz);
  return fromZonedParts({ year: p.year, month: p.month, day: 1 }, tz);
}

/** Start of the month `n` months away (day clamps to the 1st). */
export function addMonthsIn(instant: Date | number, n: number, tz: string): Date {
  const p = zonedParts(instant, tz);
  return fromZonedParts({ year: p.year, month: p.month + n, day: 1 }, tz);
}

/** "YYYY-MM-DD" in the zone — the key the grids use per day. */
export function dayKey(instant: Date | number, tz: string): string {
  const p = zonedParts(instant, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Same calendar day in the zone. */
export function isSameDayIn(a: Date | number, b: Date | number, tz: string): boolean {
  return dayKey(a, tz) === dayKey(b, tz);
}

// ------------------------------------------------------------
// Grids
// ------------------------------------------------------------

export interface GridDay {
  /** "YYYY-MM-DD" */
  key: string;
  /** Start of the day (inclusive) and of the next day (exclusive). */
  start: Date;
  end: Date;
  /** Day of month, 1–31 (zone-local). */
  dayOfMonth: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  /** Month view: false on the leading / trailing days of other months. */
  inMonth: boolean;
  isToday: boolean;
}

function gridDay(start: Date, tz: string, inMonth: boolean, todayKey: string): GridDay {
  const p = zonedParts(start, tz);
  const key = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  return {
    key,
    start,
    end: fromZonedParts({ year: p.year, month: p.month, day: p.day + 1 }, tz),
    dayOfMonth: p.day,
    weekday: p.weekday,
    inMonth,
    isToday: key === todayKey,
  };
}

/** 6 × 7 days covering the month of `anchor`, starting on `weekStartsOn`. */
export function monthGrid(
  anchor: Date | number,
  tz: string,
  now: Date | number = Date.now(),
  weekStartsOn = 0,
): GridDay[] {
  const month = zonedParts(anchor, tz).month;
  const first = startOfMonthIn(anchor, tz);
  const gridStart = startOfWeekIn(first, tz, weekStartsOn);
  const todayKey = dayKey(now, tz);
  const p0 = zonedParts(gridStart, tz);
  const out: GridDay[] = [];
  for (let i = 0; i < 42; i++) {
    const start = fromZonedParts({ year: p0.year, month: p0.month, day: p0.day + i }, tz);
    out.push(gridDay(start, tz, zonedParts(start, tz).month === month, todayKey));
  }
  return out;
}

/** The 7 days of the week containing `anchor`. */
export function weekDays(
  anchor: Date | number,
  tz: string,
  now: Date | number = Date.now(),
  weekStartsOn = 0,
): GridDay[] {
  const weekStart = startOfWeekIn(anchor, tz, weekStartsOn);
  const todayKey = dayKey(now, tz);
  const p0 = zonedParts(weekStart, tz);
  const out: GridDay[] = [];
  for (let i = 0; i < 7; i++) {
    const start = fromZonedParts({ year: p0.year, month: p0.month, day: p0.day + i }, tz);
    out.push(gridDay(start, tz, true, todayKey));
  }
  return out;
}

/** The single day containing `anchor`, as a one-element grid. */
export function singleDay(anchor: Date | number, tz: string, now: Date | number = Date.now()): GridDay[] {
  return [gridDay(startOfDayIn(anchor, tz), tz, true, dayKey(now, tz))];
}

export function gridFor(
  view: CalendarView,
  anchor: Date | number,
  tz: string,
  now: Date | number = Date.now(),
  weekStartsOn = 0,
): GridDay[] {
  if (view === 'month') return monthGrid(anchor, tz, now, weekStartsOn);
  if (view === 'week') return weekDays(anchor, tz, now, weekStartsOn);
  return singleDay(anchor, tz, now);
}

/** `[from, to)` the view needs from the DB. */
export function visibleRange(
  view: CalendarView,
  anchor: Date | number,
  tz: string,
  weekStartsOn = 0,
): { from: Date; to: Date } {
  const days = gridFor(view, anchor, tz, anchor, weekStartsOn);
  return { from: days[0].start, to: days[days.length - 1].end };
}

/** The anchor `delta` periods away (month / week / day). */
export function shiftAnchor(view: CalendarView, anchor: Date | number, delta: number, tz: string): Date {
  if (view === 'month') return addMonthsIn(anchor, delta, tz);
  if (view === 'week') return addDaysIn(anchor, 7 * delta, tz);
  return addDaysIn(anchor, delta, tz);
}

// ------------------------------------------------------------
// Placing events on a grid
// ------------------------------------------------------------

function ms(iso: string): number {
  return new Date(iso).getTime();
}

/** Half-open overlap of the event with `[from, to)`. */
export function eventOverlaps(
  event: Pick<CalendarEvent, 'starts_at' | 'ends_at'>,
  from: Date | number,
  to: Date | number,
): boolean {
  const f = new Date(from).getTime();
  const t = new Date(to).getTime();
  return ms(event.starts_at) < t && ms(event.ends_at) > f;
}

/** Events touching the day (any overlap), in start order. */
export function eventsForDay<T extends Pick<CalendarEvent, 'starts_at' | 'ends_at'>>(
  events: readonly T[],
  day: Pick<GridDay, 'start' | 'end'>,
): T[] {
  return events
    .filter((e) => eventOverlaps(e, day.start, day.end))
    .sort((a, b) => ms(a.starts_at) - ms(b.starts_at) || ms(b.ends_at) - ms(a.ends_at));
}

/**
 * Whether the event goes to the all-day strip of the week / day
 * views: flagged all-day, or timed but lasting a day or more (a
 * 22:00 → 02:00 call still sits in the time grid).
 */
export function isAllDayLike(event: Pick<CalendarEvent, 'starts_at' | 'ends_at' | 'all_day'>): boolean {
  if (event.all_day) return true;
  return ms(event.ends_at) - ms(event.starts_at) >= DAY_MS;
}

/** Minutes since the day's start; clipped to the day. */
export function clipToDay(
  event: Pick<CalendarEvent, 'starts_at' | 'ends_at'>,
  day: Pick<GridDay, 'start' | 'end'>,
): { startMin: number; endMin: number } {
  const dayStart = day.start.getTime();
  const dayLen = (day.end.getTime() - dayStart) / 60_000;
  const s = Math.max(0, (ms(event.starts_at) - dayStart) / 60_000);
  const e = Math.min(dayLen, (ms(event.ends_at) - dayStart) / 60_000);
  return { startMin: Math.floor(s), endMin: Math.max(Math.floor(s) + 1, Math.ceil(e)) };
}

export interface PositionedEvent<T = CalendarEvent> {
  event: T;
  startMin: number;
  endMin: number;
  /** Column index / count inside the overlap cluster. */
  col: number;
  cols: number;
}

/**
 * Column layout for the timed events of one day: overlapping events
 * split the width, disjoint clusters get the full width. Events
 * shorter than 30 minutes are laid out as 30 so the title fits.
 */
export function layoutTimedEvents<T extends Pick<CalendarEvent, 'starts_at' | 'ends_at'>>(
  events: readonly T[],
  day: Pick<GridDay, 'start' | 'end'>,
): PositionedEvent<T>[] {
  const items = events
    .map((event) => {
      const { startMin, endMin } = clipToDay(event, day);
      return { event, startMin, endMin: Math.max(endMin, startMin + SNAP_MINUTES), col: 0, cols: 1 };
    })
    .sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);

  // Sweep: a cluster is a run of events chained by overlap; inside a
  // cluster each event takes the first free column.
  let cluster: PositionedEvent<T>[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const cols = cluster.reduce((m, x) => Math.max(m, x.col + 1), 1);
    for (const x of cluster) x.cols = cols;
    cluster = [];
  };
  for (const item of items) {
    if (cluster.length > 0 && item.startMin >= clusterEnd) flush();
    const taken = new Set(cluster.filter((x) => x.endMin > item.startMin).map((x) => x.col));
    let col = 0;
    while (taken.has(col)) col++;
    item.col = col;
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, item.endMin);
  }
  flush();
  return items;
}

/** Round to the nearest `step` minutes, clamped to the day. */
export function snapMinutes(minutes: number, step = SNAP_MINUTES): number {
  const snapped = Math.round(minutes / step) * step;
  return Math.min(MINUTES_PER_DAY, Math.max(0, snapped));
}

/** Floor to `step` — used for "where did the click land". */
export function floorMinutes(minutes: number, step = SNAP_MINUTES): number {
  return Math.min(MINUTES_PER_DAY - step, Math.max(0, Math.floor(minutes / step) * step));
}

/** The instant `minutes` into the zone-local day. DST-safe. */
export function minutesToInstant(day: Pick<GridDay, 'start'>, minutes: number, tz: string): Date {
  const p = zonedParts(day.start, tz);
  return fromZonedParts(
    { year: p.year, month: p.month, day: p.day, hour: Math.floor(minutes / 60), minute: minutes % 60 },
    tz,
  );
}

/** Minutes since midnight (zone-local) of an instant. */
export function minutesOfDay(instant: Date | number, tz: string): number {
  const p = zonedParts(instant, tz);
  return p.hour * 60 + p.minute;
}

export function durationMinutes(event: Pick<CalendarEvent, 'starts_at' | 'ends_at'>): number {
  return Math.max(0, Math.round((ms(event.ends_at) - ms(event.starts_at)) / 60_000));
}

/**
 * Move an event so it starts at `newStart` keeping its duration. A
 * timed event keeps the exact millisecond length; an all-day event
 * keeps its number of days (DST-safe via day arithmetic).
 */
export function movedRange(
  event: Pick<CalendarEvent, 'starts_at' | 'ends_at' | 'all_day'>,
  newStart: Date,
  tz: string,
): { starts_at: string; ends_at: string } {
  if (event.all_day) {
    const days = Math.max(1, Math.round((ms(event.ends_at) - ms(event.starts_at)) / DAY_MS));
    const start = startOfDayIn(newStart, tz);
    return { starts_at: start.toISOString(), ends_at: addDaysIn(start, days, tz).toISOString() };
  }
  const len = ms(event.ends_at) - ms(event.starts_at);
  return { starts_at: newStart.toISOString(), ends_at: new Date(newStart.getTime() + len).toISOString() };
}

/** All-day range for the days `[first, last]` (end exclusive). */
export function allDayRange(first: Date | number, last: Date | number, tz: string): { starts_at: string; ends_at: string } {
  const start = startOfDayIn(first, tz);
  const end = addDaysIn(last, 1, tz);
  return {
    starts_at: start.toISOString(),
    ends_at: (end.getTime() > start.getTime() ? end : addDaysIn(start, 1, tz)).toISOString(),
  };
}

// ------------------------------------------------------------
// <input type="datetime-local"> / <input type="date"> in a zone
// ------------------------------------------------------------

/** "YYYY-MM-DDTHH:mm" for an ISO instant, in the zone. Empty when invalid. */
export function toZonedInputValue(iso: string | null | undefined, tz: string): string {
  if (!iso) return '';
  const t = ms(iso);
  if (Number.isNaN(t)) return '';
  const p = zonedParts(t, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** Inverse of `toZonedInputValue`: input value in the zone → ISO, or null. */
export function fromZonedInputValue(value: string, tz: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(value ?? '');
  if (!m) return null;
  const d = fromZonedParts(
    { year: +m[1], month: +m[2], day: +m[3], hour: m[4] ? +m[4] : 0, minute: m[5] ? +m[5] : 0 },
    tz,
  );
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** "YYYY-MM-DD" (zone) for an ISO instant. */
export function toZonedDateValue(iso: string | null | undefined, tz: string): string {
  return toZonedInputValue(iso, tz).slice(0, 10);
}

// ------------------------------------------------------------
// Formatting (Intl, zone-aware)
// ------------------------------------------------------------

export function formatTime(iso: string | Date, lang: string, tz: string): string {
  return new Intl.DateTimeFormat(lang, { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

export function formatShortDate(iso: string | Date, lang: string, tz: string): string {
  return new Intl.DateTimeFormat(lang, { timeZone: tz, day: 'numeric', month: 'short' }).format(new Date(iso));
}

export function formatLongDate(iso: string | Date, lang: string, tz: string): string {
  return new Intl.DateTimeFormat(lang, {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso));
}

export function formatDateTime(iso: string | Date, lang: string, tz: string): string {
  return new Intl.DateTimeFormat(lang, {
    timeZone: tz,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

/** Header title: "setembro de 2026" / "14 – 20 de set. de 2026" / "seg., 14 de set. de 2026". */
export function formatPeriodTitle(view: CalendarView, anchor: Date | number, lang: string, tz: string, weekStartsOn = 0): string {
  if (view === 'month') {
    const s = new Intl.DateTimeFormat(lang, { timeZone: tz, month: 'long', year: 'numeric' }).format(new Date(anchor));
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  if (view === 'day') {
    const s = formatLongDate(new Date(anchor), lang, tz);
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  const days = weekDays(anchor, tz, anchor, weekStartsOn);
  const first = days[0].start;
  const last = days[6].start;
  const pf = zonedParts(first, tz);
  const pl = zonedParts(last, tz);
  const fmt = (d: Date, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(lang, { timeZone: tz, ...opts }).format(d);
  if (pf.month === pl.month) {
    return `${pf.day} – ${fmt(last, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  }
  return `${fmt(first, { day: 'numeric', month: 'short' })} – ${fmt(last, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

/**
 * "14:00 – 15:30", "seg., 14 de set. · 14:00 – 15:30" or "Dia inteiro"
 * style ranges. `allDayLabel` is the translated "All day".
 */
export function formatEventRange(
  event: Pick<CalendarEvent, 'starts_at' | 'ends_at' | 'all_day'>,
  lang: string,
  tz: string,
  opts: { withDate?: boolean; allDayLabel: string },
): string {
  const start = new Date(event.starts_at);
  const end = new Date(event.ends_at);
  if (event.all_day) {
    const lastDay = new Date(end.getTime() - 1);
    if (isSameDayIn(start, lastDay, tz)) {
      return opts.withDate ? `${formatShortDate(start, lang, tz)} · ${opts.allDayLabel}` : opts.allDayLabel;
    }
    return `${formatShortDate(start, lang, tz)} – ${formatShortDate(lastDay, lang, tz)} · ${opts.allDayLabel}`;
  }
  const sameDay = isSameDayIn(start, end, tz);
  if (!sameDay) {
    return `${formatDateTime(start, lang, tz)} – ${formatDateTime(end, lang, tz)}`;
  }
  const time = `${formatTime(start, lang, tz)} – ${formatTime(end, lang, tz)}`;
  return opts.withDate ? `${formatShortDate(start, lang, tz)} · ${time}` : time;
}

/** Localised short weekday names starting on `weekStartsOn`. */
export function weekdayNames(lang: string, weekStartsOn = 0): string[] {
  const f = new Intl.DateTimeFormat(lang, { weekday: 'short', timeZone: 'UTC' });
  const out: string[] = [];
  for (let i = 0; i < 7; i++) {
    // 2024-01-07 is a Sunday.
    const d = Date.UTC(2024, 0, 7 + ((i + weekStartsOn) % 7));
    const s = f.format(d).replace(/\.$/, '');
    out.push(s.charAt(0).toUpperCase() + s.slice(1));
  }
  return out;
}
