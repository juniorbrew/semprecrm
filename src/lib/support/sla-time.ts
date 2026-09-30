// ============================================================
// Business-hours arithmetic for SLA deadlines (migration 072).
//
// `addBusinessMinutes` is the reference twin of the SQL function
// `sla_add_business_minutes` that the `conversations_sla_stamp` trigger
// runs (both are tested against the same fixtures). Pure: no I/O, no
// date library — wall-clock boundaries are converted with
// `Intl.DateTimeFormat`, so DST transitions are handled by the runtime.
//
// Rules (same as the SQL):
//   - a range is half-open, `start <= t < end`;
//   - a range whose end <= start runs overnight into the next day;
//   - days without ranges are closed;
//   - a range with a malformed "HH:MM" is skipped on its own;
//   - no valid range at all, or an invalid timezone: plain elapsed time;
//   - a local time that happens twice (clocks go back) is its FIRST
//     occurrence; one that never happens (clocks go forward) is the first
//     valid instant after it (the moment the clocks jump).
// ============================================================

import type { BusinessHours, Weekday } from '@/types'
import { timeToMinutes } from '@/lib/account-preferences'

const DOW: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const MIN = 60_000

const formatters = new Map<string, Intl.DateTimeFormat>()
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz)
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
    })
    formatters.set(tz, f)
  }
  return f
}

/** Wall clock of `t` in `tz`, as a UTC-based timestamp (for arithmetic only). */
function wallAsUtc(t: number, tz: string): { wall: number; y: number; m: number; d: number } {
  const parts = formatter(tz).formatToParts(new Date(t))
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  const y = n('year'), m = n('month'), d = n('day')
  const wall = Date.UTC(y, m - 1, d, n('hour') % 24, n('minute'), n('second'))
  return { wall, y, m, d }
}

const DAY = 86_400_000

/** Offset of `tz` at instant `t` (ms): wall clock minus UTC. */
function offsetAt(t: number, tz: string): number {
  return wallAsUtc(t, tz).wall - Math.floor(t / 1000) * 1000
}

/**
 * Instant whose wall clock in `tz` reads `naiveUtc` (a UTC-based timestamp).
 * Twin of the SQL `sla_local_to_instant`: candidates use the offsets a day
 * before and a day after; both valid = ambiguous (first wins), none valid =
 * inside a gap (bisect to the first instant whose wall clock reaches it).
 */
function wallToInstant(naiveUtc: number, tz: string): number {
  const t1 = naiveUtc - offsetAt(naiveUtc - DAY, tz)
  const t2 = naiveUtc - offsetAt(naiveUtc + DAY, tz)
  const ok1 = wallAsUtc(t1, tz).wall === naiveUtc
  const ok2 = wallAsUtc(t2, tz).wall === naiveUtc
  if (ok1 && ok2) return Math.min(t1, t2)
  if (ok1) return t1
  if (ok2) return t2
  let lo = Math.floor(Math.min(t1, t2) / 1000)
  let hi = Math.floor(Math.max(t1, t2) / 1000)
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if (wallAsUtc(mid * 1000, tz).wall >= naiveUtc) hi = mid
    else lo = mid
  }
  return hi * 1000
}

interface Range {
  start: number
  end: number
}

function dayRanges(days: BusinessHours['days'], weekday: Weekday): Range[] {
  const out: Range[] = []
  const list = days?.[weekday]
  for (const r of Array.isArray(list) ? list : []) {
    const start = timeToMinutes(r?.start)
    const end = timeToMinutes(r?.end)
    if (start === null || end === null) continue
    out.push({ start, end })
  }
  return out.sort((a, b) => a.start - b.start)
}

/**
 * `from` plus `minutes` of OPEN time. `days` / `timezone` are the parts of
 * `accounts.preferences.business_hours`.
 */
export function addBusinessMinutes(
  from: Date,
  minutes: number,
  days: BusinessHours['days'],
  timezone: string,
): Date {
  const elapsed = () => new Date(from.getTime() + minutes * MIN)
  if (!(minutes > 0)) return new Date(from.getTime())
  const weekdays = DOW.filter((w) => dayRanges(days, w).length > 0)
  if (weekdays.length === 0) return elapsed()

  try {
    const { y, m, d } = wallAsUtc(from.getTime(), timezone)
    let left = minutes
    let cur = from.getTime()
    // Start a day early: yesterday's overnight range may still be open.
    for (let i = -1; i <= 400; i++) {
      const day = new Date(Date.UTC(y, m - 1, d + i))
      for (const r of dayRanges(days, DOW[day.getUTCDay()])) {
        const s = wallToInstant(day.getTime() + r.start * MIN, timezone)
        const e = wallToInstant(day.getTime() + (r.end <= r.start ? r.end + 1440 : r.end) * MIN, timezone)
        if (e <= cur) continue
        const from2 = Math.max(s, cur)
        const avail = (e - from2) / MIN
        if (avail >= left) return new Date(from2 + left * MIN)
        left -= avail
        cur = e
      }
    }
  } catch {
    // Invalid timezone: fall through to plain elapsed time.
  }
  return elapsed()
}
