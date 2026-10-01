// ============================================================
// Data retention (LGPD minimisation), run by the automations cron.
// Each purge is bounded: at most PURGE_BATCH rows per table per tick
// (select ids → delete / update by id in chunks of 200), so a large
// backlog drains over several ticks instead of one long statement.
//
//   flow_runs (+ flow_run_events, cascade)  ended > 90 days ago
//   ai_reply_jobs                            finished > 30 days ago
//   csat_jobs                                processed > 30 days ago
//   account_invitations                      unaccepted, expired > 30 days ago
//   ai_handoffs.last_customer_words          nulled after 180 days
//   lead_source_events                       older than 90 days (spec §2)
//   audit_log                                older than AUDIT_RETENTION_DAYS
//
// Out of scope: orphaned chat-media objects (no reliable owner link).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { AUDIT_RETENTION_DAYS } from '@/lib/audit'

export const PURGE_BATCH = 500
const DAY = 86_400_000

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Query = any

interface Purge {
  table: string
  /** Select builder with the retention filter applied. */
  due: (db: Query, now: Date) => Query
  /** Update payload; omitted = delete. */
  update?: Record<string, unknown>
}

const ago = (now: Date, days: number) => new Date(now.getTime() - days * DAY).toISOString()

export const PURGES: Purge[] = [
  {
    table: 'flow_runs',
    due: (db, now) => db.from('flow_runs').select('id').not('ended_at', 'is', null).lt('ended_at', ago(now, 90)),
  },
  {
    table: 'ai_reply_jobs',
    due: (db, now) =>
      db.from('ai_reply_jobs').select('id').in('status', ['done', 'skipped', 'failed']).lt('updated_at', ago(now, 30)),
  },
  {
    table: 'csat_jobs',
    due: (db, now) => db.from('csat_jobs').select('id').not('processed_at', 'is', null).lt('processed_at', ago(now, 30)),
  },
  {
    table: 'account_invitations',
    due: (db, now) => db.from('account_invitations').select('id').is('accepted_at', null).lt('expires_at', ago(now, 30)),
  },
  {
    table: 'ai_handoffs',
    due: (db, now) =>
      db.from('ai_handoffs').select('id').not('last_customer_words', 'is', null).lt('created_at', ago(now, 180)),
    update: { last_customer_words: null },
  },
  {
    table: 'lead_source_events',
    due: (db, now) => db.from('lead_source_events').select('id').lt('created_at', ago(now, 90)),
  },
  {
    table: 'audit_log',
    due: (db, now) => db.from('audit_log').select('id').lt('created_at', ago(now, AUDIT_RETENTION_DAYS)),
  },
]

/** One bounded pass of every purge. `null` = that purge failed (logged). */
export async function runRetentionPurge(
  db: SupabaseClient,
  now: Date = new Date(),
  batch: number = PURGE_BATCH,
): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = {}
  for (const p of PURGES) {
    try {
      const { data, error } = await p.due(db, now).limit(batch)
      if (error) throw new Error(error.message)
      const ids = ((data ?? []) as { id: string | number }[]).map((r) => r.id)
      for (let i = 0; i < ids.length; i += 200) {
        const part = ids.slice(i, i + 200)
        const q = p.update ? db.from(p.table).update(p.update) : db.from(p.table).delete()
        const { error: wErr } = await q.in('id', part)
        if (wErr) throw new Error(wErr.message)
      }
      out[p.table] = ids.length
      if (ids.length > 0) {
        console.log(`[cron] retention ${p.table}: ${p.update ? 'scrubbed' : 'deleted'} ${ids.length}${ids.length === batch ? ' (more pending)' : ''}`)
      }
    } catch (err) {
      console.error(`[cron] retention ${p.table} failed:`, err instanceof Error ? err.message : err)
      out[p.table] = null
    }
  }
  return out
}
