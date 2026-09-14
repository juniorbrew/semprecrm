import { describe, expect, it } from 'vitest';

import type { ChatMessageReaction } from '@/types';

import { aggregateReactions, hasReaction, mergeReactions, QUICK_REACTIONS, removeReaction, toggleReactionRows } from './reactions';

const ME = 'me';
const ANA = 'ana';
const BRUNO = 'bruno';

function r(user_id: string, emoji: string, created_at: string, message_id = 'm1'): ChatMessageReaction {
  return { message_id, user_id, emoji, thread_id: 't1', created_at };
}

describe('aggregateReactions', () => {
  it('groups by emoji in order of first reaction, marks mine, ignores other messages', () => {
    const rows = [
      r(ANA, '❤️', '2026-09-14T12:00:02Z'),
      r(ME, '👍', '2026-09-14T12:00:01Z'),
      r(BRUNO, '👍', '2026-09-14T12:00:03Z'),
      r(ME, '👍', '2026-09-14T12:00:04Z'), // duplicate row collapses
      r(ANA, '😂', '2026-09-14T12:00:00Z', 'other'),
    ];
    expect(aggregateReactions(rows, 'm1', ME)).toEqual([
      { emoji: '👍', count: 2, mine: true, userIds: [ME, BRUNO] },
      { emoji: '❤️', count: 1, mine: false, userIds: [ANA] },
    ]);
    expect(aggregateReactions(rows, 'none', ME)).toEqual([]);
  });

  it('exposes the six quick reactions', () => {
    expect(QUICK_REACTIONS).toEqual(['👍', '❤️', '😂', '😮', '😢', '🙏']);
  });
});

describe('toggleReactionRows', () => {
  it('adds when absent and removes when present', () => {
    const start: ChatMessageReaction[] = [r(ANA, '👍', '2026-09-14T12:00:00Z')];
    const added = toggleReactionRows(start, 'm1', ME, '👍', '2026-09-14T12:00:05Z');
    expect(added.added).toBe(true);
    expect(hasReaction(added.next, 'm1', ME, '👍')).toBe(true);
    expect(added.next).toHaveLength(2);
    const removed = toggleReactionRows(added.next, 'm1', ME, '👍');
    expect(removed.added).toBe(false);
    expect(removed.next).toEqual(start);
  });
});

describe('mergeReactions / removeReaction', () => {
  it('dedupes on (message, user, emoji) and removes exactly one key', () => {
    const a = r(ANA, '👍', '2026-09-14T12:00:00Z');
    const merged = mergeReactions([a], [{ ...a, created_at: '2026-09-14T12:00:09Z' }, r(ME, '❤️', '2026-09-14T12:00:01Z')]);
    expect(merged).toHaveLength(2);
    expect(merged[0].created_at).toBe('2026-09-14T12:00:09Z');
    expect(removeReaction(merged, { message_id: 'm1', user_id: ANA, emoji: '👍' })).toEqual([
      r(ME, '❤️', '2026-09-14T12:00:01Z'),
    ]);
  });
});
