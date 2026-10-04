import { describe, expect, it } from 'vitest'

import { formatSnoozeWhen, showsSnoozeWokeMarker } from './snooze'

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
