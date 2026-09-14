// ============================================================
// Internal chat — read side. Every function takes the Supabase
// client so the browser client (RLS-scoped) and the service-role
// client (push triggers) can share it. No `next/*` imports.
//
// Errors are thrown (as `Error` with the PostgREST message) so
// callers can `try / catch` + toast in one place.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import type { ChatMember, ChatMessage, ChatThread } from '@/types';

import { unreadByThread } from './status';

/** The app's Supabase client is untyped, so this is what callers hold. */
export type ChatClient = Pick<SupabaseClient, 'from' | 'rpc'>;

/** Messages per history page (spec: 50). */
export const CHAT_PAGE_SIZE = 50;

/** Cap on the unread scan behind the badges — plenty for a team chat. */
const UNREAD_SCAN_LIMIT = 5000;

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
// Unread
// ------------------------------------------------------------

/**
 * Per-thread unread counts for the signed-in user. Pulls only the ids
 * of the unread rows (RLS keeps them to my threads) and folds them
 * client-side — one round trip for every badge in the list.
 */
export async function loadUnreadByThread(db: ChatClient, userId: string): Promise<Map<string, number>> {
  const { data, error } = await db
    .from('chat_messages')
    .select('thread_id, sender_id, read_at')
    .neq('sender_id', userId)
    .is('read_at', null)
    .limit(UNREAD_SCAN_LIMIT);
  if (error) fail('Failed to load unread chat messages', error);
  return unreadByThread((data ?? []) as Pick<ChatMessage, 'thread_id' | 'sender_id' | 'read_at'>[], userId);
}

/** Total unread — head-only count for the sidebar badge. */
export async function countUnreadMessages(db: ChatClient, userId: string): Promise<number> {
  const { count, error } = await db
    .from('chat_messages')
    .select('id', { count: 'exact', head: true })
    .neq('sender_id', userId)
    .is('read_at', null);
  if (error) fail('Failed to count unread chat messages', error);
  return count ?? 0;
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
