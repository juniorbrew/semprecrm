// read-only: allowed (cron: secret-authenticated tick, no user; only renews tokens)
import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { refreshInstagramTokens } from '@/lib/meta-messaging/connect/refresh'

export const dynamic = 'force-dynamic'

/**
 * Renews the Instagram tokens that are a week old or more (they last 60 days) and flags the
 * ones that cannot be renewed as expired, so Settings shows "Reconectar". Hit every few hours
 * by scripts/cron-tick.mjs with the shared `x-cron-secret` header; safe to overlap.
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
    return NextResponse.json(await refreshInstagramTokens(supabaseAdmin()))
  } catch (err) {
    console.error('[meta-connect] token refresh cron failed:', err instanceof Error ? err.message : 'error')
    return NextResponse.json({ error: 'token refresh failed' }, { status: 500 })
  }
}

export const POST = GET
