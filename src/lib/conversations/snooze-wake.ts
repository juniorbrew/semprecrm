// ============================================================
// Snooze wake (migration 079), run by the cron every tick.
//
// `conversation_snooze_wake_due()` does the work in SQL, atomically: it
// clears `snoozed_until` on every due conversation (FOR UPDATE SKIP
// LOCKED, so overlapping ticks split the rows) and the guard trigger logs
// the `unsnoozed {cause:'timer'}` event in the same transaction. A woken
// row no longer matches, so a repeated call wakes nothing twice.
//
// Batches of WAKE_BATCH, looping while a batch comes back full, at most
// WAKE_MAX_BATCHES per call (the rest waits for the next tick). Then one
// best-effort push per woken conversation: a failed push never undoes or
// fails the wake (the conversation is already back in the list, unread).
// ponytail: no push retry; if it matters, reuse conversation_events.pushed_at
// (072) the way the SLA pending-push does.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { notifySnoozeWoke } from '@/lib/push/notify'
import { isPushConfigured } from '@/lib/push/send'

export const WAKE_BATCH = 50
export const WAKE_MAX_BATCHES = 10
const PUSH_CONCURRENCY = 5

export interface WokenRow {
  conversation_id: string
  account_id: string
  contact_id: string | null
  assigned_agent_id: string | null
  snoozed_by: string | null
  snooze_note: string | null
}

export interface SnoozeWakeResult {
  woken: number
  /** Pushes that reached at least one device. */
  notified: number
  /** RPC calls that failed (logged; the next tick retries). */
  errors: number
}

/** A missing function (migration 079 not applied yet) reads as nothing to do. */
const MISSING_RE = /42883|PGRST202|does not exist|schema cache/i

export async function runSnoozeWake(db: SupabaseClient, now: Date = new Date()): Promise<SnoozeWakeResult> {
  const out: SnoozeWakeResult = { woken: 0, notified: 0, errors: 0 }
  const woken: WokenRow[] = []
  for (let i = 0; i < WAKE_MAX_BATCHES; i++) {
    const { data, error } = await db.rpc('conversation_snooze_wake_due', {
      p_now: now.toISOString(),
      p_limit: WAKE_BATCH,
    })
    if (error) {
      if (!MISSING_RE.test(`${error.code ?? ''} ${error.message ?? ''}`)) {
        console.error('[snooze] wake failed:', error.message)
        out.errors += 1
      }
      break
    }
    const rows = (data ?? []) as WokenRow[]
    woken.push(...rows)
    if (rows.length < WAKE_BATCH) break
  }
  out.woken = woken.length
  if (woken.length === 0 || !isPushConfigured()) return out

  let next = 0
  const worker = async () => {
    while (next < woken.length) {
      const r = woken[next++]
      const res = await notifySnoozeWoke(db, {
        accountId: r.account_id,
        conversationId: r.conversation_id,
        contactId: r.contact_id,
        assigneeUserId: r.assigned_agent_id,
        snoozedBy: r.snoozed_by,
        snoozeNote: r.snooze_note,
      })
      if (res.sent > 0) out.notified += 1
    }
  }
  await Promise.all(Array.from({ length: Math.min(PUSH_CONCURRENCY, woken.length) }, worker))
  return out
}
