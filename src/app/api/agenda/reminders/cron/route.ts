// read-only: allowed (cron: secret-authenticated tick, no user; the sender skips read-only accounts itself)
import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { runReminderDispatch } from '@/lib/agenda/reminders'
import { supabaseAdmin } from '@/lib/automations/admin-client'

export const dynamic = 'force-dynamic'

/**
 * Sends the WhatsApp appointment reminders (migration 097) whose time has come.
 * Hit every tick by scripts/cron-tick.mjs with the shared `x-cron-secret`
 * header. Safe to overlap: the SQL claim splits the rows (SKIP LOCKED) and a
 * claimed row is never claimed again.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  const supplied = Buffer.from(request.headers.get('x-cron-secret') ?? '')
  const wanted = Buffer.from(expected)
  if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    return NextResponse.json(await runReminderDispatch(supabaseAdmin()))
  } catch (err) {
    console.error('[agenda-reminders] cron failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'reminder dispatch failed' }, { status: 500 })
  }
}

export const POST = GET
