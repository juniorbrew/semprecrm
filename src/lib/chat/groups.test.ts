import { describe, expect, it } from 'vitest';

import type { ChatMember, ChatMessageReceipt, ChatThread, ChatThreadMember } from '@/types';

import {
  buildChatRows,
  buildGroupRows,
  canManageGroup,
  expectedRecipients,
  filterChatRows,
  groupMessageStatus,
  parseSystemEvent,
  receiptRows,
} from './groups';

const ME = 'user-me';
const ANA = 'user-ana';
const BRUNO = 'user-bruno';
const CARLA = 'user-carla';

const T0 = '2026-09-14T12:00:00.000Z';

function mem(user_id: string, joined_at = '2026-09-14T11:00:00.000Z'): ChatThreadMember {
  return { thread_id: 'g1', user_id, joined_at, last_read_at: null };
}

function receipt(user_id: string, over: Partial<ChatMessageReceipt> = {}): ChatMessageReceipt {
  return { message_id: 'm1', user_id, thread_id: 'g1', delivered_at: null, read_at: null, ...over };
}

const message = { id: 'm1', sender_id: ME, created_at: T0 };
const members = [mem(ME), mem(ANA), mem(BRUNO)];

describe('expectedRecipients', () => {
  it('is everyone but the sender who was already in the group', () => {
    expect(expectedRecipients(message, members)).toEqual([ANA, BRUNO]);
    // Carla joined after the message was sent — not expected to receipt it.
    expect(expectedRecipients(message, [...members, mem(CARLA, '2026-09-14T12:30:00.000Z')])).toEqual([ANA, BRUNO]);
    // Joined at the same instant counts as present.
    expect(expectedRecipients(message, [...members, mem(CARLA, T0)])).toEqual([ANA, BRUNO, CARLA]);
  });

  it('keeps a member who left and rejoined when they hold a receipt for the message', () => {
    // Bruno's joined_at is now after the message, but his receipt proves it reached him.
    const rejoined = [mem(ME), mem(ANA), mem(BRUNO, '2026-09-14T13:00:00.000Z')];
    expect(expectedRecipients(message, rejoined)).toEqual([ANA]);
    expect(expectedRecipients(message, rejoined, [receipt(BRUNO, { delivered_at: T0 })])).toEqual([ANA, BRUNO]);
    // A receipt for another message does not count.
    expect(expectedRecipients(message, rejoined, [{ ...receipt(BRUNO), message_id: 'm2' }])).toEqual([ANA]);
    expect(
      groupMessageStatus(
        message,
        [receipt(ANA, { delivered_at: T0, read_at: T0 }), receipt(BRUNO, { delivered_at: T0, read_at: T0 })],
        rejoined,
      ),
    ).toBe('read');
    expect(receiptRows(message, [receipt(BRUNO, { delivered_at: T0 })], rejoined).map((r) => r.user_id)).toEqual([BRUNO, ANA]);
  });
});

describe('groupMessageStatus', () => {
  it('is sent until every other member delivered, read when every one read', () => {
    expect(groupMessageStatus(message, [], members)).toBe('sent');
    expect(groupMessageStatus(message, [receipt(ANA, { delivered_at: T0 })], members)).toBe('sent');
    expect(
      groupMessageStatus(message, [receipt(ANA, { delivered_at: T0 }), receipt(BRUNO, { delivered_at: T0 })], members),
    ).toBe('delivered');
    expect(
      groupMessageStatus(
        message,
        [receipt(ANA, { delivered_at: T0, read_at: T0 }), receipt(BRUNO, { delivered_at: T0 })],
        members,
      ),
    ).toBe('delivered');
    expect(
      groupMessageStatus(
        message,
        [receipt(ANA, { delivered_at: T0, read_at: T0 }), receipt(BRUNO, { read_at: T0 })],
        members,
      ),
    ).toBe('read');
  });

  it('ignores receipts of other messages and stays sent in an empty group', () => {
    expect(
      groupMessageStatus(message, [receipt(ANA, { message_id: 'other', read_at: T0 }), receipt(BRUNO, { read_at: T0 })], members),
    ).toBe('sent');
    expect(groupMessageStatus(message, [], [mem(ME)])).toBe('sent');
  });

  it('does not wait for members who joined after the message', () => {
    const late = [...members, mem(CARLA, '2026-09-14T13:00:00.000Z')];
    expect(groupMessageStatus(message, [receipt(ANA, { read_at: T0 }), receipt(BRUNO, { read_at: T0 })], late)).toBe('read');
  });
});

