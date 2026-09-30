// ============================================================
// SLA tick (migration 072), run by the cron every minute.
//
// `sla_tick()` does the work in SQL, atomically: it records one
// `sla_warning` (80% of the target) and one `sla_breached` event per
// conversation, target and window, stamps `sla_breached_at` and queues the
// automation triggers of the same names. A row that fails is skipped
// (reported as an 'error' row) and retried next tick.
//
// Pushes are decoupled from the events: breach events are created first,
// then every event whose push is still owed (`sla_pending_push`: recent,
// conversation open, pushed_at null) is sent with bounded concurrency and
// a per-tick cap, and only the ones that went through are marked
// (`sla_mark_pushed`). A failed push is offered again on the next tick.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { notifySlaBreached } from '@/lib/push/notify'
import { isPushConfigured } from '@/lib/push/send'

export const PUSH_CONCURRENCY = 5
/** Pushes handled per tick; the rest waits for the next one. */
export const PUSH_PER_TICK = 100

export interface SlaTickRow {
  event_id: string | null
  conversation_id: string
  account_id: string
  contact_id: string | null
  assigned_agent_id: string | null
  stage: 'warning' | 'breached' | 'error'
  kind: 'first_response' | 'resolution'
}

export interface SlaPendingPush {
  event_id: string
  conversation_id: string
  account_id: string
  assigned_agent_id: string | null
  kind: 'first_response' | 'resolution'
}

export interface SlaTickResult {
  warnings: number
  breaches: number
  /** Conversations sla_tick could not process (skipped, retried next tick). */
  errors: number
  /** Pushes that reached at least one device. */
  notified: number
  /** Pushes owed and attempted this tick (new breaches plus earlier failures). */
  attempted: number
}

/** A missing function (migration 072 not applied yet) reads as nothing to do. */
const MISSING_RE = /42883|PGRST202|does not exist|schema cache/i

function isMissing(error: { code?: string; message?: string }): boolean {
  return MISSING_RE.test(`${error.code ?? ''} ${error.message ?? ''}`)
}

/** Runs `fn` over `items` with at most `limit` in flight. */
async function pool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) await fn(items[next++])
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

export async function runSlaTick(db: SupabaseClient, now: Date = new Date()): Promise<SlaTickResult> {
  const out: SlaTickResult = { warnings: 0, breaches: 0, errors: 0, notified: 0, attempted: 0 }
  const { data, error } = await db.rpc('sla_tick', { p_now: now.toISOString() })
  if (error) {
    if (!isMissing(error)) console.error('[sla] tick failed:', error.message)
    return out
  }
  for (const r of (data ?? []) as SlaTickRow[]) {
    if (r.stage === 'warning') out.warnings += 1
    else if (r.stage === 'breached') out.breaches += 1
    else out.errors += 1
  }
  if (!isPushConfigured()) return out

  const { data: owed, error: owedErr } = await db.rpc('sla_pending_push', { p_limit: PUSH_PER_TICK })
  if (owedErr) {
    if (!isMissing(owedErr)) console.error('[sla] pending push read failed:', owedErr.message)
    return out
  }
  const pending = ((owed ?? []) as SlaPendingPush[]).slice(0, PUSH_PER_TICK)
  out.attempted = pending.length
  const done: string[] = []
  await pool(pending, PUSH_CONCURRENCY, async (p) => {
    try {
      const res = await notifySlaBreached(db, {
        accountId: p.account_id,
        conversationId: p.conversation_id,
        assigneeUserId: p.assigned_agent_id,
        kind: p.kind,
      })
      if (res.sent > 0) out.notified += 1
      // Nobody to notify / no device is final; only a delivery failure is retried.
      if (!(res.failed > 0 && res.sent === 0)) done.push(p.event_id)
    } catch (err) {
      console.error('[sla] push failed:', err instanceof Error ? err.message : err)
    }
  })
  if (done.length) {
    const { error: markErr } = await db.rpc('sla_mark_pushed', { p_event_ids: done })
    if (markErr) console.error('[sla] mark pushed failed:', markErr.message)
  }
  return out
}
