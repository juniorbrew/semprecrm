// ============================================================
// Internal chat — write side (browser client, RLS-scoped).
//
//   getOrCreateDirectThread  RPC chat_get_or_create_direct_thread
//   sendChatMessage          insert (account_id stamped by trigger),
//                            optional attachment
//   markThreadDelivered      RPC chat_mark_delivered(thread)
//   markAllDelivered         RPC chat_mark_delivered(null)
//   markThreadRead           RPC chat_mark_read(thread)
//   touchLastSeen            presence heartbeat (profiles.last_seen_at)
//   uploadChatAttachment     Storage upload into `chat-internal`
//   editChatMessage          sender: body within the 15-minute window
//   deleteChatMessage        POST /api/chat/messages/[id]/delete
//   addReaction / removeReaction
//   createGroup / addGroupMembers / removeGroupMember / leaveGroup
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import type { ChatAttachment, ChatMessage } from '@/types';

import { buildChatAttachmentPath, CHAT_INTERNAL_BUCKET, validateChatAttachment } from './attachments';
import type { ChatClient } from './queries';

function fail(prefix: string, error: { message: string } | null): never {
  throw new Error(`${prefix}: ${error?.message ?? 'unknown error'}`);
}

/** `SETOF uuid` comes back as plain strings or as `{ <fn name>: uuid }` rows depending on PostgREST. */
export function asIds(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  const out: string[] = [];
  for (const row of data as unknown[]) {
    if (typeof row === 'string') out.push(row);
    else if (row && typeof row === 'object') {
      const first = Object.values(row as Record<string, unknown>)[0];
      if (typeof first === 'string') out.push(first);
    }
  }
  return out;
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
  attachment?: ChatAttachment | null;
}

/** Insert a message; returns the stored row (receipts empty). */
export async function sendChatMessage(db: ChatClient, input: SendChatMessageInput): Promise<ChatMessage> {
  const body = input.body.trim();
  if (!body && !input.attachment) throw new Error('Message body cannot be empty');
  const { data, error } = await db
    .from('chat_messages')
    .insert({
      thread_id: input.threadId,
      account_id: input.accountId,
      sender_id: input.senderId,
      body,
      attachment: input.attachment ?? null,
    })
    .select('*')
    .single();
  if (error) fail('Failed to send the message', error);
  return data as ChatMessage;
}

/**
 * Recipient side: stamp "delivered" on every message in `threadId`
 * addressed to me with no receipt yet (direct: the column; group: my
 * receipt row). Returns the ids touched.
 */
export async function markThreadDelivered(db: ChatClient, threadId: string): Promise<string[]> {
  const { data, error } = await db.rpc('chat_mark_delivered', { p_thread_id: threadId });
  if (error) fail('Failed to mark messages as delivered', error);
  return asIds(data);
}

/**
 * Same across every thread I belong to. Called when the app comes up so
 * messages that arrived while I was offline flip to ✓✓ for the sender.
 */
export async function markAllDelivered(db: ChatClient): Promise<number> {
  const { data, error } = await db.rpc('chat_mark_delivered', { p_thread_id: null });
  if (error) fail('Failed to mark messages as delivered', error);
  return asIds(data).length;
}

/**
 * Recipient side: stamp "read" (implies delivered) on the unread
 * messages of `threadId` and bump my `last_read_at`. Returns the ids.
 */
export async function markThreadRead(db: ChatClient, threadId: string): Promise<string[]> {
  const { data, error } = await db.rpc('chat_mark_read', { p_thread_id: threadId });
  if (error) fail('Failed to mark messages as read', error);
  return asIds(data);
}

/** Presence heartbeat fallback — my own `profiles.last_seen_at`. */
export async function touchLastSeen(db: ChatClient, userId: string, now: Date = new Date()): Promise<void> {
  const { error } = await db
    .from('profiles')
    .update({ last_seen_at: now.toISOString() })
    .eq('user_id', userId);
  if (error) fail('Failed to update last seen', error);
}

// ------------------------------------------------------------
// Attachments
// ------------------------------------------------------------

export type ChatStorageClient = Pick<SupabaseClient, 'storage'>;

export interface UploadChatAttachmentInput {
  accountId: string;
  threadId: string;
  file: File;
  /** Probed client-side (images / media) — stored with the message. */
  width?: number;
  height?: number;
  duration?: number;
}

