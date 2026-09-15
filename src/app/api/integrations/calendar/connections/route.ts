// ============================================================
// /api/integrations/calendar/connections — Settings → Agenda data.
//
//   GET    { configured: {google, microsoft}, connections: [...] }
//          (the caller's rows from `calendar_connections_public`).
//   PATCH  { provider, mirror_attending } — the only user-editable
//          flag on a connection. Writes go through the service role
//          because the base table has no policies (migration 041).
// ============================================================

import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { configuredProviders, isCalendarProvider } from '@/lib/calendar/sync/config'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

const PUBLIC_COLUMNS =
  'id, account_id, user_id, provider, email, external_calendar_id, token_expires_at, last_sync_at, last_error, status, mirror_attending, created_at, updated_at'

export async function GET() {
  try {
    const ctx = await getCurrentAccount()
    const { data, error } = await ctx.supabase
      .from('calendar_connections_public')
      .select(PUBLIC_COLUMNS)
      .order('provider', { ascending: true })
    if (error) {
      console.error('[GET /api/integrations/calendar/connections] failed:', error)
      return NextResponse.json({ error: 'Failed to load connections' }, { status: 500 })
    }
    return NextResponse.json({ configured: configuredProviders(), connections: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const limit = checkRateLimit(`calendar:connections:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as { provider?: unknown; mirror_attending?: unknown } | null
    if (!body || !isCalendarProvider(body.provider) || typeof body.mirror_attending !== 'boolean') {
      return NextResponse.json({ error: 'Expected { provider, mirror_attending: boolean }' }, { status: 400 })
    }
    const { data, error } = await supabaseAdmin()
      .from('calendar_connections')
      .update({ mirror_attending: body.mirror_attending })
      .eq('user_id', ctx.userId)
      .eq('provider', body.provider)
      .select(PUBLIC_COLUMNS)
      .maybeSingle()
    if (error) {
      console.error('[PATCH /api/integrations/calendar/connections] failed:', error)
      return NextResponse.json({ error: 'Failed to update the connection' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'Not connected' }, { status: 404 })
    return NextResponse.json({ connection: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}
