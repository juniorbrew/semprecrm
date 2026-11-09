// ============================================================
// PATCH /api/site-bots/[id] — edit a website chat bot (admin+, module
// `lead_capture`): name, active switch, destination, bot_config.
// Only rows of this account with kind 'site_bot' are touched; webhook
// sources keep going through the RLS client in the settings panel.
// ============================================================

import { NextResponse } from 'next/server'

import { requireModule, requireRole, toErrorResponse } from '@/lib/auth/account'
import { BOT_SOURCE_COLUMNS } from '@/lib/lead-capture'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { customFieldIds, parseBotWrite } from '@/lib/site-bot/admin-body'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('admin')
    await requireModule(ctx, 'lead_capture')

    const limit = checkRateLimit(`admin:site-bot-update:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Bot not found' }, { status: 404 })

    const parsed = parseBotWrite(await request.json().catch(() => null), 'update')
    if (!parsed.ok) return NextResponse.json({ error: 'Invalid bot', details: parsed.errors }, { status: 400 })
    const { write } = parsed
    if (Object.keys(write).length === 0) return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })

    const fieldIds = write.bot_config ? customFieldIds(write.bot_config) : []
    if (fieldIds.length > 0) {
      const { data } = await ctx.supabase
        .from('custom_fields')
        .select('id')
        .eq('account_id', ctx.accountId)
        .in('id', fieldIds)
      if ((data ?? []).length !== fieldIds.length) {
        return NextResponse.json({ error: 'Unknown custom field' }, { status: 400 })
      }
    }

    // RLS (admin+, account-scoped, billing read-only) is the real guard;
    // the filters make the intent explicit.
    const { data, error } = await ctx.supabase
      .from('lead_sources')
      .update(write)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .eq('kind', 'site_bot')
      .select(BOT_SOURCE_COLUMNS)
      .maybeSingle()
    if (error) {
      console.error('[PATCH /api/site-bots/:id] update failed:', error.message)
      return NextResponse.json({ error: 'Failed to save bot' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'Bot not found' }, { status: 404 })
    return NextResponse.json({ source: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}
