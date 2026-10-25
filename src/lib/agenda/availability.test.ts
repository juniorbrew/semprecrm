import { describe, expect, it } from 'vitest';

import {
  computeSlots,
  datesBetween,
  explainStart,
  intervalsForDate,
  isDateString,
  localDate,
  minuteToInstant,
  weekdayOf,
  type AvailabilityInput,
  type ResourceSchedule,
} from './availability';
import type { AgendaSettings, WorkingInterval } from './types';

const BRT = 'America/Sao_Paulo';
// Saturday 2026-10-24 09:00 in São Paulo (UTC-3, no DST since 2019).
const NOW = new Date('2026-10-24T12:00:00Z');
const RULES: AgendaSettings = { min_notice_minutes: 0, max_days_ahead: 60, slot_step_minutes: 60 };

const h = (weekday: number, from: string, to: string): WorkingInterval => {
  const m = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  return { weekday, start_minute: m(from), end_minute: m(to) };
};

function resource(id: string, hours: WorkingInterval[], extra: Partial<ResourceSchedule> = {}): ResourceSchedule {
  return { id, hours, exceptions: [], busy: [], ...extra };
}

function input(over: Partial<AvailabilityInput> & { resources: ResourceSchedule[] }): AvailabilityInput {
  return {
    tz: BRT,
    now: NOW,
    service: { duration_minutes: 60, buffer_before_minutes: 0, buffer_after_minutes: 0 },
    rules: RULES,
    ...over,
  };
}

const starts = (slots: { starts_at: string }[]) => slots.map((s) => s.starts_at);
const MON = '2026-10-26';

