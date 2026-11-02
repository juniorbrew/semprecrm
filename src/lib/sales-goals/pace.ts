// Pure goal math for the "Metas do mês" card: month arithmetic in the
// account's time zone, percent / remaining and the pace verdict.
// Months are 'YYYY-MM-01' strings, the same shape as sales_goals.month.

import { zonedParts } from '@/lib/calendar/range'

export type GoalMetric = 'won_value' | 'won_count'
export type GoalScope = 'account' | 'team' | 'member'

/** 'YYYY-MM-01' of the month `now` falls in, for the account's time zone. */
export function currentMonth(tz: string, now: Date = new Date()): string {
  const p = zonedParts(now, tz)
  return `${p.year}-${String(p.month).padStart(2, '0')}-01`
}

/** Move a 'YYYY-MM-01' month by `delta` months (negative = back). */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + delta, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** Today's day of the month (1-based, today counts) in the account's time zone. */
export function dayOfMonth(tz: string, now: Date = new Date()): number {
  return zonedParts(now, tz).day
}

export type MonthPhase = 'past' | 'current' | 'future'

export function monthPhase(month: string, current: string): MonthPhase {
  return month < current ? 'past' : month > current ? 'future' : 'current'
}

export type PaceStatus = 'hit' | 'missed' | 'on_pace' | 'behind' | 'none'

export interface GoalNumbers {
  target: number
  achieved: number
}

export function percent(g: GoalNumbers): number {
  // floor: 999,60 of 1.000 is 99%, never a 100% that is not a hit (epsilon absorbs float noise)
  return g.target > 0 ? Math.floor((g.achieved * 100) / g.target + 1e-9) : 0
}

export function remaining(g: GoalNumbers): number {
  return Math.max(0, g.target - g.achieved)
}

/** What the goal should have reached by the end of `day` (today counts). */
export function expectedByToday(g: GoalNumbers, day: number, totalDays: number): number {
  return totalDays > 0 ? (g.target * Math.min(Math.max(day, 0), totalDays)) / totalDays : 0
}

/**
 * hit: goal reached (any month). Past months: hit or missed. Current month:
 * on pace when achieved >= expected so far, else behind. Future: none.
 */
export function paceStatus(g: GoalNumbers, phase: MonthPhase, day: number, totalDays: number): PaceStatus {
  if (g.achieved >= g.target) return 'hit'
  if (phase === 'past') return 'missed'
  if (phase === 'future') return 'none'
  return g.achieved >= expectedByToday(g, day, totalDays) ? 'on_pace' : 'behind'
}

export const MAX_TARGET = 1_000_000_000

/**
 * Parse what a person typed as a goal ("12.500", "12500,50"). null when it is
 * not a usable target: not positive, above the database ceiling, more than two
 * decimals, or not a whole number for a count goal.
 */
export function parseTarget(text: string, metric: GoalMetric): number | null {
  // a leading currency symbol or code (R$, US$, $, BRL ...) is ignored
  let s = text.trim().replace(/^(?:R\$|US\$|[$€£]|BRL|USD|EUR)\s*/i, '').replace(/\s/g, '')
  if (!s) return null
  // pt-BR: dots group thousands, comma is the decimal separator
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.')
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '')
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null
  const n = Number(s)
  if (!(n > 0) || n > MAX_TARGET) return null
  if (metric === 'won_count' && !Number.isInteger(n)) return null
  return n
}
