// ============================================================
// Internal chat — groups (phase 2, migration 039). Pure helpers.
//
//   expectedRecipients    members a group message is addressed to
//   groupMessageStatus    sent / delivered / read from per-member receipts
//   receiptRows           "Read by / Delivered to" popover data
//   parseSystemEvent      JSON body of a `kind: 'system'` message
//   canManageGroup        creator or account admin+
//   buildGroupRows        group threads → list rows
//   buildChatRows         people + groups, sorted by activity
//   filterChatRows        search box over both kinds
// ============================================================

import type { AccountRole } from '@/lib/auth/roles';
import type {
  ChatMember,
  ChatMessage,
  ChatMessageReceipt,
  ChatMessageStatus,
  ChatSystemEvent,
  ChatThread,
  ChatThreadMember,
} from '@/types';

import { buildPeopleRows, memberDisplayName, type ChatPersonRow } from './status';

// ------------------------------------------------------------
// Receipts
// ------------------------------------------------------------

/**
 * The members a group message counts as addressed to: everyone but the
 * sender who was already in the group when it was sent. Someone added
 * later never stamps a receipt for it, so they must not hold the ✓✓
 * back forever. A member who left and came back keeps a newer
 * `joined_at`, so anyone holding a receipt for the message is counted
 * regardless — a receipt is proof it reached them.
 */
export function expectedRecipients(
  message: Pick<ChatMessage, 'id' | 'sender_id' | 'created_at'>,
  members: readonly Pick<ChatThreadMember, 'user_id' | 'joined_at'>[],
  receipts: readonly Pick<ChatMessageReceipt, 'message_id' | 'user_id'>[] = [],
): string[] {
  const sentAt = new Date(message.created_at).getTime();
  const stamped = new Set<string>();
  for (const r of receipts) if (r.message_id === message.id) stamped.add(r.user_id);
  const out: string[] = [];
  for (const m of members) {
    if (m.user_id === message.sender_id) continue;
    const joined = new Date(m.joined_at).getTime();
    if (stamped.has(m.user_id) || Number.isNaN(joined) || Number.isNaN(sentAt) || joined <= sentAt) {
      out.push(m.user_id);
    }
  }
  return out;
}

/**
 * ✓ sent, ✓✓ when every expected recipient has a delivered receipt,
 * ✓✓ blue when every one has a read receipt. A group with nobody
 * else in it stays at `sent`.
 */
export function groupMessageStatus(
  message: Pick<ChatMessage, 'id' | 'sender_id' | 'created_at'>,
  receipts: readonly Pick<ChatMessageReceipt, 'message_id' | 'user_id' | 'delivered_at' | 'read_at'>[],
  members: readonly Pick<ChatThreadMember, 'user_id' | 'joined_at'>[],
): ChatMessageStatus {
  const expected = expectedRecipients(message, members, receipts);
  if (expected.length === 0) return 'sent';
  const byUser = new Map<string, Pick<ChatMessageReceipt, 'delivered_at' | 'read_at'>>();
  for (const r of receipts) if (r.message_id === message.id) byUser.set(r.user_id, r);
  let allRead = true;
  let allDelivered = true;
  for (const uid of expected) {
    const r = byUser.get(uid);
    if (!r?.read_at) allRead = false;
    if (!r?.delivered_at && !r?.read_at) allDelivered = false;
    if (!allRead && !allDelivered) break;
  }
  if (allRead) return 'read';
  if (allDelivered) return 'delivered';
  return 'sent';
}

export interface ChatReceiptRow {
  user_id: string;
  delivered_at: string | null;
  read_at: string | null;
}

/** One row per expected recipient (missing receipts show as pending), read first. */
export function receiptRows(
  message: Pick<ChatMessage, 'id' | 'sender_id' | 'created_at'>,
  receipts: readonly Pick<ChatMessageReceipt, 'message_id' | 'user_id' | 'delivered_at' | 'read_at'>[],
  members: readonly Pick<ChatThreadMember, 'user_id' | 'joined_at'>[],
): ChatReceiptRow[] {
  const byUser = new Map<string, Pick<ChatMessageReceipt, 'delivered_at' | 'read_at'>>();
  for (const r of receipts) if (r.message_id === message.id) byUser.set(r.user_id, r);
  const rows = expectedRecipients(message, members, receipts).map((uid) => {
    const r = byUser.get(uid);
    const read = r?.read_at ?? null;
    return { user_id: uid, delivered_at: r?.delivered_at ?? read, read_at: read };
  });
  const rank = (r: ChatReceiptRow) => (r.read_at ? 0 : r.delivered_at ? 1 : 2);
  return rows.sort((a, b) => rank(a) - rank(b));
}

