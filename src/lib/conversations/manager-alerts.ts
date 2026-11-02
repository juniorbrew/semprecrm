// ============================================================
// Team monitoring alerts (migration 105), run by the cron every tick
// (piggybacks on /api/inbox/snooze/cron: same loopback-only route).
//
// `manager_alerts_due()` claims, in SQL and atomically, each customer
// wait that crossed the account's limit — `waiting` (inbox_sla_minutes)
// or `unassigned` (unassigned_alert_minutes) — once, and only for
// accounts where some owner/admin turned that alert on. Then one
// best-effort push per claimed wait to those managers.
// ponytail: no push retry and no business-hours quiet time; a claimed wait
// whose push fails is not offered again (same trade-off as snooze-wake).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { notifyManagerAlert } from '@/lib/push/notify'
import { isPushConfigured } from '@/lib/push/send'

// Each row costs a few queries inside the cron request; the rest of a burst
// waits for the next tick (claims skip what is already pushed).
export const ALERT_BATCH = 50
const PUSH_CONCURRENCY = 5

export interface ManagerAlertRow {
  conversation_id: string
  account_id: string
  contact_id: string | null
  assigned_agent_id: string | null
  kind: 'waiting' | 'unassigned'
  wait_started_at: string
}

export interface ManagerAlertsResult {
  claimed: number
  /** Pushes that reached at least one device. */
  notified: number
  /** RPC calls that failed (logged; the next tick retries). */
  errors: number
}

/** A missing function (migration 105 not applied yet) reads as nothing to do. */
const MISSING_RE = /42883|PGRST202|does not exist|schema cache/i

export async function runManagerAlerts(db: SupabaseClient, now: Date = new Date()): Promise<ManagerAlertsResult> {
  const out: ManagerAlertsResult = { claimed: 0, notified: 0, errors: 0 }
  // Without push there is nobody to tell; don't burn the claims.
  if (!isPushConfigured()) return out
  const { data, error } = await db.rpc('manager_alerts_due', {
    p_now: now.toISOString(),
    p_limit: ALERT_BATCH,
  })
  if (error) {
    if (!MISSING_RE.test(`${error.code ?? ''} ${error.message ?? ''}`)) {
      console.error('[manager-alerts] claim failed:', error.message)
      out.errors += 1
    }
    return out
  }
  const rows = (data ?? []) as ManagerAlertRow[]
  out.claimed = rows.length

  let next = 0
  const worker = async () => {
    while (next < rows.length) {
      const r = rows[next++]
      const res = await notifyManagerAlert(db, {
        accountId: r.account_id,
        conversationId: r.conversation_id,
        contactId: r.contact_id,
        assigneeUserId: r.assigned_agent_id,
        kind: r.kind,
        since: new Date(r.wait_started_at),
        now,
      })
      if (res.sent > 0) out.notified += 1
    }
  }
  await Promise.all(Array.from({ length: Math.min(PUSH_CONCURRENCY, rows.length) }, worker))
  return out
}
