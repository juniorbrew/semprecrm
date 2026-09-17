import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resumePendingExecution } from '@/lib/automations/engine'
import type { AutomationContext } from '@/lib/automations/engine'
import { scanInactiveConversations } from '@/lib/automations/inactivity'
import { AUDIT_RETENTION_DAYS } from '@/lib/audit'
import { notifyCalendarReminders, notifyTasksDueSoon } from '@/lib/push/notify'
import { isPushConfigured } from '@/lib/push/send'

/** Retention for the lead-capture webhook log (spec §2). */
const LEAD_SOURCE_EVENTS_RETENTION_DAYS = 90

/** Matches "relation does not exist" from PostgREST / Postgres. */
const RELATION_MISSING_RE = /42P01|PGRST205|does not exist|schema cache/i

/**
 * Drain due `automation_pending_executions` rows, then run the
 * `conversation_inactive` follow-up scan and the housekeeping below.
 * Meant to be hit on a schedule (scripts/cron-tick.mjs, Vercel Cron,
 * any external pinger) — requires a shared secret via the
 * `x-cron-secret` header to match `AUTOMATION_CRON_SECRET`.
 *
 * The claim step (status = 'running') serves as a simple lock so
 * overlapping invocations don't double-process rows. Best-effort
 * only; expensive SELECT ... FOR UPDATE is avoided in favor of a
 * two-step UPDATE-by-id.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret')
  if (supplied !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const { data: due, error } = await admin
    .from('automation_pending_executions')
    .select('*')
    .eq('status', 'pending')
    .lte('run_at', new Date().toISOString())
    .order('run_at', { ascending: true })
    .limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  let processed = 0
  for (const row of due ?? []) {
    const { data: claim } = await admin
      .from('automation_pending_executions')
      .update({ status: 'running' })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (!claim) continue

    await resumePendingExecution({
      id: row.id as string,
      automation_id: row.automation_id as string,
      // account_id is NOT NULL on automation_pending_executions
      // post-017; the engine uses it for tenant-scoped lookups.
      account_id: row.account_id as string,
      user_id: row.user_id as string,
      contact_id: (row.contact_id as string | null) ?? null,
      log_id: (row.log_id as string | null) ?? null,
      parent_step_id: (row.parent_step_id as string | null) ?? null,
      branch: (row.branch as 'yes' | 'no' | null) ?? null,
      next_step_position: row.next_step_position as number,
      context: (row.context as AutomationContext) ?? {},
    })
    processed++
  }

  // Follow-up scan (migration 030). Runs after the pending drain so a
  // wait step that just resumed is not immediately re-nudged.
  const inactivity = await scanInactiveConversations(admin, new Date())

  // Housekeeping: lead_source_events older than 90 days (spec §2). The
  // table comes with migration 029; a schema without it just skips.
  let leadEventsPurged: number | null = null
  try {
    const cutoff = new Date(
      Date.now() - LEAD_SOURCE_EVENTS_RETENTION_DAYS * 86_400_000,
    ).toISOString()
    const { error: purgeErr, count } = await admin
      .from('lead_source_events')
      .delete({ count: 'exact' })
      .lt('created_at', cutoff)
    if (purgeErr) {
      // 42P01 = undefined_table (PostgREST reports PGRST205 when the
      // relation is missing from its schema cache). Anything else is
      // logged; never fails the tick.
      if (!/42P01|PGRST205|does not exist|schema cache/i.test(`${purgeErr.code} ${purgeErr.message}`)) {
        console.error('[cron] lead_source_events purge failed:', purgeErr.message)
      }
    } else {
      leadEventsPurged = count ?? 0
    }
  } catch (err) {
    console.error('[cron] lead_source_events purge threw:', err)
  }

  // Housekeeping: audit_log older than 365 days (round 2 spec §3).
  let auditPurged: number | null = null
  try {
    const cutoff = new Date(Date.now() - AUDIT_RETENTION_DAYS * 86_400_000).toISOString()
    const { error: purgeErr, count } = await admin
      .from('audit_log')
      .delete({ count: 'exact' })
      .lt('created_at', cutoff)
    if (purgeErr) {
      if (!RELATION_MISSING_RE.test(`${purgeErr.code} ${purgeErr.message}`)) {
        console.error('[cron] audit_log purge failed:', purgeErr.message)
      }
    } else {
      auditPurged = count ?? 0
    }
  } catch (err) {
    console.error('[cron] audit_log purge threw:', err)
  }

  // Browser push (round 2 spec §5c): tasks due within 15 minutes, once
  // each (`tasks.reminded_at`). Skipped entirely without VAPID keys.
  let tasksDue: { scanned: number; notified: number } | null = null
  if (isPushConfigured()) {
    try {
      tasksDue = await notifyTasksDueSoon(admin, new Date())
    } catch (err) {
      console.error('[cron] task due-soon push threw:', err)
    }
  }

  // Browser push (calendar spec, phase 1): appointment reminders at
  // `starts_at - reminder_minutes`, once each (`calendar_events.reminded_at`).
  let calendarReminders: { scanned: number; notified: number } | null = null
  if (isPushConfigured()) {
    try {
      calendarReminders = await notifyCalendarReminders(admin, new Date())
    } catch (err) {
      console.error('[cron] calendar reminder push threw:', err)
    }
  }

  return NextResponse.json({
    processed,
    tasks_due: tasksDue,
    calendar_reminders: calendarReminders,
    inactivity: {
      automations: inactivity.automations,
      fired: inactivity.fired,
      skipped: inactivity.skipped,
      errors: inactivity.errors.length,
    },
    lead_events_purged: leadEventsPurged,
    audit_purged: auditPurged,
  })
}