// ------------------------------------------------------------
// System lines
// ------------------------------------------------------------

const SYSTEM_EVENTS = new Set(['created', 'added', 'removed', 'left']);

/** Parse the JSON body of a system message; null when malformed. */
export function parseSystemEvent(body: string): ChatSystemEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const event = (raw as { event?: unknown }).event;
  if (typeof event !== 'string' || !SYSTEM_EVENTS.has(event)) return null;
  if (event === 'added' || event === 'removed') {
    const users = (raw as { users?: unknown }).users;
    if (!Array.isArray(users)) return null;
    return { event, users: users.filter((u): u is string => typeof u === 'string') };
  }
  return { event: event as 'created' | 'left' };
}

// ------------------------------------------------------------
// Permissions
// ------------------------------------------------------------

/** The creator or an account admin / owner manages the member list. */
export function canManageGroup(
  thread: Pick<ChatThread, 'kind' | 'created_by'>,
  userId: string,
  accountRole: AccountRole | null | undefined,
): boolean {
  if (thread.kind !== 'group') return false;
  if (thread.created_by === userId) return true;
  return accountRole === 'owner' || accountRole === 'admin';
}

/** Member ids of a thread (embedded rows), excluding nobody. */
export function threadMemberIds(thread: Pick<ChatThread, 'members'>): string[] {
  return (thread.members ?? []).map((m) => m.user_id);
}

// ------------------------------------------------------------
// List rows
// ------------------------------------------------------------

export interface ChatGroupRow {
  thread: ChatThread;
  title: string;
  memberCount: number;
  unread: number;
  lastMessageAt: string | null;
  preview: string | null;
}

export type ChatListRow =
  | { kind: 'person'; key: string; row: ChatPersonRow }
  | { kind: 'group'; key: string; row: ChatGroupRow };

export function buildGroupRows(
  threads: readonly ChatThread[],
  unread: ReadonlyMap<string, number>,
): ChatGroupRow[] {
  const rows: ChatGroupRow[] = [];
  for (const t of threads) {
    if (t.kind !== 'group') continue;
    rows.push({
      thread: t,
      title: t.title?.trim() || 'Group',
      memberCount: t.members?.length ?? 0,
      unread: unread.get(t.id) ?? 0,
      lastMessageAt: t.last_message_at ?? null,
      preview: t.last_message_preview ?? null,
    });
  }
  return rows;
}

function rowActivity(r: ChatListRow): number {
  const at = r.row.lastMessageAt;
  return at ? new Date(at).getTime() : 0;
}

function rowName(r: ChatListRow): string {
  return r.kind === 'person' ? memberDisplayName(r.row.member) : r.row.title;
}

/**
 * People (minus me) and my groups in one list, newest activity first,
 * then by name; rows with no history sit after everything with one.
 */
export function buildChatRows(
  members: readonly ChatMember[],
  threads: readonly ChatThread[],
  unread: ReadonlyMap<string, number>,
  userId: string,
): ChatListRow[] {
  const rows: ChatListRow[] = [
    ...buildPeopleRows(members, threads, unread, userId).map(
      (row): ChatListRow => ({ kind: 'person', key: `p:${row.member.user_id}`, row }),
    ),
    ...buildGroupRows(threads, unread).map(
      (row): ChatListRow => ({ kind: 'group', key: `g:${row.thread.id}`, row }),
    ),
  ];
  return rows.sort((a, b) => {
    const ta = rowActivity(a);
    const tb = rowActivity(b);
    if (ta !== tb) return tb - ta;
    return rowName(a).localeCompare(rowName(b), undefined, { sensitivity: 'base' });
  });
}

/** Case- and accent-insensitive filter over names, emails and group titles. */
export function filterChatRows(rows: readonly ChatListRow[], query: string): ChatListRow[] {
  const q = normalize(query);
  if (!q) return [...rows];
  return rows.filter((r) =>
    r.kind === 'person'
      ? normalize(memberDisplayName(r.row.member)).includes(q) || normalize(r.row.member.email).includes(q)
      : normalize(r.row.title).includes(q),
  );
}

function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .trim();
}
