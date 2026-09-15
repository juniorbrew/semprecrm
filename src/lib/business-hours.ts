// ============================================================
// Business hours (spec round 2 §2).
//
// `accounts.preferences.business_hours` holds an IANA timezone and up
// to two "HH:MM"–"HH:MM" ranges per weekday. Everything here is pure:
// the current instant is projected into the account's timezone with
// `Intl.DateTimeFormat` (no date library, DST handled by the runtime)
// and compared against that weekday's ranges.
// ============================================================

import type { AccountPreferences, BusinessHours, Weekday } from '@/types'
import { parseBusinessHours, timeToMinutes } from '@/lib/account-preferences'

export interface LocalClock {
  weekday: Weekday
  /** Minutes since local midnight (0–1439). */
  minutes: number
  /** Local calendar date, "YYYY-MM-DD". */
  date: string
}

const WEEKDAY_FROM_INTL: Record<string, Weekday> = {
  Mon: 'mon',
  Tue: 'tue',
  Wed: 'wed',
  Thu: 'thu',
  Fri: 'fri',
  Sat: 'sat',
  Sun: 'sun',
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timezone)
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hourCycle: 'h23',
        weekday: 'short',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    } catch {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC',
        hourCycle: 'h23',
        weekday: 'short',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    }
    formatterCache.set(timezone, f)
  }
  return f
}

/** Project an instant into the given timezone's wall clock. */
export function localClock(now: Date, timezone: string): LocalClock {
  const parts = formatterFor(timezone).formatToParts(now)
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? ''
  const hour = Number(get('hour')) % 24
  const minute = Number(get('minute'))
  return {
    weekday: WEEKDAY_FROM_INTL[get('weekday')] ?? 'mon',
    minutes: hour * 60 + minute,
    date: `${get('year')}-${get('month')}-${get('day')}`,
  }
}

/**
 * True when `now` falls inside one of the ranges configured for its
 * local weekday. Ranges are half-open: `start <= t < end`, so a
 * "09:00–18:00" day is open at 09:00 and closed at 18:00 sharp. A day
 * with no ranges is closed all day.
 */
export function isWithinBusinessHours(
  prefs: Pick<AccountPreferences, 'business_hours'> | BusinessHours,
  now: Date = new Date(),
): boolean {
  const hours: BusinessHours =
    'business_hours' in prefs ? prefs.business_hours : parseBusinessHours(prefs)
  const clock = localClock(now, hours.timezone)
  const ranges = hours.days[clock.weekday] ?? []
  for (const r of ranges) {
    const start = timeToMinutes(r.start)
    const end = timeToMinutes(r.end)
    if (start === null || end === null) continue
    if (clock.minutes >= start && clock.minutes < end) return true
  }
  return false
}

/**
 * Start (as an instant) of the current local calendar day in the
 * account's timezone — the out-of-hours reply is sent at most once per
 * local day per conversation.
 */
export function startOfLocalDay(now: Date, timezone: string): Date {
  const clock = localClock(now, timezone)
  // Walk back the elapsed wall-clock minutes; DST shifts of ±1h at most
  // move the boundary by an hour, which is fine for "once a day".
  return new Date(now.getTime() - clock.minutes * 60_000 - (now.getTime() % 60_000))
}

/** A curated list for the timezone select; the parser accepts any valid IANA name. */
export const TIMEZONE_OPTIONS: string[] = [
  'America/Sao_Paulo',
  'America/Manaus',
  'America/Belem',
  'America/Fortaleza',
  'America/Recife',
  'America/Bahia',
  'America/Cuiaba',
  'America/Campo_Grande',
  'America/Porto_Velho',
  'America/Boa_Vista',
  'America/Rio_Branco',
  'America/Noronha',
  'America/Argentina/Buenos_Aires',
  'America/Montevideo',
  'America/Santiago',
  'America/Bogota',
  'America/Lima',
  'America/Mexico_City',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/Lisbon',
  'Europe/London',
  'Europe/Madrid',
  'Europe/Paris',
  'Europe/Berlin',
  'Africa/Luanda',
  'Africa/Maputo',
  'Asia/Tokyo',
  'Australia/Sydney',
  'UTC',
]
