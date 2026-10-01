// ============================================================
// Hourly cap on AUTOMATIC model calls (auto-reply + automatic triage).
//
// A customer (or a flood of numbers) can make the account pay for model
// calls just by writing. Each automatic call is an `ai_usage` row with
// `user_id` null — ok, error AND budget-blocked ones, so replies that
// ended in a hand-over count too. Before an automatic call the runtime
// asks whether the contact or the account already hit the last hour's
// cap; derived from the ledger, nothing to reset.
//
//   * contact cap → that conversation goes to the team (AI paused on it)
//   * account cap → the job waits (AI stays on) and owners / admins get
//     one push per hour
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { notifyAccountAdmins } from '@/lib/push/notify';

export const AI_AUTOMATIC_CAPS = {
  perContactPerHour: 30,
  perAccountPerHour: 300,
} as const;

const AUTOMATIC_FEATURES = ['auto_reply', 'triage'];
const HOUR_MS = 60 * 60 * 1000;
/** A contact rarely has more conversations than this; older ones are not counted. */
const CONTACT_CONVERSATIONS_READ = 100;

/** 'contact' / 'account' when that hourly cap is reached, else null. Throws on a read error. */
export async function automaticCapReached(
  db: SupabaseClient,
  input: { accountId: string; contactId: string | null; now?: Date },
  caps: { perContactPerHour: number; perAccountPerHour: number } = AI_AUTOMATIC_CAPS,
): Promise<'contact' | 'account' | null> {
  const since = new Date((input.now ?? new Date()).getTime() - HOUR_MS).toISOString();
  const calls = () =>
    db
      .from('ai_usage')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', input.accountId)
      .is('user_id', null)
      .in('feature', AUTOMATIC_FEATURES)
      .gte('created_at', since);

  const { count: accountCalls, error } = await calls();
  if (error) throw new Error(`ai usage count failed: ${error.message}`);
  if ((accountCalls ?? 0) >= caps.perAccountPerHour) return 'account';
  if (!input.contactId) return null;

  const { data: convs, error: convErr } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', input.accountId)
    .eq('contact_id', input.contactId)
    .limit(CONTACT_CONVERSATIONS_READ);
  if (convErr) throw new Error(`contact conversations read failed: ${convErr.message}`);
  const ids = ((convs ?? []) as { id: string }[]).map((c) => c.id);
  if (ids.length === 0) return null;
  const { count: contactCalls, error: contactErr } = await calls().in('conversation_id', ids);
  if (contactErr) throw new Error(`ai usage count failed: ${contactErr.message}`);
  return (contactCalls ?? 0) >= caps.perContactPerHour ? 'contact' : null;
}

/** Per process: the hour each account was last warned about the account cap. */
const warnedHour = new Map<string, string>();

/**
 * One push per account per hour to owners / admins: the account-wide
 * cap was reached, automatic replies wait until the hour clears. The
 * in-process memo keeps a flood from pushing per job; the tag collapses
 * what other processes send.
 */
export async function warnAccountCapReached(db: SupabaseClient, accountId: string, now: Date = new Date()): Promise<void> {
  const hour = now.toISOString().slice(0, 13);
  if (warnedHour.get(accountId) === hour) return;
  warnedHour.set(accountId, hour);
  await notifyAccountAdmins(db, accountId, {
    title: 'Limite por hora da IA atingido',
    body: `A conta passou de ${AI_AUTOMATIC_CAPS.perAccountPerHour} chamadas automáticas de IA na última hora. As respostas automáticas esperam o limite liberar.`,
    url: '/settings?tab=ai',
    tag: `ai-hourly-cap:${hour}`,
  });
}

/** Test helper. */
export function resetAccountCapWarnings(): void {
  warnedHour.clear();
}
