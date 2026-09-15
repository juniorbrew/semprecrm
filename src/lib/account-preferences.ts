// ============================================================
// accounts.preferences (migration 030) — typed access.
//
// The column is a free-form jsonb so new keys never need a
// migration. Everything that reads it goes through
// `parseAccountPreferences`, which tolerates a missing / malformed
// value (older rows, a hand-edited JSON) by falling back per key to
// the defaults below.
// ============================================================

import type {
  AccountPreferences,
  BusinessHours,
  BusinessHoursRange,
  Weekday,
} from '@/types'

export const WEEKDAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

export const DEFAULT_BUSINESS_HOURS: BusinessHours = {
  timezone: 'America/Sao_Paulo',
  days: {
    mon: [{ start: '09:00', end: '18:00' }],
    tue: [{ start: '09:00', end: '18:00' }],
    wed: [{ start: '09:00', end: '18:00' }],
    thu: [{ start: '09:00', end: '18:00' }],
    fri: [{ start: '09:00', end: '18:00' }],
    sat: [],
    sun: [],
  },
}

export const DEFAULT_OUT_OF_HOURS_MESSAGE =
  'Olá! No momento estamos fora do horário de atendimento. Assim que voltarmos, responderemos sua mensagem.'

export const DEFAULT_ACCOUNT_PREFERENCES: AccountPreferences = {
  inbox_sla_minutes: 15,
  cooling_hours: 24,
  opt_out_keywords: ['parar', 'sair', 'stop', 'cancelar'],
  business_hours: DEFAULT_BUSINESS_HOURS,
  out_of_hours_enabled: false,
  out_of_hours_message: DEFAULT_OUT_OF_HOURS_MESSAGE,
  auto_assign_enabled: false,
  require_mfa_admins: false,
}

/** Bounds the settings form and the parser agree on. */
export const PREFERENCE_LIMITS = {
  inbox_sla_minutes: { min: 1, max: 1440 },
  cooling_hours: { min: 1, max: 720 },
  opt_out_keyword_max_length: 30,
  opt_out_keywords_max: 20,
  out_of_hours_message_max_length: 1000,
  business_hours_ranges_per_day: 2,
} as const

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/** `"HH:MM"` → minutes since midnight, or null when malformed. */
export function timeToMinutes(value: unknown): number | null {
  if (typeof value !== 'string' || !TIME_RE.test(value)) return null
  const [h, m] = value.split(':').map(Number)
  return h * 60 + m
}

function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz.trim()) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

function rangeList(value: unknown): BusinessHoursRange[] | null {
  if (!Array.isArray(value)) return null
  const out: BusinessHoursRange[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const start = timeToMinutes(r.start)
    const end = timeToMinutes(r.end)
    if (start === null || end === null) continue
    // "start >= end" would be an empty (or overnight) range — dropped.
    if (start >= end) continue
    out.push({ start: r.start as string, end: r.end as string })
    if (out.length >= PREFERENCE_LIMITS.business_hours_ranges_per_day) break
  }
  return out
}

/** Parse a raw `business_hours` object; every part falls back to the default. */
export function parseBusinessHours(raw: unknown): BusinessHours {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
  const rawDays = obj.days && typeof obj.days === 'object' && !Array.isArray(obj.days)
    ? (obj.days as Record<string, unknown>)
    : {}
  const days = {} as BusinessHours['days']
  for (const day of WEEKDAYS) {
    days[day] = rangeList(rawDays[day]) ?? DEFAULT_BUSINESS_HOURS.days[day].map((r) => ({ ...r }))
  }
  return {
    timezone: isValidTimezone(obj.timezone) ? obj.timezone : DEFAULT_BUSINESS_HOURS.timezone,
    days,
  }
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function messageText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.slice(0, PREFERENCE_LIMITS.out_of_hours_message_max_length)
}

function positiveNumber(value: unknown, min: number, max: number): number | null {
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n)) return null
  if (n < min || n > max) return null
  return n
}

/**
 * Normalise a keyword the way the opt-out matcher compares messages:
 * trimmed, lower-case, no accents. Empty result → dropped.
 */
export function normalizeOptOutKeyword(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const cleaned = raw
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
  if (!cleaned) return null
  return cleaned.slice(0, PREFERENCE_LIMITS.opt_out_keyword_max_length)
}

function keywordList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const item of value) {
    const k = normalizeOptOutKeyword(item)
    if (k && !out.includes(k)) out.push(k)
    if (out.length >= PREFERENCE_LIMITS.opt_out_keywords_max) break
  }
  return out
}

/**
 * Parse the raw jsonb into a full `AccountPreferences`. Each key falls
 * back independently, so one bad value never wipes the others. An
 * explicitly empty keyword list is honoured (the account chose to
 * disable opt-out words); a non-array is not.
 */
export function parseAccountPreferences(raw: unknown): AccountPreferences {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
  const d = DEFAULT_ACCOUNT_PREFERENCES
  return {
    inbox_sla_minutes:
      positiveNumber(
        obj.inbox_sla_minutes,
        PREFERENCE_LIMITS.inbox_sla_minutes.min,
        PREFERENCE_LIMITS.inbox_sla_minutes.max,
      ) ?? d.inbox_sla_minutes,
    cooling_hours:
      positiveNumber(
        obj.cooling_hours,
        PREFERENCE_LIMITS.cooling_hours.min,
        PREFERENCE_LIMITS.cooling_hours.max,
      ) ?? d.cooling_hours,
    opt_out_keywords: keywordList(obj.opt_out_keywords) ?? [...d.opt_out_keywords],
    business_hours: parseBusinessHours(obj.business_hours),
    out_of_hours_enabled: booleanOr(obj.out_of_hours_enabled, d.out_of_hours_enabled),
    out_of_hours_message: messageText(obj.out_of_hours_message) ?? d.out_of_hours_message,
    auto_assign_enabled: booleanOr(obj.auto_assign_enabled, d.auto_assign_enabled),
    require_mfa_admins: booleanOr(obj.require_mfa_admins, d.require_mfa_admins),
  }
}

/**
 * What the settings form writes back. Merges over the existing jsonb so
 * keys owned by other features survive; values are validated the same
 * way `parseAccountPreferences` reads them.
 */
export function mergeAccountPreferences(
  existing: unknown,
  patch: Partial<AccountPreferences>,
): Record<string, unknown> {
  const base =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {}
  const parsed = parseAccountPreferences({ ...base, ...patch })
  if (patch.inbox_sla_minutes !== undefined) base.inbox_sla_minutes = parsed.inbox_sla_minutes
  if (patch.cooling_hours !== undefined) base.cooling_hours = parsed.cooling_hours
  if (patch.opt_out_keywords !== undefined) base.opt_out_keywords = parsed.opt_out_keywords
  if (patch.business_hours !== undefined) base.business_hours = parsed.business_hours
  if (patch.out_of_hours_enabled !== undefined)
    base.out_of_hours_enabled = parsed.out_of_hours_enabled
  if (patch.out_of_hours_message !== undefined)
    base.out_of_hours_message = parsed.out_of_hours_message
  if (patch.auto_assign_enabled !== undefined)
    base.auto_assign_enabled = parsed.auto_assign_enabled
  if (patch.require_mfa_admins !== undefined)
    base.require_mfa_admins = parsed.require_mfa_admins
  return base
}
