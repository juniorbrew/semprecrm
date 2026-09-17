import { describe, expect, it } from 'vitest';

import {
  TYPING_TTL_MS,
  applyTyping,
  nextTypingExpiry,
  onlineIdsFromState,
  presenceChannelName,
  pruneTyping,
  typingUsersIn,
} from './presence';

describe('presence', () => {
  it('names the channel per account', () => {
    expect(presenceChannelName('acc-1')).toBe('presence:account:acc-1');
  });

  it('reads online ids from the presence state (key or meta payload)', () => {
    const ids = onlineIdsFromState({
      'u-1': [{ user_id: 'u-1', at: 'x' }],
      'u-2': [{ user_id: 'u-2', at: 'x' }, { user_id: 'u-2', at: 'y' }], // two tabs
      'odd-key': [{ user_id: 'u-3' }],
      'u-4': [{}],
      'u-5': [],
    });
    expect([...ids].sort()).toEqual(['u-1', 'u-2', 'u-3', 'u-4']);
  });
});

describe('typing', () => {
  const now = 1_000_000;

  it('applies, lists and expires typing broadcasts after the TTL', () => {
    let map = applyTyping(new Map(), { thread_id: 't1', user_id: 'ana' }, now);
    map = applyTyping(map, { thread_id: 't1', user_id: 'bruno' }, now + 500);
    map = applyTyping(map, { thread_id: 't2', user_id: 'ana' }, now);
    expect(typingUsersIn(map, 't1', null, now + 1000).sort()).toEqual(['ana', 'bruno']);
    expect(typingUsersIn(map, 't1', 'ana', now + 1000)).toEqual(['bruno']);
    expect(typingUsersIn(map, 't2', null, now + 1000)).toEqual(['ana']);
    // Ana's t1 entry expires first.
    expect(typingUsersIn(map, 't1', null, now + TYPING_TTL_MS)).toEqual(['bruno']);
    expect(typingUsersIn(map, 't1', null, now + TYPING_TTL_MS + 500)).toEqual([]);
  });

  it('refreshing a broadcast extends its expiry', () => {
    let map = applyTyping(new Map(), { thread_id: 't1', user_id: 'ana' }, now);
    map = applyTyping(map, { thread_id: 't1', user_id: 'ana' }, now + 2000);
    expect(typingUsersIn(map, 't1', null, now + TYPING_TTL_MS + 1000)).toEqual(['ana']);
    expect(map.size).toBe(1);
  });

  it('prunes expired entries and keeps identity when nothing changed', () => {
    const map = applyTyping(new Map(), { thread_id: 't1', user_id: 'ana' }, now);
    expect(pruneTyping(map, now + 100)).toBe(map);
    const pruned = pruneTyping(map, now + TYPING_TTL_MS);
    expect(pruned).not.toBe(map);
    expect(pruned.size).toBe(0);
    expect(nextTypingExpiry(pruned)).toBeNull();
    expect(nextTypingExpiry(map)).toBe(now + TYPING_TTL_MS);
  });

  it('does not mutate the input map', () => {
    const map = new Map<string, number>();
    applyTyping(map, { thread_id: 't1', user_id: 'ana' }, now);
    expect(map.size).toBe(0);
  });
});
