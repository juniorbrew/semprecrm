// ============================================================
// SLA tick (migration 072), run by the cron every minute.
//
// `sla_tick()` does the work in SQL, atomically: it records one
// `sla_warning` (80% of the target) and one `sla_breached` event per
// conversation and target, stamps `sla_breached_at` and queues the
// automation triggers of the same names. It returns only the events THIS
// call created, so handing those to the push sender notifies exactly
// once, however often the cron runs and however many ticks overlap.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { notifySlaBreached } from '@/lib/push/notify'
import { isPushConfigured } from '@/lib/push/send'

export interface SlaTickRow {
  conversation_id: string
  account_id: string
  contact_id: string | null
  assigned_agent_id: string | null
  stage: 'warning' | 'breached'
  kind: 'first_response' | 'resolution'
}

export interface SlaTickResult {
  warnings: number
  breaches: number
  notified: number
}

/** A missing function (migration 072 not applied yet) reads as nothing to do. */
const MISSING_RE = /42883|PGRST202|does not exist|schema cache/i

export async function runSlaTick(
  db: SupabaseClient,
  now: Date = new Date(),
): Promise<SlaTickResult> {
  const out: SlaTickResult = { warnings: 0, breaches: 0, notified: 0 }
  const { data, error } = await db.rpc('sla_tick', { p_now: now.toISOString() })
  if (error) {
    if (!MISSING_RE.test(`${error.code ?? ''} ${error.message ?? ''}`)) console.error('[sla] tick failed:', error.message)
    return out
  }
  const rows = (data ?? []) as SlaTickRow[]
  const push = isPushConfigured()
  for (const r of rows) {
    if (r.stage === 'warning') {
      out.warnings += 1
      continue
    }
    out.breaches += 1
    if (!push) continue
    const res = await notifySlaBreached(db, {
      accountId: r.account_id,
      conversationId: r.conversation_id,
      assigneeUserId: r.assigned_agent_id,
      kind: r.kind,
    })
    if (res.sent > 0) out.notified += 1
  }
  return out
}
