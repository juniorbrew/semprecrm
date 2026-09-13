import { describe, expect, it } from 'vitest'
import {
  daysUntilDue,
  dueInHours,
  dueInfo,
  fromDateTimeLocal,
  isDueToday,
  isDueTodayOrOverdue,
  isOverdue,
  toDateTimeLocal,
} from './due'

// 2026-09-12 (Saturday) 12:00 local.
const now = new Date(2026, 8, 12, 12, 0, 0).getTime()
const at = (d: number, h: number, m = 0) =>
  new Date(2026, 8, d, h, m, 0).toISOString()

describe('isOverdue / isDueToday', () => {
  it('treats a timestamp earlier today as overdue AND due today', () => {
    const due = at(12, 9)
    expect(isOverdue(due, now)).toBe(true)
    expect(isDueToday(due, now)).toBe(true)
    expect(isDueTodayOrOverdue(due, now)).toBe(true)
  })

  it('treats a timestamp later today as due today, not overdue', () => {
    const due = at(12, 18)
    expect(isOverdue(due, now)).toBe(false)
    expect(isDueToday(due, now)).toBe(true)
  })

  it('yesterday is overdue and not today; tomorrow is neither', () => {
    expect(isOverdue(at(11, 23), now)).toBe(true)
    expect(isDueToday(at(11, 23), now)).toBe(false)
    expect(isOverdue(at(13, 0), now)).toBe(false)
    expect(isDueToday(at(13, 0), now)).toBe(false)
    expect(isDueTodayOrOverdue(at(13, 0), now)).toBe(false)
  })

  it('never flags tasks without a due date', () => {
    expect(isOverdue(null, now)).toBe(false)
    expect(isDueToday(undefined, now)).toBe(false)
    expect(isOverdue('garbage', now)).toBe(false)
  })
})

describe('daysUntilDue', () => {
  it('counts calendar days, ignoring the hour', () => {
    expect(daysUntilDue(at(12, 23, 59), now)).toBe(0)
    expect(daysUntilDue(at(13, 0, 1), now)).toBe(1)
    expect(daysUntilDue(at(10, 8), now)).toBe(-2)
    expect(daysUntilDue(null, now)).toBeNull()
  })
})

describe('dueInfo', () => {
  it('overdue by days (pt-BR / en-US)', () => {
    const pt = dueInfo(at(10, 8), 'pt-BR', now)
    expect(pt?.tone).toBe('overdue')
    expect(pt?.short).toBe('Atrasada 2 d')
    expect(pt?.days).toBe(-2)
    const en = dueInfo(at(10, 8), 'en-US', now)
    expect(en?.short).toBe('2d overdue')
  })

  it('overdue earlier today shows the time', () => {
    const info = dueInfo(at(12, 9, 30), 'pt-BR', now)
    expect(info?.tone).toBe('overdue')
    expect(info?.short).toMatch(/^Atrasada · 09:30$/)
  })

  it('later today is "Hoje HH:mm"', () => {
    const info = dueInfo(at(12, 15), 'pt-BR', now)
    expect(info?.tone).toBe('today')
    expect(info?.short).toMatch(/^Hoje 15:00$/)
    expect(dueInfo(at(12, 15), 'en-US', now)?.short).toMatch(/^Today/)
  })

  it('tomorrow, this week, later', () => {
    expect(dueInfo(at(13, 10), 'pt-BR', now)?.short).toBe('Amanhã')
    expect(dueInfo(at(13, 10), 'en-US', now)?.short).toBe('Tomorrow')
    const soon = dueInfo(at(15, 10), 'pt-BR', now)
    expect(soon?.tone).toBe('soon')
    expect(soon?.short).toBe('Em 3 d')
    expect(dueInfo(at(15, 10), 'en-US', now)?.short).toBe('In 3d')
    const later = dueInfo(at(30, 10), 'pt-BR', now)
    expect(later?.tone).toBe('later')
    expect(later?.short).toContain('30')
    expect(later?.long).toContain('2026')
  })

  it('returns null without a date', () => {
    expect(dueInfo(null, 'pt-BR', now)).toBeNull()
    expect(dueInfo('nope', 'pt-BR', now)).toBeNull()
  })
})

describe('datetime-local round trip', () => {
  it('formats as YYYY-MM-DDTHH:mm in local time and parses back', () => {
    const iso = at(18, 14, 5)
    const local = toDateTimeLocal(iso)
    expect(local).toBe('2026-09-18T14:05')
    expect(fromDateTimeLocal(local)).toBe(iso)
  })

  it('empty / invalid values map to empty / null', () => {
    expect(toDateTimeLocal(null)).toBe('')
    expect(toDateTimeLocal('bad')).toBe('')
    expect(fromDateTimeLocal('')).toBeNull()
    expect(fromDateTimeLocal('bad')).toBeNull()
  })
})

describe('dueInHours', () => {
  it('adds whole hours to now', () => {
    expect(dueInHours(2, now)).toBe(new Date(now + 2 * 3_600_000).toISOString())
    expect(dueInHours(0, now)).toBe(new Date(now).toISOString())
  })
  it('rejects negatives and non-numbers', () => {
    expect(dueInHours(-1, now)).toBeNull()
    expect(dueInHours(Number.NaN, now)).toBeNull()
  })
})
