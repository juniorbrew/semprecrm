import { describe, expect, it } from 'vitest'

import {
  availableSnoozePresets,
  formatSnoozeWhen,
  normalizeSnoozeNote,
  showsSnoozeWokeMarker,
  snoozeErrorFromDb,
  snoozePresetTime,
  snoozeUndoPayload,
  validateSnoozeTime,
} from './snooze'

// Local-time instants (the helpers use the browser clock).
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()
// Saturday 2026-10-03 13:59 local.
const SAT = at(2026, 10, 3, 13, 59)

describe('formatSnoozeWhen', () => {
  it('today / tomorrow / weekday within the week / date after that', () => {
    expect(formatSnoozeWhen(new Date(at(2026, 10, 3, 15)), 'pt-BR', SAT)).toBe('hoje 15:00')
    expect(formatSnoozeWhen(new Date(at(2026, 10, 4, 9)), 'pt-BR', SAT)).toBe('amanhã 09:00')
    expect(formatSnoozeWhen(new Date(at(2026, 10, 5, 9)), 'pt-BR', SAT)).toBe('seg 09:00')
    expect(formatSnoozeWhen(new Date(at(2026, 10, 12, 9)), 'pt-BR', SAT)).toBe('12/10 09:00')
    expect(formatSnoozeWhen(new Date(at(2026, 10, 4, 9)), 'en-US', SAT)).toMatch(/^tomorrow /)
  })
})

describe('showsSnoozeWokeMarker', () => {
  const base = {
    snooze_woke_at: '2026-10-04T12:00:00Z',
    last_customer_message_at: '2026-10-04T08:00:00Z',
    unread_count: 1,
    snoozed_until: null,
  }
  it('woke and unread, nothing newer from the customer', () => {
    expect(showsSnoozeWokeMarker(base)).toBe(true)
    expect(showsSnoozeWokeMarker({ ...base, last_customer_message_at: null })).toBe(true)
    // Woken by the customer's own message (same instant or later stamp).
    expect(showsSnoozeWokeMarker({ ...base, last_customer_message_at: base.snooze_woke_at })).toBe(true)
  })
  it('not forever: read, a later customer message, never woke, or snoozed again', () => {
    expect(showsSnoozeWokeMarker({ ...base, unread_count: 0 })).toBe(false)
    expect(showsSnoozeWokeMarker({ ...base, last_customer_message_at: '2026-10-06T08:00:00Z' })).toBe(false)
    expect(showsSnoozeWokeMarker({ ...base, snooze_woke_at: null })).toBe(false)
    expect(showsSnoozeWokeMarker({ ...base, snoozed_until: '2026-10-07T08:00:00Z' })).toBe(false)
  })
})

describe('snoozePresetTime', () => {
  const local = (d: Date | null) => (d ? [d.getDate(), d.getHours(), d.getMinutes()] : null)
  it('Hoje mais tarde: 15h before 14:00, 18h before 17:00, hidden after', () => {
    expect(local(snoozePresetTime('laterToday', at(2026, 10, 2, 13, 59)))).toEqual([2, 15, 0])
    expect(local(snoozePresetTime('laterToday', at(2026, 10, 2, 14, 0)))).toEqual([2, 18, 0])
    expect(local(snoozePresetTime('laterToday', at(2026, 10, 2, 16, 59)))).toEqual([2, 18, 0])
    expect(snoozePresetTime('laterToday', at(2026, 10, 2, 17, 0))).toBeNull()
    expect(availableSnoozePresets(at(2026, 10, 2, 17, 0)).map((p) => p.preset)).toEqual(['in1h', 'tomorrow9', 'nextMonday9'])
    expect(availableSnoozePresets(at(2026, 10, 2, 9, 0)).map((p) => p.preset)).toEqual(['in1h', 'laterToday', 'tomorrow9', 'nextMonday9'])
    // Sunday: next Monday 9h == tomorrow 9h, offered once.
    expect(availableSnoozePresets(at(2026, 10, 4, 9, 0)).map((p) => p.preset)).toEqual(['in1h', 'laterToday', 'tomorrow9'])
  })
  it('Daqui a 1 hora on the minute; Amanhã às 9h', () => {
    const now = at(2026, 10, 2, 10, 30) + 42_000
    expect(snoozePresetTime('in1h', now)!.getTime()).toBe(at(2026, 10, 2, 11, 30))
    expect(local(snoozePresetTime('tomorrow9', at(2026, 10, 31, 22)))).toEqual([1, 9, 0]) // month end
  })
  it('Próxima segunda: strictly after today, across month and year ends', () => {
    expect(snoozePresetTime('nextMonday9', at(2026, 10, 5, 8))!.getTime()).toBe(at(2026, 10, 12, 9)) // on a Monday
    expect(snoozePresetTime('nextMonday9', at(2026, 10, 4, 23))!.getTime()).toBe(at(2026, 10, 5, 9)) // Sunday
    expect(snoozePresetTime('nextMonday9', at(2026, 10, 31, 12))!.getTime()).toBe(at(2026, 11, 2, 9)) // Saturday, month end
    expect(snoozePresetTime('nextMonday9', at(2026, 12, 31, 12))!.getTime()).toBe(at(2027, 1, 4, 9)) // year end
  })
})

describe('validateSnoozeTime', () => {
  const now = at(2026, 10, 2, 10)
  it('the guard range: now + 1 min .. now + 366 d', () => {
    expect(validateSnoozeTime(new Date(NaN), now)).toBe('invalid')
    expect(validateSnoozeTime(null, now)).toBe('invalid')
    expect(validateSnoozeTime(new Date(now - 1), now)).toBe('too_soon')
    expect(validateSnoozeTime(new Date(now + 59_000), now)).toBe('too_soon')
    expect(validateSnoozeTime(new Date(now + 60_000), now)).toBeNull()
    expect(validateSnoozeTime(new Date(now + 366 * 86_400_000), now)).toBeNull()
    expect(validateSnoozeTime(new Date(now + 367 * 86_400_000), now)).toBe('too_far')
  })
  it('maps the database errors', () => {
    expect(snoozeErrorFromDb({ code: '22023' })).toBe('out_of_range')
    expect(snoozeErrorFromDb({ code: '23514' })).toBe('not_live')
    expect(snoozeErrorFromDb({ code: '42501' })).toBe('failed')
    expect(snoozeErrorFromDb(null)).toBe('failed')
  })
  it('notes are trimmed, capped at 200, empty = null', () => {
    expect(normalizeSnoozeNote('  oi ')).toBe('oi')
    expect(normalizeSnoozeNote('   ')).toBeNull()
    expect(normalizeSnoozeNote('x'.repeat(250))).toHaveLength(200)
  })
})

describe('snoozeUndoPayload', () => {
  const now = at(2026, 10, 2, 10)
  it('was awake: undo wakes it (note null)', () => {
    expect(snoozeUndoPayload({ snoozed_until: null, snooze_note: null }, now)).toEqual({ snoozed_until: null, snooze_note: null })
  })
  it('was snoozed: undo restores the previous time and note while still valid', () => {
    const prev = new Date(now + 3_600_000).toISOString()
    expect(snoozeUndoPayload({ snoozed_until: prev, snooze_note: 'boleto' }, now)).toEqual({ snoozed_until: prev, snooze_note: 'boleto' })
    const stale = new Date(now + 30_000).toISOString()
    expect(snoozeUndoPayload({ snoozed_until: stale, snooze_note: 'x' }, now)).toEqual({ snoozed_until: null, snooze_note: null })
  })
})
