// ============================================================
// Quick replies — write side. RLS (028): agent+ writes.
// Shortcuts are normalised (trim + lower-case) and validated here so
// the DB CHECK never fires with a confusing message.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import type { QuickReply } from '@/types';

import { isValidShortcut } from './match';

type WriteClient = Pick<SupabaseClient, 'from'>;

function fail(prefix: string, error: { message: string } | null): never {
  throw new Error(`${prefix}: ${error?.message ?? 'unknown error'}`);
}

export interface QuickReplyInput {
  shortcut: string;
  title: string;
  body: string;
}

/** Trim / lower-case and validate. Throws on invalid input. */
export function normalizeQuickReplyInput(input: QuickReplyInput): QuickReplyInput {
  const shortcut = input.shortcut.trim().toLowerCase();
  const title = input.title.trim();
  const body = input.body.trim();
  if (!isValidShortcut(shortcut)) throw new Error('Invalid shortcut');
  if (!title) throw new Error('Title is required');
  if (!body) throw new Error('Body is required');
  return { shortcut, title, body };
}

/** True for the (account_id, shortcut) unique-violation error. */
export function isDuplicateShortcutError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /23505|duplicate key|quick_replies_account_shortcut_key/i.test(message);
}

export async function createQuickReply(
  db: WriteClient,
  ctx: { accountId: string; userId: string | null },
  input: QuickReplyInput,
): Promise<QuickReply> {
  const values = normalizeQuickReplyInput(input);
  const { data, error } = await db
    .from('quick_replies')
    .insert({ account_id: ctx.accountId, created_by: ctx.userId, ...values })
    .select('*')
    .single();
  if (error || !data) fail('Failed to create quick reply', error);
  return data as QuickReply;
}

export async function updateQuickReply(
  db: WriteClient,
  id: string,
  input: QuickReplyInput,
): Promise<QuickReply> {
  const values = normalizeQuickReplyInput(input);
  const { data, error } = await db
    .from('quick_replies')
    .update(values)
    .eq('id', id)
    .select('*')
    .single();
  if (error || !data) fail('Failed to update quick reply', error);
  return data as QuickReply;
}

export async function deleteQuickReply(db: WriteClient, id: string): Promise<void> {
  const { error } = await db.from('quick_replies').delete().eq('id', id);
  if (error) fail('Failed to delete quick reply', error);
}
