// ============================================================
// Internal chat — read side. Every function takes the Supabase
// client so the browser client (RLS-scoped) and the service-role
// client (push triggers) can share it. No `next/*` imports.
//
// Errors are thrown (as `Error` with the PostgREST message) so
// callers can `try / catch` + toast in one place.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import type { ChatMember, ChatMessage, ChatMessageReaction, ChatMessageReceipt, ChatThread } from '@/types';


/** The app's Supabase client is untyped, so this is what callers hold. */
export type ChatClient = Pick<SupabaseClient, 'from' | 'rpc'>;

/** Messages per history page (spec: 50). */
export const CHAT_PAGE_SIZE = 50;

function fail(prefix: string, error: { message: string } | null): never {
  throw new Error(`${prefix}: ${error?.message ?? 'unknown error'}`);
}

// ------------------------------------------------------------
// Members
// ------------------------------------------------------------

/** Every member of the account (profiles RLS = same account), including me. */
export async function listChatMembers(db: ChatClient, accountId: string): Promise<ChatMember[]> {
  const { data, error } = await db
    .from('profiles')
    .select('user_id, full_name, email, avatar_url, last_seen_at')
    .eq('account_id', accountId)
    .order('full_name');
  if (error) fail('Failed to load members', error);
  return (data ?? []) as ChatMember[];
}

// ------------------------------------------------------------
// Threads
// ------------------------------------------------------------

export const CHAT_THREAD_SELECT = '*, members:chat_thread_members(thread_id, user_id, joined_at, last_read_at)';

/** My threads (RLS: member only), most recent activity first. */
export async function listMyThreads(db: ChatClient): Promise<ChatThread[]> {
  const { data, error } = await db
    .from('chat_threads')
    .select(CHAT_THREAD_SELECT)
    .order('last_message_at', { ascending: false, nullsFirst: false });
  if (error) fail('Failed to load chat threads', error);
  return (data ?? []) as ChatThread[];
}

export async function getThread(db: ChatClient, threadId: string): Promise<ChatThread | null> {
  const { data, error } = await db
    .from('chat_threads')
    .select(CHAT_THREAD_SELECT)
    .eq('id', threadId)
    .maybeSingle();
  if (error) fail('Failed to load chat thread', error);
  return (data as ChatThread | null) ?? null;
}

// ------------------------------------------------------------
// Unread — chat_unread_counts() (migration 039) does the right thing
// for both thread kinds: direct → `read_at`, group → my receipt row;
// system lines, deleted rows and anything before I joined are out.
// ------------------------------------------------------------

/** Per-thread unread counts for the signed-in user, one round trip. */
export async function loadUnreadByThread(db: ChatClient): Promise<Map<string, number>> {
  const { data, error } = await db.rpc('chat_unread_counts');
  if (error) fail('Failed to load unread chat messages', error);
  const out = new Map<string, number>();
  for (const row of (data ?? []) as { thread_id: string; unread: number | string }[]) {
    const n = Number(row.unread);
    if (n > 0) out.set(row.thread_id, n);
  }
  return out;
}

/** Total unread for the sidebar badge. */
export async function countUnreadMessages(db: ChatClient): Promise<number> {
  const byThread = await loadUnreadByThread(db);
  let total = 0;
  for (const n of byThread.values()) total += n;
  return total;
}

// ------------------------------------------------------------
// Messages — cursor pagination on created_at
// ------------------------------------------------------------

export interface ChatMessagePage {
  /** Ascending by `created_at` (oldest first) — ready to render. */
  messages: ChatMessage[];
  /** True when an older page exists; pass `nextCursor` as `before`. */
  hasMore: boolean;
  /** `created_at` of the oldest message in this page (or null). */
  nextCursor: string | null;
}

/**
 * One page of a thread's history, newest `limit` messages strictly
 * before `before` (ISO `created_at`). The DB returns them newest-first
 * (index order); `toPage` flips them and works out the cursor.
 */
export async function listMessages(
  db: ChatClient,
  threadId: string,
  opts: { before?: string | null; limit?: number } = {},
): Promise<ChatMessagePage> {
  const limit = opts.limit ?? CHAT_PAGE_SIZE;
  let q = db
    .from('chat_messages')
    .select('*')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1);
  if (opts.before) q = q.lt('created_at', opts.before);
  const { data, error } = await q;
  if (error) fail('Failed to load chat messages', error);
  return toPage((data ?? []) as ChatMessage[], limit);
}

/**
 * Pure: turn a newest-first DB slice fetched with `limit + 1` into a
 * page. The extra row (if present) only signals "more" and is dropped.
 */
export function toPage(rowsNewestFirst: readonly ChatMessage[], limit: number): ChatMessagePage {
  const hasMore = rowsNewestFirst.length > limit;
  const slice = hasMore ? rowsNewestFirst.slice(0, limit) : [...rowsNewestFirst];
  const messages = slice.reverse();
  return {
    messages,
    hasMore,
    nextCursor: messages.length > 0 ? messages[0].created_at : null,
  };
}

/**
 * Pure: merge messages into an ascending list without duplicates.
 * Used for both "prepend an older page" and "append a realtime
 * insert / replace an updated row". Sorted by `created_at`, then id
 * so two rows in the same millisecond stay stable.
 */
export function mergeMessages(
  existing: readonly ChatMessage[],
  incoming: readonly ChatMessage[],
): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const m of existing) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort(compareMessages);
}

export function compareMessages(a: ChatMessage, b: ChatMessage): number {
  const ta = new Date(a.created_at).getTime();
  const tb = new Date(b.created_at).getTime();
  if (ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ------------------------------------------------------------
// Receipts / reactions for a set of messages (phase 2)
// ------------------------------------------------------------

/** Receipt rows (group threads) for the given message ids. */
export async function listReceipts(db: ChatClient, messageIds: readonly string[]): Promise<ChatMessageReceipt[]> {
  if (messageIds.length === 0) return [];
  const { data, error } = await db
    .from('chat_message_receipts')
    .select('message_id, user_id, thread_id, delivered_at, read_at')
    .in('message_id', [...messageIds]);
  if (error) fail('Failed to load receipts', error);
  return (data ?? []) as ChatMessageReceipt[];
}

/** Reaction rows for the given message ids. */
export async function listReactions(db: ChatClient, messageIds: readonly string[]): Promise<ChatMessageReaction[]> {
  if (messageIds.length === 0) return [];
  const { data, error } = await db
    .from('chat_message_reactions')
    .select('message_id, user_id, emoji, thread_id, created_at')
    .in('message_id', [...messageIds]);
  if (error) fail('Failed to load reactions', error);
  return (data ?? []) as ChatMessageReaction[];
}
