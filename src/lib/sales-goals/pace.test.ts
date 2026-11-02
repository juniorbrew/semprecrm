import { describe, expect, it } from 'vitest'

import { currentMonth, dayOfMonth, daysInMonth, expectedByToday, monthPhase, paceStatus, parseTarget, percent, remaining, shiftMonth } from './pace'

const SP = 'America/Sao_Paulo'

describe('months in the account time zone', () => {
  it('uses the zone, not UTC, at the month boundary', () => {
    // 02:30 UTC on 1 Nov is still 31 Oct 23:30 in Sao Paulo
    const t = new Date('2026-11-01T02:30:00Z')
    expect(currentMonth(SP, t)).toBe('2026-10-01')
    expect(currentMonth('UTC', t)).toBe('2026-11-01')
    expect(dayOfMonth(SP, t)).toBe(31)
  })
  it('shifts across year ends and counts days', () => {
    expect(shiftMonth('2026-01-01', -1)).toBe('2025-12-01')
    expect(shiftMonth('2026-12-01', 1)).toBe('2027-01-01')
    expect(daysInMonth('2028-02-01')).toBe(29)
    expect(daysInMonth('2026-02-01')).toBe(28)
    expect(daysInMonth('2026-11-01')).toBe(30)
  })
  it('classifies the phase', () => {
    expect(monthPhase('2026-10-01', '2026-11-01')).toBe('past')
    expect(monthPhase('2026-11-01', '2026-11-01')).toBe('current')
    expect(monthPhase('2026-12-01', '2026-11-01')).toBe('future')
  })
})

describe('progress numbers', () => {
  it('percent is not capped, remaining never negative', () => {
    expect(percent({ target: 200, achieved: 50 })).toBe(25)
    expect(percent({ target: 200, achieved: 300 })).toBe(150)
    expect(percent({ target: 1000, achieved: 999.6 })).toBe(99)
    expect(percent({ target: 100, achieved: 29 })).toBe(29)
    expect(remaining({ target: 200, achieved: 300 })).toBe(0)
    expect(remaining({ target: 200, achieved: 50 })).toBe(150)
    expect(percent({ target: 0, achieved: 5 })).toBe(0)
  })
  it('expected by today is linear over the month', () => {
    expect(expectedByToday({ target: 300, achieved: 0 }, 10, 30)).toBe(100)
    expect(expectedByToday({ target: 300, achieved: 0 }, 99, 30)).toBe(300)
  })
})

describe('paceStatus', () => {
  const g = (achieved: number) => ({ target: 300, achieved })
  it('current month: on pace vs behind (today counts)', () => {
    expect(paceStatus(g(100), 'current', 10, 30)).toBe('on_pace')
    expect(paceStatus(g(99), 'current', 10, 30)).toBe('behind')
  })
  it('reaching the goal is a hit in any month', () => {
    expect(paceStatus(g(300), 'current', 2, 30)).toBe('hit')
    expect(paceStatus(g(400), 'past', 30, 30)).toBe('hit')
  })
  it('past months are hit or missed, future months have no verdict', () => {
    expect(paceStatus(g(10), 'past', 30, 30)).toBe('missed')
    expect(paceStatus(g(0), 'future', 1, 30)).toBe('none')
  })
})

describe('parseTarget', () => {
  it('reads pt-BR and plain numbers', () => {
    expect(parseTarget('12.500', 'won_value')).toBe(12500)
    expect(parseTarget('12500,50', 'won_value')).toBe(12500.5)
    expect(parseTarget('1.234.567,8', 'won_value')).toBe(1234567.8)
    expect(parseTarget(' 40 ', 'won_count')).toBe(40)
    expect(parseTarget('99.5', 'won_value')).toBe(99.5)
    expect(parseTarget('R$ 1.500,00', 'won_value')).toBe(1500)
    expect(parseTarget('1.500', 'won_value')).toBe(1500)
    expect(parseTarget('1500,5', 'won_value')).toBe(1500.5)
    expect(parseTarget('1.5', 'won_value')).toBe(1.5)
    expect(parseTarget('BRL 20', 'won_count')).toBe(20)
    expect(parseTarget('$300', 'won_value')).toBe(300)
  })
  it('refuses unusable targets', () => {
    expect(parseTarget('', 'won_value')).toBeNull()
    expect(parseTarget('0', 'won_value')).toBeNull()
    expect(parseTarget('-5', 'won_value')).toBeNull()
    expect(parseTarget('abc', 'won_value')).toBeNull()
    expect(parseTarget('1,234', 'won_value')).toBeNull() // three decimals
    expect(parseTarget('2,5', 'won_count')).toBeNull()
    expect(parseTarget('1000000001', 'won_value')).toBeNull()
  })
})
