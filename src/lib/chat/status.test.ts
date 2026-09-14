import { describe, expect, it } from 'vitest';

import type { ChatMember, ChatMessage, ChatThread } from '@/types';

import {
  buildPeopleRows,
  countUnread,
  dayKey,
  describeLastSeen,
  filterPeopleRows,
  groupMessagesByDay,
  isUnreadFor,
  memberDisplayName,
  messageStatus,
  otherMemberId,
  unreadByThread,
} from './status';

const ME = 'user-me';
const ANA = 'user-ana';
const BRUNO = 'user-bruno';

function msg(over: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    account_id: 'acc',
    thread_id: 't1',
    sender_id: ANA,
    body: 'hi',
    created_at: '2026-09-14T12:00:00.000Z',
    delivered_at: null,
    read_at: null,
    edited_at: null,
    deleted_at: null,
    attachment: null,
    ...over,
  };
}

function member(user_id: string, full_name: string | null, email = `${user_id}@x.io`): ChatMember {
  return { user_id, full_name, email, avatar_url: null, last_seen_at: null };
}

function thread(over: Partial<ChatThread> & { id: string }): ChatThread {
  return {
    account_id: 'acc',
    kind: 'direct',
    title: null,
    created_by: ME,
    direct_user_a: null,
    direct_user_b: null,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    last_message_at: null,
    last_message_preview: null,
    ...over,
  };
}

describe('messageStatus', () => {
  it('reads the receipts in order: read > delivered > sent', () => {
    expect(messageStatus({ delivered_at: null, read_at: null })).toBe('sent');
    expect(messageStatus({ delivered_at: '2026-09-14T12:00:01Z', read_at: null })).toBe('delivered');
    expect(messageStatus({ delivered_at: '2026-09-14T12:00:01Z', read_at: '2026-09-14T12:00:02Z' })).toBe('read');
    // read without delivered (should not happen — the trigger fills it) still reads as read
    expect(messageStatus({ delivered_at: null, read_at: '2026-09-14T12:00:02Z' })).toBe('read');
  });
});

describe('unread', () => {
  const messages = [
    msg({ id: 'a', thread_id: 't1', sender_id: ANA }),
    msg({ id: 'b', thread_id: 't1', sender_id: ANA, read_at: '2026-09-14T12:01:00Z' }),
    msg({ id: 'c', thread_id: 't1', sender_id: ME }),
    msg({ id: 'd', thread_id: 't2', sender_id: BRUNO }),
    msg({ id: 'e', thread_id: 't2', sender_id: BRUNO, delivered_at: '2026-09-14T12:01:00Z' }),
  ];

  it('counts only messages addressed to me without a read receipt', () => {
    expect(isUnreadFor(messages[0], ME)).toBe(true);
    expect(isUnreadFor(messages[1], ME)).toBe(false);
    expect(isUnreadFor(messages[2], ME)).toBe(false);
    expect(countUnread(messages, ME)).toBe(3);
  });

  it('groups per thread and omits threads with nothing unread', () => {
    const map = unreadByThread(messages, ME);
    expect(map.get('t1')).toBe(1);
    expect(map.get('t2')).toBe(2);
    expect(map.has('t3')).toBe(false);
    // From Ana's point of view only my message in t1 is unread.
    expect(countUnread(messages, ANA)).toBe(3); // c (mine) + d + e (Bruno's)
    expect(unreadByThread(messages, ANA).get('t1')).toBe(1);
  });
});

describe('groupMessagesByDay', () => {
  it('splits consecutive runs by local calendar day', () => {
    const d1 = new Date(2026, 8, 13, 9, 0).toISOString();
    const d1b = new Date(2026, 8, 13, 23, 59).toISOString();
    const d2 = new Date(2026, 8, 14, 0, 1).toISOString();
    const groups = groupMessagesByDay([
      msg({ id: '1', created_at: d1 }),
      msg({ id: '2', created_at: d1b }),
      msg({ id: '3', created_at: d2 }),
    ]);
    expect(groups.map((g) => g.messages.map((m) => m.id))).toEqual([['1', '2'], ['3']]);
    expect(groups[0].day).toBe(dayKey(d1));
    expect(groups[0].at).toBe(d1);
    expect(groups[1].day).toBe('2026-09-14');
  });

  it('returns no groups for an empty list', () => {
    expect(groupMessagesByDay([])).toEqual([]);
  });
});

