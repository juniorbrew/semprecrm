// ============================================================
// Quick replies — read side. Takes the Supabase client so it works
// with the browser client (RLS-scoped) and the service-role client
// alike. No `next/*` imports. Errors are thrown.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import type { QuickReply } from '@/types';

export type QuickRepliesClient = Pick<SupabaseClient, 'from'>;

function fail(prefix: string, error: { message: string } | null): never {
  throw new Error(`${prefix}: ${error?.message ?? 'unknown error'}`);
}

/** The account's quick replies, sorted by shortcut. */
export async function listQuickReplies(
  db: QuickRepliesClient,
  accountId?: string | null,
): Promise<QuickReply[]> {
  let q = db.from('quick_replies').select('*').order('shortcut');
  if (accountId) q = q.eq('account_id', accountId);
  const { data, error } = await q;
  if (error) fail('Failed to load quick replies', error);
  return (data ?? []) as QuickReply[];
}
