// ============================================================
// Internal chat — pure helpers (no I/O, no React).
//
//   messageStatus       sent / delivered / read from the receipt columns
//   CHAT_STATUS_LABELS  English labels (go through `t()` in the UI)
//   unreadByThread      per-thread unread counts for the list badges
//   countUnread         total for the sidebar badge
//   groupMessagesByDay  day separators for the history
//   describeLastSeen    "last seen X ago" as data (the UI words it)
//   buildPeopleRows     members + threads + unread → sorted list rows
// ============================================================

import type { ChatMember, ChatMessage, ChatMessageStatus, ChatThread } from '@/types';

// ------------------------------------------------------------
// Message status
// ------------------------------------------------------------

/** Read wins over delivered; a message with neither receipt is `sent`. */
export function messageStatus(
  message: Pick<ChatMessage, 'delivered_at' | 'read_at'>,
): ChatMessageStatus {
  if (message.read_at) return 'read';
  if (message.delivered_at) return 'delivered';
  return 'sent';
}

/** English labels — the UI calls `t()` on them. */
export const CHAT_STATUS_LABELS: Record<ChatMessageStatus, string> = {
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
};

// ------------------------------------------------------------
// Edit / delete rules (phase 2 — mirrored by the DB trigger)
// ------------------------------------------------------------

/** A message can be edited for 15 minutes after it was sent. */
export const CHAT_EDIT_WINDOW_MS = 15 * 60 * 1000;

/** Own, text, not deleted, and still inside the edit window. */
export function canEditMessage(
  message: Pick<ChatMessage, 'sender_id' | 'kind' | 'created_at' | 'deleted_at'>,
  userId: string,
  now: number = Date.now(),
): boolean {
  if (message.sender_id !== userId) return false;
  if (message.kind !== 'text' || message.deleted_at) return false;
  const created = new Date(message.created_at).getTime();
  if (Number.isNaN(created)) return false;
  return now - created <= CHAT_EDIT_WINDOW_MS;
}

/** Own text message that is not deleted yet (no time limit). */
export function canDeleteMessage(
  message: Pick<ChatMessage, 'sender_id' | 'kind' | 'deleted_at'>,
  userId: string,
): boolean {
  return message.sender_id === userId && message.kind === 'text' && !message.deleted_at;
}

// ------------------------------------------------------------
// Unread
// ------------------------------------------------------------

/**
 * True when `message` is addressed to `userId` and has no read receipt
 * (direct threads). System lines and deleted messages never count.
 */
export function isUnreadFor(
  message: Pick<ChatMessage, 'sender_id' | 'read_at'> & Partial<Pick<ChatMessage, 'kind' | 'deleted_at'>>,
  userId: string,
): boolean {
  if (message.kind && message.kind !== 'text') return false;
  if (message.deleted_at) return false;
  return message.sender_id !== userId && !message.read_at;
}

/** Unread count per thread id (threads with zero unread are absent). */
export function unreadByThread(
  messages: readonly Pick<ChatMessage, 'thread_id' | 'sender_id' | 'read_at'>[],
  userId: string,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of messages) {
    if (!isUnreadFor(m, userId)) continue;
    out.set(m.thread_id, (out.get(m.thread_id) ?? 0) + 1);
  }
  return out;
}

/** Total unread for the sidebar badge. */
export function countUnread(
  messages: readonly Pick<ChatMessage, 'thread_id' | 'sender_id' | 'read_at'>[],
  userId: string,
): number {
  let n = 0;
  for (const m of messages) if (isUnreadFor(m, userId)) n++;
  return n;
}

// ------------------------------------------------------------
// Day grouping
// ------------------------------------------------------------

/** Local calendar day key (`YYYY-MM-DD`) of an ISO timestamp. */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export interface ChatDayGroup<T> {
  /** `YYYY-MM-DD` in local time. */
  day: string;
  /** ISO of the first message of the day (for the separator label). */
  at: string;
  messages: T[];
}

/**
 * Split an ascending message list into consecutive day groups. The
 * input is expected sorted by `created_at`; an unsorted list still
 * yields groups, just in encounter order.
 */
export function groupMessagesByDay<T extends Pick<ChatMessage, 'created_at'>>(
  messages: readonly T[],
): ChatDayGroup<T>[] {
  const groups: ChatDayGroup<T>[] = [];
  for (const m of messages) {
    const day = dayKey(m.created_at);
    const last = groups[groups.length - 1];
    if (last && last.day === day) {
      last.messages.push(m);
    } else {
      groups.push({ day, at: m.created_at, messages: [m] });
    }
  }
  return groups;
}