/**
 * Upload into the private bucket under the thread's folder and return
 * the attachment object to store on the message. Validation errors
 * throw with a reason the UI maps to copy (`too_large`, …).
 */
export async function uploadChatAttachment(
  db: ChatStorageClient,
  input: UploadChatAttachmentInput,
): Promise<ChatAttachment> {
  const check = validateChatAttachment(input.file);
  if (!check.ok) throw new Error(check.reason);
  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const path = buildChatAttachmentPath(input.accountId, input.threadId, input.file.name, uuid);
  const { error } = await db.storage
    .from(CHAT_INTERNAL_BUCKET)
    .upload(path, input.file, { contentType: check.mime, upsert: false, cacheControl: '3600' });
  if (error) fail('Upload failed', error);
  const out: ChatAttachment = {
    path,
    name: input.file.name || path.split('/').pop() || 'file',
    mime: check.mime,
    size: input.file.size,
  };
  if (input.width) out.width = input.width;
  if (input.height) out.height = input.height;
  if (input.duration) out.duration = input.duration;
  return out;
}

// ------------------------------------------------------------
// Edit / delete
// ------------------------------------------------------------

/** Sender: replace the body (the trigger enforces the 15-minute window). */
export async function editChatMessage(db: ChatClient, messageId: string, body: string): Promise<ChatMessage> {
  const next = body.trim();
  if (!next) throw new Error('Message body cannot be empty');
  const { data, error } = await db
    .from('chat_messages')
    .update({ body: next })
    .eq('id', messageId)
    .select('*')
    .single();
  if (error) fail('Failed to edit the message', error);
  return data as ChatMessage;
}

/**
 * Sender: soft-delete through the server route, which also removes the
 * attachment object from the bucket with the service role.
 */
export async function deleteChatMessage(messageId: string): Promise<ChatMessage> {
  const res = await fetch(`/api/chat/messages/${encodeURIComponent(messageId)}/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const json = (await res.json().catch(() => null)) as { message?: ChatMessage; error?: string } | null;
  if (!res.ok || !json?.message) throw new Error(json?.error ?? `Failed to delete the message (${res.status})`);
  return json.message;
}

// ------------------------------------------------------------
// Reactions
// ------------------------------------------------------------

export async function addReaction(db: ChatClient, messageId: string, userId: string, emoji: string): Promise<void> {
  const { error } = await db
    .from('chat_message_reactions')
    .upsert({ message_id: messageId, user_id: userId, emoji }, { onConflict: 'message_id,user_id,emoji', ignoreDuplicates: true });
  if (error) fail('Failed to react', error);
}

export async function removeReactionRow(db: ChatClient, messageId: string, userId: string, emoji: string): Promise<void> {
  const { error } = await db
    .from('chat_message_reactions')
    .delete()
    .eq('message_id', messageId)
    .eq('user_id', userId)
    .eq('emoji', emoji);
  if (error) fail('Failed to remove the reaction', error);
}

// ------------------------------------------------------------
// Groups
// ------------------------------------------------------------

export async function createGroup(db: ChatClient, title: string, memberIds: readonly string[]): Promise<string> {
  const { data, error } = await db.rpc('chat_create_group', { p_title: title.trim(), p_member_ids: [...memberIds] });
  if (error) fail('Failed to create the group', error);
  if (typeof data !== 'string') throw new Error('Failed to create the group: no thread id');
  return data;
}

/** Returns how many members were actually added (already-members are skipped). */
export async function addGroupMembers(db: ChatClient, threadId: string, memberIds: readonly string[]): Promise<number> {
  const { data, error } = await db.rpc('chat_add_members', { p_thread_id: threadId, p_member_ids: [...memberIds] });
  if (error) fail('Failed to add members', error);
  return typeof data === 'number' ? data : Number(data ?? 0);
}

export async function removeGroupMember(db: ChatClient, threadId: string, userId: string): Promise<void> {
  const { error } = await db.rpc('chat_remove_member', { p_thread_id: threadId, p_user_id: userId });
  if (error) fail('Failed to remove the member', error);
}

export async function leaveGroup(db: ChatClient, threadId: string): Promise<void> {
  const { error } = await db.rpc('chat_leave_group', { p_thread_id: threadId });
  if (error) fail('Failed to leave the group', error);
}
