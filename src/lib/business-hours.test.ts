import { describe, expect, it } from 'vitest'

import { DEFAULT_BUSINESS_HOURS, parseBusinessHours } from './account-preferences'
import { isWithinBusinessHours, localClock, startOfLocalDay } from './business-hours'
import type { BusinessHours } from '@/types'

const prefs = (over: Partial<BusinessHours> = {}) => ({
  business_hours: { ...DEFAULT_BUSINESS_HOURS, ...over },
})

describe('localClock', () => {
  it('projects an instant into the account timezone', () => {
    // 2026-09-14 is a Monday. 14:30Z = 11:30 in São Paulo (UTC-3).
    const c = localClock(new Date('2026-09-14T14:30:00Z'), 'America/Sao_Paulo')
    expect(c.weekday).toBe('mon')
    expect(c.minutes).toBe(11 * 60 + 30)
    expect(c.date).toBe('2026-09-14')
  })

  it('crosses the day boundary when the timezone is ahead of UTC', () => {
    // Sunday 23:30Z is Monday 08:30 in Tokyo (UTC+9).
    const c = localClock(new Date('2026-09-13T23:30:00Z'), 'Asia/Tokyo')
    expect(c.weekday).toBe('mon')
    expect(c.minutes).toBe(8 * 60 + 30)
    expect(c.date).toBe('2026-09-14')
  })

  it('crosses the day boundary backwards when the timezone is behind UTC', () => {
    // Monday 01:00Z is still Sunday 22:00 in São Paulo.
    const c = localClock(new Date('2026-09-14T01:00:00Z'), 'America/Sao_Paulo')
    expect(c.weekday).toBe('sun')
    expect(c.minutes).toBe(22 * 60)
  })

  it('reports midnight as 0 minutes, never 1440', () => {
    const c = localClock(new Date('2026-09-14T03:00:00Z'), 'America/Sao_Paulo')
    expect(c.minutes).toBe(0)
    expect(c.weekday).toBe('mon')
  })
})

describe('isWithinBusinessHours', () => {
  it('is open on a weekday inside the default 09:00–18:00', () => {
    expect(isWithinBusinessHours(prefs(), new Date('2026-09-14T14:30:00Z'))).toBe(true) // 11:30 BRT
  })

  it('is closed before opening and at closing time (half-open range)', () => {
    expect(isWithinBusinessHours(prefs(), new Date('2026-09-14T11:59:00Z'))).toBe(false) // 08:59
    expect(isWithinBusinessHours(prefs(), new Date('2026-09-14T12:00:00Z'))).toBe(true) // 09:00
    expect(isWithinBusinessHours(prefs(), new Date('2026-09-14T20:59:00Z'))).toBe(true) // 17:59
    expect(isWithinBusinessHours(prefs(), new Date('2026-09-14T21:00:00Z'))).toBe(false) // 18:00
  })

  it('is closed on a day with no ranges (weekend by default)', () => {
    // Saturday 2026-09-12 14:00Z = 11:00 BRT
    expect(isWithinBusinessHours(prefs(), new Date('2026-09-12T14:00:00Z'))).toBe(false)
  })

  it('evaluates the weekday in the account timezone, not in UTC', () => {
    const tokyo = prefs({ timezone: 'Asia/Tokyo' })
    // Sunday 23:30Z → Monday 08:30 Tokyo → closed (opens 09:00)
    expect(isWithinBusinessHours(tokyo, new Date('2026-09-13T23:30:00Z'))).toBe(false)
    // Monday 00:30Z → Monday 09:30 Tokyo → open
    expect(isWithinBusinessHours(tokyo, new Date('2026-09-14T00:30:00Z'))).toBe(true)
    // Friday 22:00Z → Saturday 07:00 Tokyo → closed even though UTC says Friday
    expect(isWithinBusinessHours(tokyo, new Date('2026-09-18T22:00:00Z'))).toBe(false)
  })

  it('supports two ranges per day with a lunch break', () => {
    const split = prefs({
      days: {
        ...DEFAULT_BUSINESS_HOURS.days,
        mon: [
          { start: '08:00', end: '12:00' },
          { start: '14:00', end: '18:00' },
        ],
      },
    })
    expect(isWithinBusinessHours(split, new Date('2026-09-14T14:00:00Z'))).toBe(true) // 11:00
    expect(isWithinBusinessHours(split, new Date('2026-09-14T16:00:00Z'))).toBe(false) // 13:00
    expect(isWithinBusinessHours(split, new Date('2026-09-14T17:00:00Z'))).toBe(true) // 14:00
  })

  it('accepts a raw business_hours object and applies defaults', () => {
    const raw = parseBusinessHours({ timezone: 'Nope/Invalid', days: { mon: 'x' } })
    expect(raw.timezone).toBe('America/Sao_Paulo')
    expect(raw.days.mon).toEqual([{ start: '09:00', end: '18:00' }])
    expect(isWithinBusinessHours(raw, new Date('2026-09-14T14:30:00Z'))).toBe(true)
  })

  it('drops malformed or inverted ranges and caps at two per day', () => {
    const parsed = parseBusinessHours({
      days: {
        tue: [
          { start: '18:00', end: '09:00' },
          { start: '9:00', end: '12:00' },
          { start: '08:00', end: '10:00' },
          { start: '11:00', end: '12:00' },
          { start: '13:00', end: '14:00' },
        ],
        wed: [],
      },
    })
    expect(parsed.days.tue).toEqual([
      { start: '08:00', end: '10:00' },
      { start: '11:00', end: '12:00' },
    ])
    expect(parsed.days.wed).toEqual([])
  })
})

describe('startOfLocalDay', () => {
  it('returns local midnight of the account timezone as an instant', () => {
    const now = new Date('2026-09-14T14:30:45Z') // 11:30:45 BRT
    expect(startOfLocalDay(now, 'America/Sao_Paulo').toISOString()).toBe('2026-09-14T03:00:00.000Z')
  })

  it('uses the local calendar day even when UTC is already on the next day', () => {
    const now = new Date('2026-09-14T01:00:00Z') // Sunday 22:00 BRT
    expect(startOfLocalDay(now, 'America/Sao_Paulo').toISOString()).toBe('2026-09-13T03:00:00.000Z')
  })
})
