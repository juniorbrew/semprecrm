// ============================================================
// Automation event queue (migration 048).
//
// Table triggers on `contact_tags` and `conversations` write a row to
// `automation_event_queue` whenever a tag is added, a conversation is
// assigned, resolved or reopened — from any path (inbox, contact page,
// import, flows, the engine itself). This module drains that queue into
// `runAutomationsForTrigger`. The cron drains every minute; server-side
// writers (the inbound pipeline) drain their own account right away.
// ============================================================

import type { AutomationTriggerType } from '@/types'
import { supabaseAdmin } from './admin-client'
import { runAutomationsForTrigger } from './engine'

interface QueuedEvent {
  id: number
  account_id: string
  trigger_type: string
  contact_id: string | null
  conversation_id: string | null
  context: Record<string, unknown> | null
  depth: number
  origin_automation_id: string | null
}

/** Processed / dead rows are deleted after this many days. */
export const EVENT_QUEUE_RETENTION_DAYS = 7

const RELATION_MISSING_RE = /42P01|42883|PGRST202|PGRST205|does not exist|schema cache/i

/**
 * Claim up to `limit` queued events (optionally for one account) and run
 * the automations they trigger. Never throws. A missing queue (migration
 * 048 not applied yet) reads as an empty queue.
 */
export async function drainAutomationEvents(
  opts: { accountId?: string; limit?: number } = {},
): Promise<{ processed: number; failed: number }> {
  let processed = 0
  let failed = 0
  try {
    const db = supabaseAdmin()
    const { data, error } = await db.rpc('claim_automation_events', {
      p_account_id: opts.accountId ?? null,
      p_limit: opts.limit ?? 100,
    })
    if (error) {
      if (!RELATION_MISSING_RE.test(`${error.code ?? ''} ${error.message ?? ''}`)) {
        console.error('[automations] claim_automation_events failed:', error)
      }
      return { processed, failed }
    }

    for (const row of (data ?? []) as QueuedEvent[]) {
      // Acknowledge FIRST. If the acknowledgement cannot be written, skip
      // the event (its claim goes stale and it is retried) — never run
      // automations for a row that could replay them later.
      const ack = await db
        .from('automation_event_queue')
        .update({ processed_at: new Date().toISOString(), last_error: null })
        .eq('id', row.id)
      if (ack.error) {
        console.error('[automations] cannot acknowledge queued event', row.id, ack.error.message)
        failed += 1
        continue
      }

      let retry: string | null = null
      try {
        const ctx = row.context ?? {}
        const outcome = await runAutomationsForTrigger({
          accountId: row.account_id,
          triggerType: row.trigger_type as AutomationTriggerType,
          contactId: row.contact_id,
          context: {
            conversation_id: row.conversation_id ?? undefined,
            tag_id: typeof ctx.tag_id === 'string' ? ctx.tag_id : undefined,
            agent_id: typeof ctx.agent_id === 'string' ? ctx.agent_id : undefined,
            vars: ctx,
          },
          origin: { depth: row.depth ?? 0, automationId: row.origin_automation_id },
        })
        // A read failed before any automation ran: safe to retry.
        if (!outcome?.ok) retry = 'dispatch could not load the automations'
      } catch (err) {
        retry = err instanceof Error ? err.message : String(err)
      }

      if (retry === null) {
        processed += 1
        continue
      }
      failed += 1
      // Un-acknowledge: the claim goes stale after 5 min and the row is
      // retried, up to 5 attempts.
      const undo = await db
        .from('automation_event_queue')
        .update({ processed_at: null, last_error: retry.slice(0, 500) })
        .eq('id', row.id)
      if (undo.error) {
        console.error('[automations] queued event lost after a failed dispatch', row.id, undo.error.message)
      }
    }
  } catch (err) {
    console.error('[automations] drain failed:', err)
  }
  return { processed, failed }
}

/** Delete processed rows and rows that exhausted their attempts. */
export async function pruneAutomationEvents(now: Date = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - EVENT_QUEUE_RETENTION_DAYS * 86_400_000).toISOString()
  const db = supabaseAdmin()
  const done = await db.from('automation_event_queue').delete().lt('processed_at', cutoff)
  const dead = await db
    .from('automation_event_queue')
    .delete()
    .is('processed_at', null)
    .gte('attempts', 5)
    .lt('created_at', cutoff)
  for (const res of [done, dead]) {
    if (res.error && !RELATION_MISSING_RE.test(res.error.message)) {
      console.error('[automations] prune event queue failed:', res.error.message)
    }
  }
}
