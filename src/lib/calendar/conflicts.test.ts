import { describe, expect, it } from 'vitest';

import { findConflicts, hasConflict } from './conflicts';

const row = (
  id: string,
  owner: string | null,
  s: string,
  e: string,
  extra: Partial<{ all_day: boolean; status: 'confirmed' | 'cancelled' }> = {},
) => ({
  id,
  owner_user_id: owner,
  starts_at: s,
  ends_at: e,
  all_day: extra.all_day ?? false,
  status: extra.status ?? ('confirmed' as const),
});

const ana = 'ana';
const bob = 'bob';
const others = [
  row('1', ana, '2026-09-14T12:00:00Z', '2026-09-14T13:00:00Z'),
  row('2', ana, '2026-09-14T13:00:00Z', '2026-09-14T14:00:00Z'),
  row('3', bob, '2026-09-14T12:00:00Z', '2026-09-14T13:00:00Z'),
  row('4', ana, '2026-09-14T11:00:00Z', '2026-09-14T15:00:00Z', { status: 'cancelled' }),
  row('5', ana, '2026-09-14T03:00:00Z', '2026-09-15T03:00:00Z', { all_day: true }),
];

describe('findConflicts', () => {
  it('finds overlapping confirmed timed events of the same owner', () => {
    const hits = findConflicts(
      { owner_user_id: ana, starts_at: '2026-09-14T12:30:00Z', ends_at: '2026-09-14T13:30:00Z' },
      others,
    );
    expect(hits.map((h) => h.id)).toEqual(['1', '2']);
  });

  it('touching boundaries do not overlap', () => {
    const hits = findConflicts(
      { owner_user_id: ana, starts_at: '2026-09-14T14:00:00Z', ends_at: '2026-09-14T15:00:00Z' },
      others,
    );
    expect(hits).toEqual([]);
  });

  it('ignores itself, other owners, cancelled and all-day rows', () => {
    const hits = findConflicts(
      { id: '1', owner_user_id: ana, starts_at: '2026-09-14T12:00:00Z', ends_at: '2026-09-14T13:00:00Z' },
      others,
    );
    expect(hits.map((h) => h.id)).toEqual([]);
    expect(
      findConflicts({ owner_user_id: bob, starts_at: '2026-09-14T13:00:00Z', ends_at: '2026-09-14T14:00:00Z' }, others),
    ).toEqual([]);
  });

  it('never conflicts without an owner, as all-day, or with an invalid range', () => {
    expect(
      findConflicts({ owner_user_id: null, starts_at: '2026-09-14T12:00:00Z', ends_at: '2026-09-14T13:00:00Z' }, others),
    ).toEqual([]);
    expect(
      findConflicts(
        { owner_user_id: ana, all_day: true, starts_at: '2026-09-14T12:00:00Z', ends_at: '2026-09-14T13:00:00Z' },
        others,
      ),
    ).toEqual([]);
    expect(
      findConflicts({ owner_user_id: ana, starts_at: '2026-09-14T13:00:00Z', ends_at: '2026-09-14T12:00:00Z' }, others),
    ).toEqual([]);
    expect(hasConflict({ owner_user_id: ana, starts_at: 'nope', ends_at: '2026-09-14T12:00:00Z' }, others)).toBe(false);
  });

  it('hasConflict is the boolean form', () => {
    expect(
      hasConflict({ owner_user_id: ana, starts_at: '2026-09-14T12:30:00Z', ends_at: '2026-09-14T12:45:00Z' }, others),
    ).toBe(true);
  });
});
