// ============================================================
// Internal chat — write side (browser client, RLS-scoped).
//
//   getOrCreateDirectThread  RPC chat_get_or_create_direct_thread
//   sendChatMessage          insert (account_id stamped by trigger)
//   markThreadDelivered      recipient: delivered_at on pending rows
//   markAllDelivered         same, across every thread (login / focus)
//   markThreadRead           recipient: read_at + members.last_read_at
//   touchLastSeen            presence heartbeat (profiles.last_seen_at)
// ============================================================

import type { ChatMessage } from '@/types';

import type { ChatClient } from './queries';

function fail(prefix: string, error: { message: string } | null): never {
  throw new Error(`${prefix}: ${error?.message ?? 'unknown error'}`);
}

/** The direct thread with `otherUserId` (created on first use). */
export async function getOrCreateDirectThread(db: ChatClient, otherUserId: string): Promise<string> {
  const { data, error } = await db.rpc('chat_get_or_create_direct_thread', {
    p_other_user_id: otherUserId,
  });
  if (error) fail('Failed to open the conversation', error);
  if (typeof data !== 'string') throw new Error('Failed to open the conversation: no thread id');
  return data;
}

export interface SendChatMessageInput {
  threadId: string;
  accountId: string;
  senderId: string;
  body: string;
}

/** Insert a message; returns the stored row (receipts empty). */
export async function sendChatMessage(db: ChatClient, input: SendChatMessageInput): Promise<ChatMessage> {
  const body = input.body.trim();
  if (!body) throw new Error('Message body cannot be empty');
  const { data, error } = await db
    .from('chat_messages')
    .insert({
      thread_id: input.threadId,
      account_id: input.accountId,
      sender_id: input.senderId,
      body,
    })
    .select('*')
    .single();
  if (error) fail('Failed to send the message', error);
  return data as ChatMessage;
}

/**
 * Recipient side: stamp `delivered_at` on every message in `threadId`
 * that was sent to me and has no receipt yet. Returns the ids touched.
 */
export async function markThreadDelivered(
  db: ChatClient,
  threadId: string,
  userId: string,
  now: Date = new Date(),
): Promise<string[]> {
  const { data, error } = await db
    .from('chat_messages')
    .update({ delivered_at: now.toISOString() })
    .eq('thread_id', threadId)
    .neq('sender_id', userId)
    .is('delivered_at', null)
    .select('id');
  if (error) fail('Failed to mark messages as delivered', error);
  return ((data ?? []) as { id: string }[]).map((r) => r.id);
}

/**
 * Same across every thread I belong to (RLS scopes the update). Called
 * when the app comes up so messages that arrived while I was offline
 * flip to ✓✓ for the sender.
 */
export async function markAllDelivered(db: ChatClient, userId: string, now: Date = new Date()): Promise<number> {
  const { data, error } = await db
    .from('chat_messages')
    .update({ delivered_at: now.toISOString() })
    .neq('sender_id', userId)
    .is('delivered_at', null)
    .select('id');
  if (error) fail('Failed to mark messages as delivered', error);
  return (data ?? []).length;
}

/**
 * Recipient side: stamp `read_at` on the unread messages of `threadId`
 * (the trigger fills `delivered_at` too) and bump my `last_read_at`.
 * Returns the ids touched.
 */
export async function markThreadRead(
  db: ChatClient,
  threadId: string,
  userId: string,
  now: Date = new Date(),
): Promise<string[]> {
  const stamp = now.toISOString();
  const { data, error } = await db
    .from('chat_messages')
    .update({ read_at: stamp })
    .eq('thread_id', threadId)
    .neq('sender_id', userId)
    .is('read_at', null)
    .select('id');
  if (error) fail('Failed to mark messages as read', error);
  const { error: memberError } = await db
    .from('chat_thread_members')
    .update({ last_read_at: stamp })
    .eq('thread_id', threadId)
    .eq('user_id', userId);
  if (memberError) fail('Failed to update the read marker', memberError);
  return ((data ?? []) as { id: string }[]).map((r) => r.id);
}

/** Presence heartbeat fallback — my own `profiles.last_seen_at`. */
export async function touchLastSeen(db: ChatClient, userId: string, now: Date = new Date()): Promise<void> {
  const { error } = await db
    .from('profiles')
    .update({ last_seen_at: now.toISOString() })
    .eq('user_id', userId);
  if (error) fail('Failed to update last seen', error);
}
