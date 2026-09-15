import { describe, expect, it } from 'vitest';

import {
  addDaysIn,
  addMonthsIn,
  allDayRange,
  clipToDay,
  dayKey,
  eventsForDay,
  formatEventRange,
  formatPeriodTitle,
  fromZonedInputValue,
  fromZonedParts,
  isAllDayLike,
  layoutTimedEvents,
  minutesOfDay,
  minutesToInstant,
  monthGrid,
  movedRange,
  safeTimezone,
  shiftAnchor,
  snapMinutes,
  startOfDayIn,
  startOfWeekIn,
  toZonedInputValue,
  visibleRange,
  weekDays,
  weekdayNames,
  zonedOffsetMs,
  zonedParts,
} from './range';

const SP = 'America/Sao_Paulo';
const NY = 'America/New_York';

describe('zoned parts', () => {
  it('reads the wall clock of an instant in the zone', () => {
    // 2026-09-14T03:30Z is 00:30 in São Paulo (UTC-3) — still the 14th.
    const p = zonedParts(Date.UTC(2026, 8, 14, 3, 30), SP);
    expect(p).toMatchObject({ year: 2026, month: 9, day: 14, hour: 0, minute: 30, weekday: 1 });
    // …but 23:30 on the 13th in New York (UTC-4, DST).
    const ny = zonedParts(Date.UTC(2026, 8, 14, 3, 30), NY);
    expect(ny).toMatchObject({ day: 13, hour: 23, minute: 30, weekday: 0 });
  });

  it('offsets: -3h in São Paulo, -4h/-5h in New York across DST', () => {
    expect(zonedOffsetMs(Date.UTC(2026, 8, 14), SP)).toBe(-3 * 3_600_000);
    expect(zonedOffsetMs(Date.UTC(2026, 6, 1), NY)).toBe(-4 * 3_600_000);
    expect(zonedOffsetMs(Date.UTC(2026, 0, 1), NY)).toBe(-5 * 3_600_000);
  });

  it('fromZonedParts is the inverse of zonedParts', () => {
    const d = fromZonedParts({ year: 2026, month: 9, day: 14, hour: 9, minute: 30 }, SP);
    expect(d.toISOString()).toBe('2026-09-14T12:30:00.000Z');
    expect(zonedParts(d, SP)).toMatchObject({ hour: 9, minute: 30 });
  });

  it('fromZonedParts normalises overflowing fields', () => {
    expect(fromZonedParts({ year: 2026, month: 13, day: 1 }, SP).toISOString()).toBe('2027-01-01T03:00:00.000Z');
    expect(fromZonedParts({ year: 2026, month: 9, day: 31 }, SP).toISOString()).toBe('2026-10-01T03:00:00.000Z');
  });

  it('handles the New York spring-forward gap (02:30 does not exist → 03:30)', () => {
    // 2026-03-08 02:00 → 03:00 in New York.
    const d = fromZonedParts({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, NY);
    expect(zonedParts(d, NY)).toMatchObject({ day: 8, hour: 3, minute: 30 });
  });

  it('safeTimezone falls back to São Paulo', () => {
    expect(safeTimezone('Nope/Nowhere')).toBe(SP);
    expect(safeTimezone(undefined)).toBe(SP);
    expect(safeTimezone('Europe/Lisbon')).toBe('Europe/Lisbon');
  });
});

describe('day / week / month boundaries', () => {
  const noon = Date.UTC(2026, 8, 14, 15); // 12:00 SP, Monday

  it('startOfDayIn / addDaysIn / dayKey', () => {
    expect(startOfDayIn(noon, SP).toISOString()).toBe('2026-09-14T03:00:00.000Z');
    expect(addDaysIn(noon, 1, SP).toISOString()).toBe('2026-09-15T03:00:00.000Z');
    expect(addDaysIn(noon, -14, SP).toISOString()).toBe('2026-08-31T03:00:00.000Z');
    expect(dayKey(noon, SP)).toBe('2026-09-14');
  });

  it('startOfWeekIn honours weekStartsOn', () => {
    expect(dayKey(startOfWeekIn(noon, SP, 0), SP)).toBe('2026-09-13'); // Sunday
    expect(dayKey(startOfWeekIn(noon, SP, 1), SP)).toBe('2026-09-14'); // Monday itself
  });

  it('addMonthsIn lands on the 1st', () => {
    expect(dayKey(addMonthsIn(noon, 1, SP), SP)).toBe('2026-10-01');
    expect(dayKey(addMonthsIn(noon, -9, SP), SP)).toBe('2025-12-01');
  });

  it('day length across the New York DST fall-back is 25 hours', () => {
    // 2026-11-01: 02:00 → 01:00 in New York.
    const start = fromZonedParts({ year: 2026, month: 11, day: 1 }, NY);
    const next = addDaysIn(start, 1, NY);
    expect((next.getTime() - start.getTime()) / 3_600_000).toBe(25);
  });
});

describe('grids', () => {
  const anchor = Date.UTC(2026, 8, 14, 15);

  it('monthGrid: 42 days starting on the Sunday before the 1st, today flagged', () => {
    const grid = monthGrid(anchor, SP, anchor);
    expect(grid).toHaveLength(42);
    expect(grid[0].key).toBe('2026-08-30');
    expect(grid[0].inMonth).toBe(false);
    expect(grid[2].key).toBe('2026-09-01');
    expect(grid[2].inMonth).toBe(true);
    expect(grid[41].key).toBe('2026-10-10');
    expect(grid.filter((d) => d.isToday).map((d) => d.key)).toEqual(['2026-09-14']);
    expect(grid.filter((d) => d.inMonth)).toHaveLength(30);
    // Each day ends where the next begins.
    for (let i = 1; i < grid.length; i++) expect(grid[i].start.getTime()).toBe(grid[i - 1].end.getTime());
  });

  it('weekDays: 7 days Sunday → Saturday', () => {
    const days = weekDays(anchor, SP, anchor);
    expect(days.map((d) => d.key)).toEqual([
      '2026-09-13',
      '2026-09-14',
      '2026-09-15',
      '2026-09-16',
      '2026-09-17',
      '2026-09-18',
      '2026-09-19',
    ]);
    expect(days.map((d) => d.weekday)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('visibleRange covers the grid', () => {
    expect(visibleRange('month', anchor, SP)).toEqual({
      from: new Date('2026-08-30T03:00:00.000Z'),
      to: new Date('2026-10-11T03:00:00.000Z'),
    });
    expect(visibleRange('day', anchor, SP)).toEqual({
      from: new Date('2026-09-14T03:00:00.000Z'),
      to: new Date('2026-09-15T03:00:00.000Z'),
    });
  });

  it('shiftAnchor moves by view period', () => {
    expect(dayKey(shiftAnchor('month', anchor, 1, SP), SP)).toBe('2026-10-01');
    expect(dayKey(shiftAnchor('week', anchor, -1, SP), SP)).toBe('2026-09-07');
    expect(dayKey(shiftAnchor('day', anchor, 3, SP), SP)).toBe('2026-09-17');
  });

  it('weekdayNames are localised and rotate with weekStartsOn', () => {
    expect(weekdayNames('en-US')).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
    expect(weekdayNames('en-US', 1)[0]).toBe('Mon');
    expect(weekdayNames('pt-BR')[1].toLowerCase()).toContain('seg');
  });
});

describe('placing events', () => {
  const day = {
    start: new Date('2026-09-14T03:00:00.000Z'),
    end: new Date('2026-09-15T03:00:00.000Z'),
  };
  const ev = (s: string, e: string, all_day = false) => ({ starts_at: s, ends_at: e, all_day });

  it('eventsForDay keeps overlaps, drops touching neighbours', () => {
    const list = [
      ev('2026-09-14T12:00:00Z', '2026-09-14T13:00:00Z'),
      ev('2026-09-15T03:00:00Z', '2026-09-15T04:00:00Z'), // next day
      ev('2026-09-14T01:00:00Z', '2026-09-14T03:00:00Z'), // ends exactly at day start
      ev('2026-09-14T02:00:00Z', '2026-09-14T04:00:00Z'), // crosses midnight
    ];
    expect(eventsForDay(list, day).map((e) => e.starts_at)).toEqual(['2026-09-14T02:00:00Z', '2026-09-14T12:00:00Z']);
  });

  it('isAllDayLike: flagged or multi-day, not a late-night call', () => {
    expect(isAllDayLike(ev('2026-09-14T03:00:00Z', '2026-09-15T03:00:00Z', true))).toBe(true);
    expect(isAllDayLike(ev('2026-09-14T12:00:00Z', '2026-09-16T12:00:00Z'))).toBe(true);
    expect(isAllDayLike(ev('2026-09-15T01:00:00Z', '2026-09-15T05:00:00Z'))).toBe(false); // 22:00 → 02:00
  });

  it('clipToDay clips to the day in minutes', () => {
    expect(clipToDay(ev('2026-09-14T12:00:00Z', '2026-09-14T13:30:00Z'), day)).toEqual({ startMin: 540, endMin: 630 });
    expect(clipToDay(ev('2026-09-14T02:00:00Z', '2026-09-14T04:00:00Z'), day)).toEqual({ startMin: 0, endMin: 60 });
    expect(clipToDay(ev('2026-09-15T02:00:00Z', '2026-09-15T05:00:00Z'), day)).toEqual({ startMin: 1380, endMin: 1440 });
  });

  it('layoutTimedEvents splits overlapping events into columns', () => {
    const a = ev('2026-09-14T12:00:00Z', '2026-09-14T13:00:00Z'); // 09–10
    const b = ev('2026-09-14T12:30:00Z', '2026-09-14T14:00:00Z'); // 09:30–11
    const c = ev('2026-09-14T15:00:00Z', '2026-09-14T16:00:00Z'); // 12–13, alone
    const d = ev('2026-09-14T13:00:00Z', '2026-09-14T13:15:00Z'); // 10–10:15 (min 30)
    const out = layoutTimedEvents([c, b, a, d], day);
    const byStart = Object.fromEntries(out.map((x) => [x.event.starts_at, x]));
    expect(byStart[a.starts_at]).toMatchObject({ col: 0, cols: 2 });
    expect(byStart[b.starts_at]).toMatchObject({ col: 1, cols: 2 });
    expect(byStart[d.starts_at]).toMatchObject({ col: 0, cols: 2, endMin: 630 });
    expect(byStart[c.starts_at]).toMatchObject({ col: 0, cols: 1 });
  });

  it('snapMinutes rounds to 30 within the day', () => {
    expect(snapMinutes(44)).toBe(30);
    expect(snapMinutes(46)).toBe(60);
    expect(snapMinutes(-10)).toBe(0);
    expect(snapMinutes(1500)).toBe(1440);
  });

  it('minutesToInstant / minutesOfDay round-trip in the zone', () => {
    const at = minutesToInstant(day, 9 * 60 + 30, SP);
    expect(at.toISOString()).toBe('2026-09-14T12:30:00.000Z');
    expect(minutesOfDay(at, SP)).toBe(570);
  });

  it('movedRange keeps the duration (timed) or the day count (all-day)', () => {
    const timed = movedRange(ev('2026-09-14T12:00:00Z', '2026-09-14T13:30:00Z'), new Date('2026-09-16T15:00:00Z'), SP);
    expect(timed).toEqual({ starts_at: '2026-09-16T15:00:00.000Z', ends_at: '2026-09-16T16:30:00.000Z' });
    const allDay = movedRange(
      ev('2026-09-14T03:00:00Z', '2026-09-16T03:00:00Z', true),
      new Date('2026-09-20T15:00:00Z'),
      SP,
    );
    expect(allDay).toEqual({ starts_at: '2026-09-20T03:00:00.000Z', ends_at: '2026-09-22T03:00:00.000Z' });
  });

  it('allDayRange spans whole days, end exclusive', () => {
    expect(allDayRange(new Date('2026-09-14T15:00:00Z'), new Date('2026-09-14T15:00:00Z'), SP)).toEqual({
      starts_at: '2026-09-14T03:00:00.000Z',
      ends_at: '2026-09-15T03:00:00.000Z',
    });
  });
});

describe('inputs and formatting', () => {
  it('datetime-local values are expressed in the zone', () => {
    expect(toZonedInputValue('2026-09-14T12:30:00Z', SP)).toBe('2026-09-14T09:30');
    expect(fromZonedInputValue('2026-09-14T09:30', SP)).toBe('2026-09-14T12:30:00.000Z');
    expect(fromZonedInputValue('2026-09-14', SP)).toBe('2026-09-14T03:00:00.000Z');
    expect(fromZonedInputValue('', SP)).toBeNull();
    expect(toZonedInputValue(null, SP)).toBe('');
  });

  it('period titles', () => {
    const anchor = Date.UTC(2026, 8, 14, 15);
    expect(formatPeriodTitle('month', anchor, 'en-US', SP)).toBe('September 2026');
    expect(formatPeriodTitle('week', anchor, 'en-US', SP)).toMatch(/^13 – Sep 19, 2026$/);
    expect(formatPeriodTitle('day', anchor, 'en-US', SP)).toMatch(/Mon, Sep 14, 2026/);
    // A week crossing months shows both.
    expect(formatPeriodTitle('week', Date.UTC(2026, 9, 1, 15), 'en-US', SP)).toMatch(/Sep 27 – Oct 3, 2026/);
  });

  it('event ranges', () => {
    const opts = { allDayLabel: 'All day' };
    expect(formatEventRange({ starts_at: '2026-09-14T12:00:00Z', ends_at: '2026-09-14T13:30:00Z', all_day: false }, 'en-US', SP, opts)).toBe(
      '09:00 AM – 10:30 AM',
    );
    expect(
      formatEventRange({ starts_at: '2026-09-14T03:00:00Z', ends_at: '2026-09-15T03:00:00Z', all_day: true }, 'en-US', SP, opts),
    ).toBe('All day');
    expect(
      formatEventRange({ starts_at: '2026-09-14T03:00:00Z', ends_at: '2026-09-16T03:00:00Z', all_day: true }, 'en-US', SP, opts),
    ).toBe('Sep 14 – Sep 15 · All day');
    expect(
      formatEventRange({ starts_at: '2026-09-14T12:00:00Z', ends_at: '2026-09-14T13:00:00Z', all_day: false }, 'en-US', SP, {
        ...opts,
        withDate: true,
      }),
    ).toBe('Sep 14 · 09:00 AM – 10:00 AM');
  });
});
