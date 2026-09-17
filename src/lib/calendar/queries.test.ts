import { describe, expect, it } from 'vitest';

import { filterByScope, involvesUser, normalizeEvent, sortUpcomingFirst } from './queries';

const ev = (
  id: string,
  owner: string | null,
  attendees: string[] = [],
  s = '2026-09-14T12:00:00Z',
  e = '2026-09-14T13:00:00Z',
) => ({
  id,
  owner_user_id: owner,
  attendees: attendees.map((user_id) => ({ event_id: id, user_id, response: 'needs_action' as const })),
  starts_at: s,
  ends_at: e,
});

describe('filterByScope', () => {
  const list = [ev('1', 'ana'), ev('2', 'bob', ['ana']), ev('3', 'bob'), ev('4', null, ['carol'])];

  it('team keeps everything', () => {
    expect(filterByScope(list, 'team', 'ana').map((e) => e.id)).toEqual(['1', '2', '3', '4']);
  });

  it('mine = owner or attendee', () => {
    expect(filterByScope(list, 'mine', 'ana').map((e) => e.id)).toEqual(['1', '2']);
    expect(filterByScope(list, 'mine', 'carol').map((e) => e.id)).toEqual(['4']);
    expect(filterByScope(list, 'mine', null).map((e) => e.id)).toEqual(['1', '2', '3', '4']);
  });

  it('one teammate', () => {
    expect(filterByScope(list, { userId: 'bob' }, 'ana').map((e) => e.id)).toEqual(['2', '3']);
    expect(involvesUser(list[1], 'ana')).toBe(true);
    expect(involvesUser(list[2], 'ana')).toBe(false);
  });
});

describe('sortUpcomingFirst', () => {
  it('puts events that already ended after the ones still to come', () => {
    const now = new Date('2026-09-14T14:30:00Z');
    const list = [
      ev('past', 'a', [], '2026-09-14T10:00:00Z', '2026-09-14T11:00:00Z'),
      ev('later', 'a', [], '2026-09-14T18:00:00Z', '2026-09-14T19:00:00Z'),
      ev('ongoing', 'a', [], '2026-09-14T14:00:00Z', '2026-09-14T15:00:00Z'),
      ev('soon', 'a', [], '2026-09-14T15:00:00Z', '2026-09-14T16:00:00Z'),
    ];
    expect(sortUpcomingFirst(list, now).map((e) => e.id)).toEqual(['ongoing', 'soon', 'later', 'past']);
  });
});

describe('normalizeEvent', () => {
  it('unwraps one-element embeds and defaults attendees', () => {
    const row = normalizeEvent({
      id: '1',
      contact: [{ id: 'c', name: 'M', phone: '1', avatar_url: null }],
      deal: null,
      task: { id: 't', title: 'T' },
    });
    expect(row.contact).toEqual({ id: 'c', name: 'M', phone: '1', avatar_url: null });
    expect(row.deal).toBeNull();
    expect(row.task).toEqual({ id: 't', title: 'T' });
    expect(row.attendees).toEqual([]);
  });
});
