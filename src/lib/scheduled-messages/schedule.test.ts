import { describe, expect, it } from 'vitest'

import {
  SCHEDULE_MAX_DAYS,
  formatScheduledAt,
  isWithinServiceWindow,
  parseLocalInput,
  schedulePresets,
  toLocalInputValue,
  validateScheduleAt,
} from './schedule'
import { windowEndsAt } from './window'

// Local-time constructors: the helpers work in the viewer's zone, so the
// tests build dates the same way and do not depend on the machine's TZ.
const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi)
// 2026-10-20 is a Tuesday.
const TUE_10H = local(2026, 10, 20, 10, 0)

describe('validateScheduleAt', () => {
  const now = TUE_10H
  it('accepts a future time (Date or ISO string)', () => {
    const at = new Date(now.getTime() + 3_600_000)
    expect(validateScheduleAt(at, now)).toEqual({ ok: true, date: at })
    expect(validateScheduleAt(at.toISOString(), now).ok).toBe(true)
  })
  it('rejects empty and malformed input', () => {
    for (const bad of [null, undefined, '', 'amanhã', 'NaN']) {
      expect(validateScheduleAt(bad, now)).toEqual({ ok: false, code: 'invalid' })
    }
  })
  it('rejects the past and anything under one minute away', () => {
    expect(validateScheduleAt(new Date(now.getTime() - 1000), now)).toEqual({ ok: false, code: 'too_soon' })
    expect(validateScheduleAt(new Date(now.getTime() + 59_999), now)).toEqual({ ok: false, code: 'too_soon' })
    expect(validateScheduleAt(new Date(now.getTime() + 60_000), now).ok).toBe(true)
  })
  it('rejects beyond the horizon', () => {
    const edge = new Date(now.getTime() + SCHEDULE_MAX_DAYS * 86_400_000)
    expect(validateScheduleAt(edge, now).ok).toBe(true)
    expect(validateScheduleAt(new Date(edge.getTime() + 1), now)).toEqual({ ok: false, code: 'too_far' })
  })
})

describe('schedulePresets', () => {
  it('offers today 18h only while it is at least 30 min away', () => {
    expect(schedulePresets(local(2026, 10, 20, 10, 0)).map((p) => p.key)).toEqual([
      'today_18',
      'tomorrow_8',
      'tomorrow_14',
      'monday_9',
    ])
    expect(schedulePresets(local(2026, 10, 20, 17, 45)).map((p) => p.key)).not.toContain('today_18')
    expect(schedulePresets(local(2026, 10, 20, 17, 30)).map((p) => p.key)).toContain('today_18')
  })
  it('puts "segunda às 9h" on the next Monday, and drops it when tomorrow is Monday', () => {
    const tue = schedulePresets(local(2026, 10, 20, 10)).find((p) => p.key === 'monday_9')!
    expect(tue.at).toEqual(local(2026, 10, 26, 9))
    const mon = schedulePresets(local(2026, 10, 19, 10)).find((p) => p.key === 'monday_9')!
    expect(mon.at).toEqual(local(2026, 10, 26, 9)) // on a Monday: the following one
    expect(schedulePresets(local(2026, 10, 25, 10)).map((p) => p.key)).not.toContain('monday_9') // Sunday
  })
  it('every preset is valid and in the future', () => {
    for (const day of [18, 19, 20, 21, 22, 23, 24, 25]) {
      const now = local(2026, 10, day, 23, 50)
      for (const p of schedulePresets(now)) expect(validateScheduleAt(p.at, now).ok).toBe(true)
    }
  })
  it('crosses month and year ends', () => {
    const p = schedulePresets(local(2026, 12, 31, 20)).find((x) => x.key === 'tomorrow_8')!
    expect(p.at).toEqual(local(2027, 1, 1, 8))
  })
})

describe('datetime-local round trip', () => {
  it('formats and parses minute precision in local time', () => {
    const d = local(2026, 3, 5, 7, 9)
    expect(toLocalInputValue(d)).toBe('2026-03-05T07:09')
    expect(parseLocalInput('2026-03-05T07:09')).toEqual(d)
  })
  it('rejects empty, malformed and rolled-over dates', () => {
    expect(parseLocalInput('')).toBeNull()
    expect(parseLocalInput('2026-03-05')).toBeNull()
    expect(parseLocalInput('2026-02-31T10:00')).toBeNull()
  })
})

describe('formatScheduledAt', () => {
  const now = TUE_10H
  it('says hoje / amanhã with a zero-padded time', () => {
    expect(formatScheduledAt(local(2026, 10, 20, 14, 5), now)).toBe('hoje às 14:05')
    expect(formatScheduledAt(local(2026, 10, 21, 8, 0), now)).toBe('amanhã às 08:00')
    expect(formatScheduledAt(local(2026, 10, 21, 8, 0), now, 'en-US')).toBe('tomorrow at 08:00')
  })
  it('spells out later days and adds the year only when it differs', () => {
    const same = formatScheduledAt(local(2026, 10, 26, 9, 0), now)
    expect(same).toMatch(/09:00$/)
    expect(same).not.toContain('2026')
    expect(formatScheduledAt(local(2027, 1, 4, 9, 0), now)).toContain('2027')
  })
})

describe('service window', () => {
  const now = new Date('2026-10-20T12:00:00Z')
  it('is open under 24 h after the last customer message', () => {
    expect(isWithinServiceWindow('2026-10-19T12:00:01Z', now)).toBe(true)
    expect(isWithinServiceWindow('2026-10-19T12:00:00Z', now)).toBe(false)
  })
  it('is closed when the customer never wrote or the value is bad', () => {
    expect(isWithinServiceWindow(null, now)).toBe(false)
    expect(isWithinServiceWindow('lixo', now)).toBe(false)
  })
  it('windowEndsAt adds 24 h', () => {
    expect(windowEndsAt('2026-10-19T12:00:00.000Z')).toBe('2026-10-20T12:00:00.000Z')
    expect(windowEndsAt(null)).toBeNull()
  })
})
