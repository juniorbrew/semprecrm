// ============================================================
// Scheduled messages (migration 092) — pure rules shared by the API and the
// composer: limits, validation, presets and time formatting. No I/O and no
// hidden clock: every function takes `now`.
// ============================================================

/** Open (pending / sending / failed) scheduled messages per account. */
export const SCHEDULE_ACCOUNT_CAP = 100
/** Earliest allowed time: the cron ticks once a minute. */
export const SCHEDULE_MIN_LEAD_MS = 60_000
/** Furthest allowed time. */
export const SCHEDULE_MAX_DAYS = 90
export const SCHEDULE_TEXT_MAX = 4096

export type ScheduleErrorCode = 'invalid' | 'too_soon' | 'too_far'

export type ScheduleCheck =
  | { ok: true; date: Date }
  | { ok: false; code: ScheduleErrorCode }

export function validateScheduleAt(input: Date | string | number | null | undefined, now: Date): ScheduleCheck {
  if (input === null || input === undefined || input === '') return { ok: false, code: 'invalid' }
  const date = input instanceof Date ? input : new Date(input)
  const t = date.getTime()
  if (Number.isNaN(t)) return { ok: false, code: 'invalid' }
  if (t < now.getTime() + SCHEDULE_MIN_LEAD_MS) return { ok: false, code: 'too_soon' }
  if (t > now.getTime() + SCHEDULE_MAX_DAYS * 86_400_000) return { ok: false, code: 'too_far' }
  return { ok: true, date }
}

/** pt-BR reasons returned by the API. The composer shows the same codes in its own language. */
export const SCHEDULE_ERROR_PT: Record<ScheduleErrorCode, string> = {
  invalid: 'Data e hora inválidas.',
  too_soon: 'Escolha um horário pelo menos 1 minuto no futuro.',
  too_far: `Escolha uma data em até ${SCHEDULE_MAX_DAYS} dias.`,
}

export type PresetKey = 'today_18' | 'tomorrow_8' | 'tomorrow_14' | 'monday_9'

export interface SchedulePreset {
  key: PresetKey
  at: Date
}

function atLocal(base: Date, addDays: number, hour: number): Date {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + addDays, hour, 0, 0, 0)
}

/**
 * Quick options in the viewer's local time ("hoje às 18h", "amanhã às 8h",
 * "segunda às 9h"). "Hoje" only while at least 30 min away; "segunda" is the
 * next Monday, left out when that is already tomorrow.
 */
export function schedulePresets(now: Date): SchedulePreset[] {
  const out: SchedulePreset[] = []
  const today18 = atLocal(now, 0, 18)
  if (today18.getTime() - now.getTime() >= 30 * 60_000) out.push({ key: 'today_18', at: today18 })
  out.push({ key: 'tomorrow_8', at: atLocal(now, 1, 8) })
  out.push({ key: 'tomorrow_14', at: atLocal(now, 1, 14) })
  const untilMonday = ((8 - now.getDay()) % 7) || 7 // getDay(): 1 = Monday
  if (untilMonday > 1) out.push({ key: 'monday_9', at: atLocal(now, untilMonday, 9) })
  return out
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Value for `<input type="datetime-local">` (viewer's local time, minute precision). */
export function toLocalInputValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Parses a `datetime-local` value as local time; null when empty / malformed. */
export function parseLocalInput(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!m) return null
  const [y, mo, d, h, mi] = m.slice(1).map(Number)
  const date = new Date(y, mo - 1, d, h, mi, 0, 0)
  // Reject rollovers like 2026-02-31.
  return date.getMonth() === mo - 1 && date.getDate() === d ? date : null
}

function dayDiff(a: Date, b: Date): number {
  const da = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())
  const db = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())
  return Math.round((da - db) / 86_400_000)
}

/**
 * "hoje às 14:30" / "amanhã às 08:00" / "seg., 27 de out. às 09:00" in the
 * viewer's local time (the API stores an absolute instant).
 */
export function formatScheduledAt(date: Date, now: Date, lang: 'pt-BR' | 'en-US' = 'pt-BR'): string {
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const diff = dayDiff(date, now)
  const pt = lang === 'pt-BR'
  if (diff === 0) return pt ? `hoje às ${time}` : `today at ${time}`
  if (diff === 1) return pt ? `amanhã às ${time}` : `tomorrow at ${time}`
  const day = new Intl.DateTimeFormat(lang, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' as const } : {}),
  }).format(date)
  return pt ? `${day} às ${time}` : `${day} at ${time}`
}

/** WhatsApp Cloud API: free text only within 24 h of the customer's last message. */
export function isWithinServiceWindow(lastCustomerAt: string | null | undefined, now: Date): boolean {
  if (!lastCustomerAt) return false
  const t = new Date(lastCustomerAt).getTime()
  return !Number.isNaN(t) && now.getTime() - t < 24 * 3_600_000
}