describe('describeLastSeen', () => {
  const now = Date.parse('2026-09-14T12:00:00.000Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it('never / now / minutes / hours / days / weeks / long', () => {
    expect(describeLastSeen(null, now)).toEqual({ kind: 'never' });
    expect(describeLastSeen('garbage', now)).toEqual({ kind: 'never' });
    expect(describeLastSeen(ago(20_000), now)).toEqual({ kind: 'now' });
    expect(describeLastSeen(ago(5 * 60_000), now)).toEqual({ kind: 'minutes', n: 5 });
    expect(describeLastSeen(ago(3 * 3_600_000), now)).toEqual({ kind: 'hours', n: 3 });
    expect(describeLastSeen(ago(2 * 86_400_000), now)).toEqual({ kind: 'days', n: 2 });
    expect(describeLastSeen(ago(15 * 86_400_000), now)).toEqual({ kind: 'weeks', n: 2 });
    expect(describeLastSeen(ago(45 * 86_400_000), now)).toEqual({ kind: 'long' });
  });

  it('treats a future timestamp (clock skew) as now', () => {
    expect(describeLastSeen(new Date(now + 60_000).toISOString(), now)).toEqual({ kind: 'now' });
  });
});

describe('people rows', () => {
  const members = [
    member(ME, 'Eu'),
    member(ANA, 'Ana Souza'),
    member(BRUNO, null, 'bruno.lima@x.io'),
    member('user-carla', 'Carla'),
  ];
  const threads = [
    thread({
      id: 't-ana',
      direct_user_a: ANA,
      direct_user_b: ME,
      last_message_at: '2026-09-14T10:00:00Z',
      last_message_preview: 'até logo',
    }),
    thread({
      id: 't-bruno',
      direct_user_a: BRUNO,
      direct_user_b: ME,
      last_message_at: '2026-09-14T11:00:00Z',
      last_message_preview: 'bom dia',
    }),
    // A thread I am not part of must never be matched.
    thread({ id: 't-other', direct_user_a: ANA, direct_user_b: BRUNO, last_message_at: '2026-09-14T12:00:00Z' }),
  ];

  it('excludes me, joins threads + unread and sorts by activity then name', () => {
    const unread = new Map([['t-ana', 2]]);
    const rows = buildPeopleRows(members, threads, unread, ME);
    expect(rows.map((r) => r.member.user_id)).toEqual([BRUNO, ANA, 'user-carla']);
    expect(rows[0].preview).toBe('bom dia');
    expect(rows[0].unread).toBe(0);
    expect(rows[1].unread).toBe(2);
    expect(rows[1].thread?.id).toBe('t-ana');
    expect(rows[2].thread).toBeNull();
    expect(rows[2].lastMessageAt).toBeNull();
  });

  it('orders people without history by name', () => {
    const rows = buildPeopleRows(members, [], new Map(), ME);
    expect(rows.map((r) => memberDisplayName(r.member))).toEqual(['Ana Souza', 'bruno.lima', 'Carla']);
  });

  it('falls back to the email local part as the display name', () => {
    expect(memberDisplayName(member(BRUNO, null, 'bruno.lima@x.io'))).toBe('bruno.lima');
    expect(memberDisplayName(member(BRUNO, '  ', 'nope'))).toBe('nope');
  });

  it('finds the other side of a direct thread', () => {
    expect(otherMemberId(threads[0], ME)).toBe(ANA);
    expect(otherMemberId(threads[0], ANA)).toBe(ME);
    expect(otherMemberId(threads[2], ME)).toBeNull();
  });

  it('filters by name or email, ignoring case and accents', () => {
    const rows = buildPeopleRows(members, threads, new Map(), ME);
    expect(filterPeopleRows(rows, 'SOUZA').map((r) => r.member.user_id)).toEqual([ANA]);
    expect(filterPeopleRows(rows, 'lima@').map((r) => r.member.user_id)).toEqual([BRUNO]);
    expect(filterPeopleRows(rows, 'cárla').map((r) => r.member.user_id)).toEqual(['user-carla']);
    expect(filterPeopleRows(rows, '   ')).toHaveLength(3);
  });
});
