import { describe, expect, it } from 'vitest'

import type { BusinessHours } from '@/types'
import { addBusinessMinutes } from './sla-time'

// Same fixtures as supabase/tests/support_sla_teams.sql (sla_add_business_minutes).
const closed = { start: '', end: '' }
const weekday = [{ start: '09:00', end: '18:00' }]
const SP: BusinessHours['days'] = {
  mon: weekday, tue: weekday, wed: weekday, thu: weekday, fri: weekday, sat: [], sun: [],
}
const none = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] } satisfies BusinessHours['days']
const add = (from: string, mins: number, days: BusinessHours['days'], tz: string) =>
  addBusinessMinutes(new Date(from), mins, days, tz).toISOString().replace('.000Z', 'Z')

describe('addBusinessMinutes', () => {
  it('stays inside the day', () => {
    expect(add('2026-03-02T13:00:00Z', 60, SP, 'America/Sao_Paulo')).toBe('2026-03-02T14:00:00Z')
  })
  it('carries the rest over the weekend', () => {
    // Fri 17:30 -03 + 60 -> Mon 09:30 -03
    expect(add('2026-03-06T20:30:00Z', 60, SP, 'America/Sao_Paulo')).toBe('2026-03-09T12:30:00Z')
  })
  it('starts counting at the next opening when the clock starts on a closed day', () => {
    expect(add('2026-03-07T15:00:00Z', 30, SP, 'America/Sao_Paulo')).toBe('2026-03-09T12:30:00Z')
  })
  it('starts counting at the opening when the clock starts before it', () => {
    expect(add('2026-03-02T10:00:00Z', 15, SP, 'America/Sao_Paulo')).toBe('2026-03-02T12:15:00Z')
  })
  it('lands exactly on the closing time for a full day', () => {
    expect(add('2026-03-02T12:00:00Z', 540, SP, 'America/Sao_Paulo')).toBe('2026-03-02T21:00:00Z')
  })
  it('reads the wall clock in the configured timezone', () => {
    // 13:00Z is 10:00 in Sao Paulo (open) but 13:00 in UTC+0 is also open; 22:00Z is 19:00 -03 (closed).
    expect(add('2026-03-02T22:00:00Z', 30, SP, 'America/Sao_Paulo')).toBe('2026-03-03T12:30:00Z')
    expect(add('2026-03-02T22:00:00Z', 30, SP, 'UTC')).toBe('2026-03-03T09:30:00Z')
  })

  describe('overnight ranges', () => {
    const overnight: BusinessHours['days'] = { ...none, mon: [{ start: '22:00', end: '06:00' }] }
    it('runs past midnight', () => {
      expect(add('2026-03-02T23:00:00Z', 120, overnight, 'UTC')).toBe('2026-03-03T01:00:00Z')
    })
    it('counts the tail after midnight, then waits for next Monday', () => {
      expect(add('2026-03-03T05:00:00Z', 120, overnight, 'UTC')).toBe('2026-03-09T23:00:00Z')
    })
  })

  describe('daylight saving time', () => {
    // US spring forward: Sun 2026-03-08 02:00 -> 03:00 (New York). 00:00-04:00 holds 180 real minutes.
    const dst: BusinessHours['days'] = { ...none, sun: [{ start: '00:00', end: '04:00' }] }
    it('counts real minutes across the gap', () => {
      expect(add('2026-03-08T05:00:00Z', 180, dst, 'America/New_York')).toBe('2026-03-08T08:00:00Z')
    })
    it('spills the extra minute to the next open Sunday', () => {
      expect(add('2026-03-08T05:00:00Z', 181, dst, 'America/New_York')).toBe('2026-03-15T04:01:00Z')
    })
  })

  describe('degenerate input', () => {
    it('falls back to elapsed time when the account is never open', () => {
      expect(add('2026-03-02T13:00:00Z', 90, none, 'UTC')).toBe('2026-03-02T14:30:00Z')
    })
    it('falls back to elapsed time on an invalid timezone', () => {
      expect(add('2026-03-02T13:00:00Z', 90, SP, 'Not/AZone')).toBe('2026-03-02T14:30:00Z')
    })
    it('ignores malformed ranges', () => {
      const bad: BusinessHours['days'] = { ...none, mon: [closed, { start: '09:00', end: '10:00' }] }
      expect(add('2026-03-02T08:00:00Z', 30, bad, 'UTC')).toBe('2026-03-02T09:30:00Z')
    })
    it('returns the same instant for zero or negative minutes', () => {
      expect(add('2026-03-02T13:00:00Z', 0, SP, 'UTC')).toBe('2026-03-02T13:00:00Z')
      expect(add('2026-03-02T13:00:00Z', -5, SP, 'UTC')).toBe('2026-03-02T13:00:00Z')
    })
  })
})