// ------------------------------------------------------------
// Last seen
// ------------------------------------------------------------

export type LastSeen =
  | { kind: 'never' }
  | { kind: 'now' }
  | { kind: 'minutes'; n: number }
  | { kind: 'hours'; n: number }
  | { kind: 'days'; n: number }
  | { kind: 'weeks'; n: number }
  | { kind: 'long' };

/**
 * "Last seen X ago" as structured data so the UI can word it in the
 * viewer's language. Under a minute reads as `now` (the heartbeat is
 * every 30 s, so anything fresher than that is effectively online).
 */
export function describeLastSeen(iso: string | null | undefined, now: number = Date.now()): LastSeen {
  if (!iso) return { kind: 'never' };
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return { kind: 'never' };
  const sec = Math.max(0, Math.round((now - then) / 1000));
  if (sec < 60) return { kind: 'now' };
  const min = Math.floor(sec / 60);
  if (min < 60) return { kind: 'minutes', n: min };
  const h = Math.floor(min / 60);
  if (h < 24) return { kind: 'hours', n: h };
  const d = Math.floor(h / 24);
  if (d < 7) return { kind: 'days', n: d };
  if (d < 30) return { kind: 'weeks', n: Math.floor(d / 7) };
  return { kind: 'long' };
}

// ------------------------------------------------------------
// People rows (left column)
// ------------------------------------------------------------

export interface ChatPersonRow {
  member: ChatMember;
  /** The direct thread with this person, if one exists yet. */
  thread: ChatThread | null;
  unread: number;
  lastMessageAt: string | null;
  preview: string | null;
}

/** Display name: full name, else the part of the email before `@`. */
export function memberDisplayName(member: Pick<ChatMember, 'full_name' | 'email'>): string {
  const name = member.full_name?.trim();
  if (name) return name;
  const at = member.email.indexOf('@');
  return at > 0 ? member.email.slice(0, at) : member.email;
}

/** The other member of a direct thread (null on malformed rows). */
export function otherMemberId(
  thread: Pick<ChatThread, 'direct_user_a' | 'direct_user_b'>,
  userId: string,
): string | null {
  if (thread.direct_user_a === userId) return thread.direct_user_b;
  if (thread.direct_user_b === userId) return thread.direct_user_a;
  return null;
}

/**
 * Join the account's members (minus me) with my direct threads and the
 * unread map into the rows the left column renders. Sorted by last
 * activity (newest first), then by display name; people with no
 * thread yet sit after everyone with history.
 */
export function buildPeopleRows(
  members: readonly ChatMember[],
  threads: readonly ChatThread[],
  unread: ReadonlyMap<string, number>,
  userId: string,
): ChatPersonRow[] {
  const threadByOther = new Map<string, ChatThread>();
  for (const t of threads) {
    if (t.kind !== 'direct') continue;
    const other = otherMemberId(t, userId);
    if (other) threadByOther.set(other, t);
  }
  const rows: ChatPersonRow[] = [];
  for (const member of members) {
    if (member.user_id === userId) continue;
    const thread = threadByOther.get(member.user_id) ?? null;
    rows.push({
      member,
      thread,
      unread: thread ? unread.get(thread.id) ?? 0 : 0,
      lastMessageAt: thread?.last_message_at ?? null,
      preview: thread?.last_message_preview ?? null,
    });
  }
  return sortPeopleRows(rows);
}

export function sortPeopleRows(rows: ChatPersonRow[]): ChatPersonRow[] {
  return [...rows].sort((a, b) => {
    const ta = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
    const tb = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
    if (ta !== tb) return tb - ta;
    return memberDisplayName(a.member).localeCompare(memberDisplayName(b.member), undefined, {
      sensitivity: 'base',
    });
  });
}

/** Case- and accent-insensitive name / email filter for the search box. */
export function filterPeopleRows(rows: readonly ChatPersonRow[], query: string): ChatPersonRow[] {
  const q = normalize(query);
  if (!q) return [...rows];
  return rows.filter(
    (r) => normalize(memberDisplayName(r.member)).includes(q) || normalize(r.member.email).includes(q),
  );
}

function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}
