// ============================================================
// Agenda UI helpers — pure (no React, no I/O), unit-tested.
// ============================================================

import { addDaysIn, startOfDayIn } from '@/lib/calendar/range';

import { localDate } from './availability';
import type { AppointmentStatus, Slot, WorkingInterval } from './types';

/** Display order of weekdays (Monday first); values are Date#getDay numbers. */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

export const WEEKDAY_NAMES: Record<'pt-BR' | 'en-US', readonly string[]> = {
  'pt-BR': ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'],
  'en-US': ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
};

/** 540 -> "09:00" (1440 -> "24:00"). */
export function minutesToTime(minutes: number): string {
  const m = Math.max(0, Math.min(1440, Math.round(minutes)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** "09:30" -> 570; null when malformed. "24:00" is accepted as the end of the day. */
export function timeToMinutes(value: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 24 || (h === 24 && min !== 0)) return null;
  return h * 60 + min;
}

export function formatPrice(cents: number | null | undefined, lang: string): string {
  if (cents === null || cents === undefined) return '';
  return new Intl.NumberFormat(lang, { style: 'currency', currency: 'BRL' }).format(cents / 100);
}

/** "R$ 35,00" / "35.00" / "35" -> 3500; null when empty or invalid. */
export function parsePriceToCents(input: string): number | null {
  const cleaned = input.replace(/[^\d,.-]/g, '').trim();
  if (!cleaned) return null;
  const normalized = cleaned.includes(',') ? cleaned.replace(/\./g, '').replace(',', '.') : cleaned;
  const n = Number(normalized);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

/** 90 -> "1 h 30 min", 45 -> "45 min", 120 -> "2 h". */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** Local "YYYY-MM-DD" today in the zone. */
export function todayIn(tz: string, now: Date = new Date()): string {
  return localDate(now, tz);
}

/** `date` shifted by `n` calendar days ("YYYY-MM-DD", zone independent). */
export function shiftDate(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Slots grouped by local day, days and slots in order. */
export function groupSlotsByDay(slots: readonly Slot[], tz: string): { date: string; slots: Slot[] }[] {
  const days = new Map<string, Slot[]>();
  for (const slot of slots) {
    const key = localDate(new Date(slot.starts_at), tz);
    const list = days.get(key);
    if (list) list.push(slot);
    else days.set(key, [slot]);
  }
  return [...days.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, list]) => ({ date, slots: list.sort((a, b) => a.starts_at.localeCompare(b.starts_at)) }));
}

// ---------------- weekly hours editor <-> rows ----------------

export interface HoursRange {
  start: string;
  end: string;
}
export type WeeklyDraft = Record<number, HoursRange[]>;

export function emptyWeek(): WeeklyDraft {
  return { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
}

export function weekFromRows(rows: readonly Pick<WorkingInterval, 'weekday' | 'start_minute' | 'end_minute'>[]): WeeklyDraft {
  const week = emptyWeek();
  for (const r of [...rows].sort((a, b) => a.start_minute - b.start_minute)) {
    week[r.weekday]?.push({ start: minutesToTime(r.start_minute), end: minutesToTime(r.end_minute) });
  }
  return week;
}

export type WeekError = 'invalid_time' | 'end_before_start' | 'overlap';

/** Rows for the API plus the first problem found (null = valid). */
export function weekToRows(week: WeeklyDraft): {
  rows: { weekday: number; start_minute: number; end_minute: number }[];
  error: WeekError | null;
  weekday: number | null;
} {
  const rows: { weekday: number; start_minute: number; end_minute: number }[] = [];
  for (const weekday of WEEKDAY_ORDER) {
    const ranges: { start_minute: number; end_minute: number }[] = [];
    for (const r of week[weekday] ?? []) {
      const s = timeToMinutes(r.start);
      const e = timeToMinutes(r.end);
      if (s === null || e === null || s >= 1440) return { rows: [], error: 'invalid_time', weekday };
      if (e <= s) return { rows: [], error: 'end_before_start', weekday };
      ranges.push({ start_minute: s, end_minute: e });
    }
    ranges.sort((a, b) => a.start_minute - b.start_minute);
    for (let i = 1; i < ranges.length; i += 1) {
      if (ranges[i].start_minute < ranges[i - 1].end_minute) return { rows: [], error: 'overlap', weekday };
    }
    for (const r of ranges) rows.push({ weekday, ...r });
  }
  return { rows, error: null, weekday: null };
}

/** "09:00–12:00, 14:00–18:00" or "" for a closed day. */
export function summarizeDay(ranges: readonly HoursRange[]): string {
  return ranges.map((r) => `${r.start}–${r.end}`).join(', ');
}

// ---------------- appointment status ----------------

export const STATUS_LABELS: Record<'pt-BR' | 'en-US', Record<AppointmentStatus, string>> = {
  'pt-BR': { scheduled: 'Agendado', confirmed: 'Confirmado', cancelled: 'Cancelado', no_show: 'Faltou', completed: 'Concluído' },
  'en-US': { scheduled: 'Scheduled', confirmed: 'Confirmed', cancelled: 'Cancelled', no_show: 'No-show', completed: 'Completed' },
};

/** Status changes offered from a given status. */
export function statusActions(status: string): AppointmentStatus[] {
  switch (status) {
    case 'scheduled':
      return ['confirmed', 'completed', 'no_show', 'cancelled'];
    case 'confirmed':
      return ['completed', 'no_show', 'cancelled'];
    case 'cancelled':
    case 'no_show':
      return ['scheduled'];
    default:
      return [];
  }
}

export function canReschedule(status: string): boolean {
  return status === 'scheduled' || status === 'confirmed';
}

/** First and last local date of a booking window starting today ("YYYY-MM-DD"). */
export function windowFrom(tz: string, now: Date, days: number): { from: string; to: string } {
  const start = startOfDayIn(now, tz);
  return { from: localDate(start, tz), to: localDate(addDaysIn(start, days - 1, tz), tz) };
}

// ------------------------------------------------------------
// Reminder offsets (097): the settings screen edits "value + unit".
// ------------------------------------------------------------

export type OffsetUnit = 'minutes' | 'hours' | 'days';
const UNIT_MINUTES: Record<OffsetUnit, number> = { minutes: 1, hours: 60, days: 1440 };

/** 1440 -> 1 day, 120 -> 2 hours, 90 -> 90 minutes (the largest unit that divides evenly). */
export function splitOffset(minutes: number): { value: number; unit: OffsetUnit } {
  if (minutes >= 1440 && minutes % 1440 === 0) return { value: minutes / 1440, unit: 'days' };
  if (minutes >= 60 && minutes % 60 === 0) return { value: minutes / 60, unit: 'hours' };
  return { value: minutes, unit: 'minutes' };
}

export function joinOffset(value: number, unit: OffsetUnit): number {
  return Math.round(value * UNIT_MINUTES[unit]);
}

/** "1 dia antes", "2 h antes", "30 min antes" / "1 day before", "2 h before", "30 min before". */
export function formatOffset(minutes: number, lang: 'pt-BR' | 'en-US'): string {
  const { value, unit } = splitOffset(minutes);
  const pt = lang === 'pt-BR';
  const label =
    unit === 'days' ? (pt ? (value === 1 ? 'dia' : 'dias') : value === 1 ? 'day' : 'days') : unit === 'hours' ? 'h' : 'min';
  return `${value} ${label} ${pt ? 'antes' : 'before'}`;
}