describe('date helpers', () => {
  it('validates calendar dates', () => {
    expect(isDateString('2026-10-26')).toBe(true);
    expect(isDateString('2026-02-30')).toBe(false);
    expect(isDateString('26/10/2026')).toBe(false);
    expect(isDateString(undefined)).toBe(false);
  });

  it('weekday is zone independent (0 = Sunday)', () => {
    expect(weekdayOf('2026-10-25')).toBe(0);
    expect(weekdayOf(MON)).toBe(1);
  });

  it('datesBetween is inclusive and capped', () => {
    expect(datesBetween('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
    expect(datesBetween('2026-10-26', '2026-10-25')).toEqual([]);
    expect(datesBetween('2026-01-01', '2027-12-31')).toHaveLength(62);
  });

  it('minuteToInstant honours the zone, including minute 1440 = next midnight', () => {
    expect(minuteToInstant(MON, 9 * 60, BRT).toISOString()).toBe('2026-10-26T12:00:00.000Z');
    expect(minuteToInstant(MON, 1440, BRT).toISOString()).toBe('2026-10-27T03:00:00.000Z');
  });

  it('localDate puts an instant on the zone calendar day, not the UTC one', () => {
    expect(localDate(new Date('2026-10-27T01:30:00Z'), BRT)).toBe('2026-10-26');
    expect(localDate(new Date('2026-10-27T01:30:00Z'), 'Asia/Tokyo')).toBe('2026-10-27');
  });
});

describe('intervalsForDate', () => {
  const hours = [h(1, '08:00', '12:00'), h(1, '14:00', '18:00'), h(2, '09:00', '10:00')];

  it('returns the weekday intervals, merged and sorted', () => {
    expect(intervalsForDate(MON, [h(1, '14:00', '18:00'), h(1, '08:00', '12:00')], [])).toEqual([
      { start: 480, end: 720 },
      { start: 840, end: 1080 },
    ]);
  });

  it('day_off closes the day even with extra hours', () => {
    expect(
      intervalsForDate(MON, hours, [
        { on_date: MON, kind: 'extra_hours', start_minute: 1200, end_minute: 1260 },
        { on_date: MON, kind: 'day_off', start_minute: null, end_minute: null },
      ]),
    ).toEqual([]);
  });

  it('extra hours add to the day and merge with touching or overlapping intervals', () => {
    expect(
      intervalsForDate(MON, hours, [
        { on_date: MON, kind: 'extra_hours', start_minute: 720, end_minute: 840 },
        { on_date: '2026-10-27', kind: 'day_off', start_minute: null, end_minute: null },
      ]),
    ).toEqual([{ start: 480, end: 1080 }]);
  });

  it('extra hours open a day with no weekly hours (a Sunday)', () => {
    expect(
      intervalsForDate('2026-10-25', hours, [{ on_date: '2026-10-25', kind: 'extra_hours', start_minute: 600, end_minute: 720 }]),
    ).toEqual([{ start: 600, end: 720 }]);
  });
});

describe('computeSlots — working hours', () => {
  it('lists hourly starts inside one interval, in UTC', () => {
    const slots = computeSlots(input({ resources: [resource('r1', [h(1, '09:00', '12:00')])] }), [MON]);
    expect(starts(slots)).toEqual(['2026-10-26T12:00:00.000Z', '2026-10-26T13:00:00.000Z', '2026-10-26T14:00:00.000Z']);
    expect(slots[0].ends_at).toBe('2026-10-26T13:00:00.000Z');
    expect(slots[0].resource_ids).toEqual(['r1']);
  });

  it('the service must fit before closing (45 min on a 30-min grid)', () => {
    const slots = computeSlots(
      input({
        service: { duration_minutes: 45, buffer_before_minutes: 0, buffer_after_minutes: 0 },
        rules: { ...RULES, slot_step_minutes: 30 },
        resources: [resource('r1', [h(1, '09:00', '11:00')])],
      }),
      [MON],
    );
    // 09:00, 09:30, 10:00 (ends 10:45); 10:30 would end 11:15.
    expect(starts(slots)).toEqual(['2026-10-26T12:00:00.000Z', '2026-10-26T12:30:00.000Z', '2026-10-26T13:00:00.000Z']);
  });

  it('supports a lunch break (two intervals in a day)', () => {
    const slots = computeSlots(input({ resources: [resource('r1', [h(1, '11:00', '13:00'), h(1, '14:00', '15:00')])] }), [MON]);
    // 11, 12, 14 local
    expect(starts(slots)).toEqual(['2026-10-26T14:00:00.000Z', '2026-10-26T15:00:00.000Z', '2026-10-26T17:00:00.000Z']);
  });

  it('a service never straddles two intervals', () => {
    const slots = computeSlots(
      input({
        service: { duration_minutes: 120, buffer_before_minutes: 0, buffer_after_minutes: 0 },
        resources: [resource('r1', [h(1, '10:00', '11:00'), h(1, '11:00', '12:00')])],
      }),
      [MON],
    );
    // Touching intervals merge: 10:00-12:00 holds exactly one 2h start.
    expect(starts(slots)).toEqual(['2026-10-26T13:00:00.000Z']);
  });

  it('a service longer than the interval yields nothing', () => {
    const slots = computeSlots(
      input({
        service: { duration_minutes: 90, buffer_before_minutes: 0, buffer_after_minutes: 0 },
        resources: [resource('r1', [h(1, '09:00', '10:00')])],
      }),
      [MON],
    );
    expect(slots).toEqual([]);
  });

  it('aligns the grid to the step, not to the interval start', () => {
    const slots = computeSlots(
      input({ rules: { ...RULES, slot_step_minutes: 30 }, resources: [resource('r1', [h(1, '09:10', '11:00')])] }),
      [MON],
    );
    expect(starts(slots)[0]).toBe('2026-10-26T12:30:00.000Z'); // 09:30 local
  });

  it('no hours on a weekday = closed; a day_off exception closes a working day', () => {
    const r = resource('r1', [h(1, '09:00', '12:00')], {
      exceptions: [{ on_date: MON, kind: 'day_off', start_minute: null, end_minute: null }],
    });
    expect(computeSlots(input({ resources: [r] }), [MON, '2026-10-27'])).toEqual([]);
  });

  it('extra hours open a Sunday', () => {
    const r = resource('r1', [h(1, '09:00', '12:00')], {
      exceptions: [{ on_date: '2026-10-25', kind: 'extra_hours', start_minute: 600, end_minute: 660 }],
    });
    expect(starts(computeSlots(input({ resources: [r] }), ['2026-10-25']))).toEqual(['2026-10-25T13:00:00.000Z']);
  });

  it('handles intervals ending at midnight (1440)', () => {
    const r = resource('r1', [{ weekday: 1, start_minute: 22 * 60, end_minute: 1440 }]);
    expect(starts(computeSlots(input({ resources: [r] }), [MON]))).toEqual(['2026-10-27T01:00:00.000Z', '2026-10-27T02:00:00.000Z']);
  });
});

describe('computeSlots — busy time and buffers', () => {
  const day = [h(1, '09:00', '13:00')];

  it('an existing appointment removes the overlapping starts only', () => {
    const r = resource('r1', day, { busy: [{ starts_at: '2026-10-26T13:00:00Z', ends_at: '2026-10-26T14:00:00Z' }] }); // 10:00-11:00
    expect(starts(computeSlots(input({ resources: [r] }), [MON]))).toEqual([
      '2026-10-26T12:00:00.000Z', // 09
      '2026-10-26T14:00:00.000Z', // 11
      '2026-10-26T15:00:00.000Z', // 12
    ]);
  });

  it('back-to-back is allowed: busy ends exactly when the next slot starts', () => {
    const r = resource('r1', day, { busy: [{ starts_at: '2026-10-26T12:00:00Z', ends_at: '2026-10-26T13:00:00Z' }] }); // 09-10
    expect(starts(computeSlots(input({ resources: [r] }), [MON]))[0]).toBe('2026-10-26T13:00:00.000Z');
  });

  it('buffer after / before widen the blocked window of the candidate', () => {
    const busy = [{ starts_at: '2026-10-26T14:00:00Z', ends_at: '2026-10-26T15:00:00Z' }]; // 11:00-12:00
    const svc = { duration_minutes: 60, buffer_before_minutes: 0, buffer_after_minutes: 15 };
    // 10:00 + 15 min after-buffer = block 10:00-11:15, overlaps the 11:00 busy -> blocked; 12:00 is fine.
    const after = computeSlots(input({ service: svc, resources: [resource('r1', day, { busy })] }), [MON]);
    expect(starts(after)).toEqual(['2026-10-26T12:00:00.000Z', '2026-10-26T15:00:00.000Z']);
    // 15 min before-buffer: 12:00 becomes block 11:45-13:00, which overlaps the busy end (12:00) -> blocked.
    const before = computeSlots(
      input({ service: { ...svc, buffer_after_minutes: 0, buffer_before_minutes: 15 }, resources: [resource('r1', day, { busy })] }),
      [MON],
    );
    expect(starts(before)).toEqual(['2026-10-26T12:00:00.000Z', '2026-10-26T13:00:00.000Z']);
  });

  it('buffers may extend past the working hours (only the service itself must fit)', () => {
    const r = resource('r1', [h(1, '09:00', '10:00')]);
    const slots = computeSlots(
      input({ service: { duration_minutes: 60, buffer_before_minutes: 30, buffer_after_minutes: 30 }, resources: [r] }),
      [MON],
    );
    expect(slots).toHaveLength(1);
  });

  it('cancelled time is not busy: only the intervals handed in count', () => {
    expect(computeSlots(input({ resources: [resource('r1', day, { busy: [] })] }), [MON])).toHaveLength(4);
  });
});

describe('computeSlots — notice and horizon', () => {
  it('minimum notice hides starts that are too soon', () => {
    // Monday 08:00 local, 120 min notice -> first start 10:00.
    const slots = computeSlots(
      input({
        now: new Date('2026-10-26T11:00:00Z'),
        rules: { ...RULES, min_notice_minutes: 120 },
        resources: [resource('r1', [h(1, '08:00', '12:00')])],
      }),
      [MON],
    );
    expect(starts(slots)[0]).toBe('2026-10-26T13:00:00.000Z');
  });

  it('a start exactly at now + notice is allowed', () => {
    const r = resource('r1', [h(1, '08:00', '12:00')]);
    const i = input({ now: new Date('2026-10-26T11:00:00Z'), rules: { ...RULES, min_notice_minutes: 60 }, resources: [r] });
    expect(explainStart(i, r, new Date('2026-10-26T12:00:00Z').getTime())).toBeNull();
    expect(explainStart(i, r, new Date('2026-10-26T11:59:00Z').getTime())).toBe('min_notice');
  });

  it('max_days_ahead counts local days: today + N is the last bookable day', () => {
    const hours = [0, 1, 2, 3, 4, 5, 6].map((d) => h(d, '09:00', '10:00'));
    const slots = computeSlots(
      input({ rules: { ...RULES, max_days_ahead: 2 }, resources: [resource('r1', hours)] }),
      datesBetween('2026-10-24', '2026-10-30'),
    );
    // Today is Sat 24 (09:00 start is "now", notice 0): 24, 25, 26 only.
    expect(slots.map((s) => localDate(new Date(s.starts_at), BRT))).toEqual(['2026-10-24', '2026-10-25', '2026-10-26']);
  });

  it('explainStart names the failing rule', () => {
    const r = resource('r1', [h(1, '09:00', '12:00')], { busy: [{ starts_at: '2026-10-26T13:00:00Z', ends_at: '2026-10-26T14:00:00Z' }] });
    const i = input({ resources: [r], rules: { ...RULES, max_days_ahead: 5 } });
    expect(explainStart(i, r, new Date('2026-10-26T12:00:00Z').getTime())).toBeNull();
    expect(explainStart(i, r, new Date('2026-10-26T13:00:00Z').getTime())).toBe('busy');
    expect(explainStart(i, r, new Date('2026-10-26T16:00:00Z').getTime())).toBe('outside_hours'); // 13:00 local
    expect(explainStart(i, r, new Date('2026-10-26T11:00:00Z').getTime())).toBe('outside_hours'); // 08:00 local
    expect(explainStart(i, r, new Date('2026-12-07T12:00:00Z').getTime())).toBe('max_ahead');
    expect(explainStart(i, r, new Date('2026-10-23T12:00:00Z').getTime())).toBe('min_notice');
  });
});

describe('computeSlots — several resources', () => {
  it('groups the resources that can take each start, in time order', () => {
    const a = resource('a', [h(1, '09:00', '11:00')], { busy: [{ starts_at: '2026-10-26T12:00:00Z', ends_at: '2026-10-26T13:00:00Z' }] });
    const b = resource('b', [h(1, '10:00', '12:00')]);
    const slots = computeSlots(input({ resources: [a, b] }), [MON]);
    expect(slots.map((s) => [s.starts_at, s.resource_ids])).toEqual([
      ['2026-10-26T13:00:00.000Z', ['a', 'b']], // 10:00
      ['2026-10-26T14:00:00.000Z', ['b']], // 11:00
    ]);
  });

  it('an empty resource list has no slots', () => {
    expect(computeSlots(input({ resources: [] }), [MON])).toEqual([]);
  });
});

describe('timezone math', () => {
  it('day boundaries follow the zone: Auckland Monday 09:00 is still Sunday in UTC', () => {
    const tz = 'Pacific/Auckland'; // UTC+13 in late October (NZDT)
    const slots = computeSlots(
      input({ tz, now: new Date('2026-10-20T00:00:00Z'), resources: [resource('r1', [h(1, '09:00', '10:00')])] }),
      [MON],
    );
    expect(starts(slots)).toEqual(['2026-10-25T20:00:00.000Z']);
  });

  it('half-hour offsets (Asia/Kolkata, UTC+5:30)', () => {
    const slots = computeSlots(
      input({ tz: 'Asia/Kolkata', resources: [resource('r1', [h(1, '09:00', '10:00')])] }),
      [MON],
    );
    expect(starts(slots)).toEqual(['2026-10-26T03:30:00.000Z']);
  });

  it('spring-forward day (New York 2026-03-08): the missing 02:00 hour is not offered twice', () => {
    const date = '2026-03-08';
    const slots = computeSlots(
      input({
        tz: 'America/New_York',
        now: new Date('2026-03-01T00:00:00Z'),
        resources: [resource('r1', [h(0, '00:00', '06:00')])],
      }),
      [date],
    );
    const list = starts(slots);
    expect(new Set(list).size).toBe(list.length);
    // 00:00 EST, 01:00 EST, 03:00 EDT, 04:00 EDT, 05:00 EDT = 5 real hours.
    expect(list).toEqual([
      '2026-03-08T05:00:00.000Z',
      '2026-03-08T06:00:00.000Z',
      '2026-03-08T07:00:00.000Z',
      '2026-03-08T08:00:00.000Z',
      '2026-03-08T09:00:00.000Z',
    ]);
    expect(slots.every((s) => s.resource_ids.length === 1)).toBe(true);
  });

  it('fall-back day (New York 2026-11-01) stays ordered and unique', () => {
    const slots = computeSlots(
      input({
        tz: 'America/New_York',
        now: new Date('2026-10-01T00:00:00Z'),
        resources: [resource('r1', [h(0, '00:00', '06:00')])],
      }),
      ['2026-11-01'],
    );
    const list = starts(slots);
    expect([...list].sort()).toEqual(list);
    expect(new Set(list).size).toBe(list.length);
    expect(list.length).toBeGreaterThanOrEqual(6);
  });
});
