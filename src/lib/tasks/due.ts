// ============================================================
// Due-date helpers for tasks — pure, injectable `now`.
//
// `due_at` is a TIMESTAMPTZ (unlike deals' DATE column), so a task
// can be due at 14:00 today and be overdue by 15:00. "Today" is the
// local calendar day of `now`.
// ============================================================

import type { Language } from '@/lib/i18n';

const DAY_MS = 86_400_000;
const isPt = (lang: Language) => lang === 'pt-BR';

function parse(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Signed whole calendar days from `now` to `dueAt` (negative = past). */
export function daysUntilDue(
  dueAt: string | null | undefined,
  now: number = Date.now(),
): number | null {
  const t = parse(dueAt);
  if (t === null) return null;
  return Math.round((startOfDay(t) - startOfDay(now)) / DAY_MS);
}

/** Strictly before `now`. Tasks with no due date are never overdue. */
export function isOverdue(
  dueAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  const t = parse(dueAt);
  return t !== null && t < now;
}

/** Same local calendar day as `now` (regardless of the hour). */
export function isDueToday(
  dueAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  const t = parse(dueAt);
  return t !== null && startOfDay(t) === startOfDay(now);
}

/** Due today or already overdue — the "Hoje" chip on /tasks and the dashboard card. */
export function isDueTodayOrOverdue(
  dueAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  return isOverdue(dueAt, now) || isDueToday(dueAt, now);
}

export type DueTone = 'overdue' | 'today' | 'soon' | 'later';

export interface DueInfo {
  days: number;
  tone: DueTone;
  /** Chip text: "Atrasada 2 d" / "Hoje 14:00" / "Amanhã" / "Em 3 d" / "18 de set." */
  short: string;
  /** Full timestamp for tooltips: "18 de set. de 2026, 14:00". */
  long: string;
}

/**
 * Relative due label with urgency tone. Overdue reads red, today
 * amber; everything further out stays quiet.
 */
export function dueInfo(
  dueAt: string | null | undefined,
  lang: Language,
  now: number = Date.now(),
): DueInfo | null {
  const t = parse(dueAt);
  if (t === null) return null;
  const pt = isPt(lang);
  const days = Math.round((startOfDay(t) - startOfDay(now)) / DAY_MS);
  const d = new Date(t);
  const time = d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
  const dateLabel = d.toLocaleDateString(lang, { day: 'numeric', month: 'short' });
  const long = d.toLocaleString(lang, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  let tone: DueTone;
  let short: string;
  if (t < now) {
    tone = 'overdue';
    if (days === 0) {
      short = pt ? `Atrasada · ${time}` : `Overdue · ${time}`;
    } else {
      const n = -days;
      short = pt ? `Atrasada ${n} d` : `${n}d overdue`;
    }
  } else if (days === 0) {
    tone = 'today';
    short = pt ? `Hoje ${time}` : `Today ${time}`;
  } else if (days === 1) {
    tone = 'soon';
    short = pt ? 'Amanhã' : 'Tomorrow';
  } else if (days <= 7) {
    tone = 'soon';
    short = pt ? `Em ${days} d` : `In ${days}d`;
  } else {
    tone = 'later';
    short = dateLabel;
  }

  return { days, tone, short, long };
}

/**
 * `<input type="datetime-local">` value ("YYYY-MM-DDTHH:mm", local
 * time) for an ISO timestamp; empty string when null / invalid.
 */
export function toDateTimeLocal(iso: string | null | undefined): string {
  const t = parse(iso);
  if (t === null) return '';
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/** Inverse of `toDateTimeLocal`: local input value → ISO, or null when empty / invalid. */
export function fromDateTimeLocal(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** "today 18:00" style default for the quick-create: end of the local day. */
export function endOfToday(now: number = Date.now()): string {
  const d = new Date(now);
  d.setHours(18, 0, 0, 0);
  return d.toISOString();
}

/** ISO timestamp `hours` from `now` — used by the automation step's `due_in_hours`. */
export function dueInHours(hours: number, now: number = Date.now()): string | null {
  if (!Number.isFinite(hours) || hours < 0) return null;
  return new Date(now + hours * 3_600_000).toISOString();
}
