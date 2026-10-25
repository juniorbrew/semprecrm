import { describe, expect, it } from 'vitest';

import {
  canReschedule,
  formatDuration,
  groupSlotsByDay,
  minutesToTime,
  parsePriceToCents,
  shiftDate,
  statusActions,
  summarizeDay,
  timeToMinutes,
  weekFromRows,
  weekToRows,
  windowFrom,
  emptyWeek,
} from './ui';

describe('time helpers', () => {
  it('converts minutes and HH:MM both ways', () => {
    expect(minutesToTime(540)).toBe('09:00');
    expect(minutesToTime(1440)).toBe('24:00');
    expect(timeToMinutes('09:30')).toBe(570);
    expect(timeToMinutes('24:00')).toBe(1440);
    expect(timeToMinutes('24:30')).toBeNull();
    expect(timeToMinutes('9:30')).toBeNull();
    expect(timeToMinutes('10:75')).toBeNull();
  });

  it('formats durations', () => {
    expect([45, 60, 90, 120].map(formatDuration)).toEqual(['45 min', '1 h', '1 h 30 min', '2 h']);
  });

  it('parses prices in Brazilian and plain formats', () => {
    expect(parsePriceToCents('R$ 35,00')).toBe(3500);
    expect(parsePriceToCents('1.234,50')).toBe(123450);
    expect(parsePriceToCents('35.5')).toBe(3550);
    expect(parsePriceToCents('')).toBeNull();
    expect(parsePriceToCents('abc')).toBeNull();
  });

  it('shifts calendar dates across month and year ends', () => {
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('windowFrom spans N local days starting today in the zone', () => {
    // 2026-10-25 01:00 UTC is still the 24th in São Paulo.
    expect(windowFrom('America/Sao_Paulo', new Date('2026-10-25T01:00:00Z'), 7)).toEqual({ from: '2026-10-24', to: '2026-10-30' });
  });
});

describe('groupSlotsByDay', () => {
  it('groups by the zone calendar day, not the UTC one', () => {
    const slot = (iso: string) => ({ starts_at: iso, ends_at: iso, resource_ids: ['r'] });
    const days = groupSlotsByDay(
      [slot('2026-10-27T01:30:00Z'), slot('2026-10-26T13:00:00Z'), slot('2026-10-26T12:00:00Z')],
      'America/Sao_Paulo',
    );
    expect(days.map((d) => [d.date, d.slots.length])).toEqual([['2026-10-26', 3]]);
    expect(days[0].slots[0].starts_at).toBe('2026-10-26T12:00:00Z');
    expect(groupSlotsByDay([slot('2026-10-27T01:30:00Z')], 'Asia/Tokyo')[0].date).toBe('2026-10-27');
  });
});

describe('weekly hours editor', () => {
  it('round-trips rows, sorted, with closed days empty', () => {
    const week = weekFromRows([
      { weekday: 1, start_minute: 840, end_minute: 1080 },
      { weekday: 1, start_minute: 540, end_minute: 720 },
    ]);
    expect(week[1]).toEqual([{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }]);
    expect(week[0]).toEqual([]);
    expect(summarizeDay(week[1])).toBe('09:00–12:00, 14:00–18:00');
    const back = weekToRows(week);
    expect(back.error).toBeNull();
    expect(back.rows).toEqual([
      { weekday: 1, start_minute: 540, end_minute: 720 },
      { weekday: 1, start_minute: 840, end_minute: 1080 },
    ]);
  });

  it('reports the first problem and its weekday', () => {
    const w = emptyWeek();
    w[2] = [{ start: '10:00', end: '09:00' }];
    expect(weekToRows(w)).toMatchObject({ error: 'end_before_start', weekday: 2 });
    w[2] = [{ start: '10:00', end: '12:00' }, { start: '11:00', end: '13:00' }];
    expect(weekToRows(w)).toMatchObject({ error: 'overlap', weekday: 2 });
    w[2] = [{ start: '', end: '12:00' }];
    expect(weekToRows(w)).toMatchObject({ error: 'invalid_time', weekday: 2 });
    w[2] = [{ start: '10:00', end: '12:00' }, { start: '12:00', end: '13:00' }];
    expect(weekToRows(w).error).toBeNull(); // touching is fine
  });
});

describe('status rules', () => {
  it('offers sensible transitions', () => {
    expect(statusActions('scheduled')).toEqual(['confirmed', 'completed', 'no_show', 'cancelled']);
    expect(statusActions('confirmed')).not.toContain('confirmed');
    expect(statusActions('cancelled')).toEqual(['scheduled']);
    expect(statusActions('completed')).toEqual([]);
    expect(canReschedule('confirmed')).toBe(true);
    expect(canReschedule('cancelled')).toBe(false);
  });
});
