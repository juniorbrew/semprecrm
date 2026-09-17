import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '@/types';

import { CHAT_PAGE_SIZE, compareMessages, mergeMessages, toPage } from './queries';

function msg(id: string, createdAt: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    account_id: 'acc',
    thread_id: 't1',
    sender_id: 'u1',
    body: id,
    kind: 'text',
    created_at: createdAt,
    delivered_at: null,
    read_at: null,
    edited_at: null,
    deleted_at: null,
    attachment: null,
    ...over,
  };
}

/** `n` rows newest-first, one second apart, ending at `base`. */
function newestFirst(n: number, base = Date.parse('2026-09-14T12:00:00.000Z')): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => msg(`m${n - i}`, new Date(base - i * 1000).toISOString()));
}

describe('toPage', () => {
  it('flips a full page to ascending, flags more, and exposes the oldest as cursor', () => {
    const rows = newestFirst(CHAT_PAGE_SIZE + 1);
    const page = toPage(rows, CHAT_PAGE_SIZE);
    expect(page.messages).toHaveLength(CHAT_PAGE_SIZE);
    expect(page.hasMore).toBe(true);
    // Ascending: first is the oldest of the kept slice.
    expect(page.messages[0].id).toBe('m2');
    expect(page.messages[CHAT_PAGE_SIZE - 1].id).toBe(`m${CHAT_PAGE_SIZE + 1}`);
    expect(page.nextCursor).toBe(page.messages[0].created_at);
    // The sentinel row (the oldest, m1) is not part of the page.
    expect(page.messages.some((m) => m.id === 'm1')).toBe(false);
  });

  it('a short page has no more and keeps every row', () => {
    const page = toPage(newestFirst(3), CHAT_PAGE_SIZE);
    expect(page.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBe(page.messages[0].created_at);
  });

  it('exactly `limit` rows means no more (the +1 sentinel is absent)', () => {
    const page = toPage(newestFirst(CHAT_PAGE_SIZE), CHAT_PAGE_SIZE);
    expect(page.messages).toHaveLength(CHAT_PAGE_SIZE);
    expect(page.hasMore).toBe(false);
  });

  it('empty input → empty page, null cursor', () => {
    expect(toPage([], CHAT_PAGE_SIZE)).toEqual({ messages: [], hasMore: false, nextCursor: null });
  });

  it('does not mutate the input', () => {
    const rows = newestFirst(4);
    const copy = [...rows];
    toPage(rows, 2);
    expect(rows).toEqual(copy);
  });
});

describe('mergeMessages', () => {
  const t = (s: number) => new Date(Date.parse('2026-09-14T12:00:00.000Z') + s * 1000).toISOString();

  it('prepends an older page ahead of the current list', () => {
    const current = [msg('c1', t(10)), msg('c2', t(11))];
    const older = [msg('o1', t(1)), msg('o2', t(2))];
    expect(mergeMessages(current, older).map((m) => m.id)).toEqual(['o1', 'o2', 'c1', 'c2']);
  });

  it('appends a realtime insert and replaces an updated row by id', () => {
    const current = [msg('a', t(1)), msg('b', t(2))];
    const withNew = mergeMessages(current, [msg('c', t(3))]);
    expect(withNew.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    const updated = mergeMessages(withNew, [msg('b', t(2), { read_at: t(5) })]);
    expect(updated).toHaveLength(3);
    expect(updated[1].read_at).toBe(t(5));
  });

  it('is stable for two rows in the same millisecond (tie-break on id)', () => {
    const a = msg('id-a', t(1));
    const b = msg('id-b', t(1));
    expect(mergeMessages([b], [a]).map((m) => m.id)).toEqual(['id-a', 'id-b']);
    expect(compareMessages(a, b)).toBeLessThan(0);
    expect(compareMessages(a, a)).toBe(0);
  });

  it('drops nothing and duplicates nothing when the same page is merged twice', () => {
    const page = newestFirst(5).reverse();
    expect(mergeMessages(mergeMessages([], page), page)).toHaveLength(5);
  });
});