describe('receiptRows', () => {
  it('lists every expected recipient, read first, then delivered, then pending', () => {
    const rows = receiptRows(
      message,
      [receipt(BRUNO, { read_at: '2026-09-14T12:02:00.000Z' }), receipt(ANA, { delivered_at: '2026-09-14T12:01:00.000Z' })],
      [...members, mem(CARLA)],
    );
    expect(rows.map((r) => r.user_id)).toEqual([BRUNO, ANA, CARLA]);
    // read implies delivered for the popover even if the row lacks it
    expect(rows[0].delivered_at).toBe('2026-09-14T12:02:00.000Z');
    expect(rows[2]).toEqual({ user_id: CARLA, delivered_at: null, read_at: null });
  });
});

describe('parseSystemEvent', () => {
  it('parses the four events and rejects anything else', () => {
    expect(parseSystemEvent('{"event":"created"}')).toEqual({ event: 'created' });
    expect(parseSystemEvent('{"event":"left"}')).toEqual({ event: 'left' });
    expect(parseSystemEvent('{"event":"added","users":["a","b",3]}')).toEqual({ event: 'added', users: ['a', 'b'] });
    expect(parseSystemEvent('{"event":"removed","users":["a"]}')).toEqual({ event: 'removed', users: ['a'] });
    expect(parseSystemEvent('{"event":"added"}')).toBeNull();
    expect(parseSystemEvent('{"event":"boom"}')).toBeNull();
    expect(parseSystemEvent('not json')).toBeNull();
    expect(parseSystemEvent('null')).toBeNull();
  });
});

describe('canManageGroup', () => {
  const group = { kind: 'group' as const, created_by: ANA };
  it('creator or admin+ manage; agents cannot; never on direct threads', () => {
    expect(canManageGroup(group, ANA, 'agent')).toBe(true);
    expect(canManageGroup(group, ME, 'agent')).toBe(false);
    expect(canManageGroup(group, ME, 'admin')).toBe(true);
    expect(canManageGroup(group, ME, 'owner')).toBe(true);
    expect(canManageGroup(group, ME, null)).toBe(false);
    expect(canManageGroup({ kind: 'direct', created_by: ME }, ME, 'owner')).toBe(false);
  });
});

function member(user_id: string, full_name: string | null): ChatMember {
  return { user_id, full_name, email: `${user_id}@x.io`, avatar_url: null, last_seen_at: null };
}

function thread(over: Partial<ChatThread> & { id: string }): ChatThread {
  return {
    account_id: 'acc',
    kind: 'group',
    title: 'Equipe',
    created_by: ME,
    direct_user_a: null,
    direct_user_b: null,
    created_at: T0,
    updated_at: T0,
    last_message_at: null,
    last_message_preview: null,
    members: [],
    ...over,
  };
}

describe('list rows', () => {
  const members = [member(ME, 'Me'), member(ANA, 'Ana'), member(BRUNO, 'Bruno')];
  const direct = thread({
    id: 'd1',
    kind: 'direct',
    title: null,
    direct_user_a: ME < ANA ? ME : ANA,
    direct_user_b: ME < ANA ? ANA : ME,
    last_message_at: '2026-09-14T12:10:00.000Z',
    last_message_preview: 'oi',
    members: [mem(ME), mem(ANA)],
  });
  const group = thread({
    id: 'g1',
    last_message_at: '2026-09-14T12:20:00.000Z',
    last_message_preview: '📎 Anexo',
    members: [mem(ME), mem(ANA), mem(BRUNO)],
  });
  const quiet = thread({ id: 'g2', title: '  ', members: [mem(ME), mem(ANA)] });

  it('builds group rows with member count, unread and a fallback title', () => {
    const rows = buildGroupRows([direct, group, quiet], new Map([['g1', 4]]));
    expect(rows.map((r) => r.thread.id)).toEqual(['g1', 'g2']);
    expect(rows[0]).toMatchObject({ title: 'Equipe', memberCount: 3, unread: 4, preview: '📎 Anexo' });
    expect(rows[1]).toMatchObject({ title: 'Group', memberCount: 2, unread: 0 });
  });

  it('merges people and groups by activity, then name; idle rows last', () => {
    const rows = buildChatRows(members, [direct, group, quiet], new Map([['d1', 1]]), ME);
    expect(rows.map((r) => r.key)).toEqual(['g:g1', `p:${ANA}`, `p:${BRUNO}`, 'g:g2']);
    const ana = rows[1];
    expect(ana.kind === 'person' && ana.row.unread).toBe(1);
  });

  it('filters by name, email or group title (accent-insensitive)', () => {
    const rows = buildChatRows(members, [direct, group, quiet], new Map(), ME);
    expect(filterChatRows(rows, 'EQUIPE').map((r) => r.key)).toEqual(['g:g1']);
    expect(filterChatRows(rows, 'brúno').map((r) => r.key)).toEqual([`p:${BRUNO}`]);
    expect(filterChatRows(rows, 'x.io').length).toBe(2);
    expect(filterChatRows(rows, '').length).toBe(4);
  });
});
