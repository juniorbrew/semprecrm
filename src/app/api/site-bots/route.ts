// ============================================================
// POST /api/site-bots — create a website chat bot (admin+, module
// `lead_capture`). A bot is a `lead_sources` row with kind 'site_bot'.
//
// Lives here (not in the browser) because the public key — the id that
// goes into the customer's HTML — and the unused-but-required secret
// token must be minted server-side, and `bot_config` must pass
// validateBotConfig. Everything else goes through PATCH /[id].
// ============================================================

import { NextResponse } from 'next/server'

import { requireModule, requireRole, toErrorResponse } from '@/lib/auth/account'
import { AUDIT_ACTIONS } from '@/lib/audit'
import { audit } from '@/lib/audit-server'
import { BOT_SOURCE_COLUMNS } from '@/lib/lead-capture'
import { generateLeadSourceToken } from '@/lib/lead-capture/token'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { customFieldIds, parseBotWrite } from '@/lib/site-bot/admin-body'
import { generateBotPublicKey } from '@/lib/site-bot/key'

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    await requireModule(ctx, 'lead_capture')

    const limit = checkRateLimit(`admin:site-bot-create:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const parsed = parseBotWrite(await request.json().catch(() => null), 'create')
    if (!parsed.ok) return NextResponse.json({ error: 'Invalid bot', details: parsed.errors }, { status: 400 })
    const { write } = parsed

    const fieldIds = customFieldIds(write.bot_config!)
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

    const { data, error } = await ctx.supabase
      .from('lead_sources')
      .insert({
        account_id: ctx.accountId,
        kind: 'site_bot',
        name: write.name,
        token: generateLeadSourceToken(),
        public_key: generateBotPublicKey(),
        is_active: write.is_active ?? true,
        pipeline_id: write.pipeline_id ?? null,
        stage_id: write.pipeline_id ? (write.stage_id ?? null) : null,
        tag_ids: write.tag_ids ?? [],
        assignee_user_id: write.assignee_user_id ?? null,
        field_map: {},
        bot_config: write.bot_config,
        created_by: ctx.userId,
      })
      .select(BOT_SOURCE_COLUMNS)
      .single()

    if (error) {
      console.error('[POST /api/site-bots] insert failed:', error.message)
      return NextResponse.json({ error: 'Failed to create bot' }, { status: 500 })
    }
    await audit({
      accountId: ctx.accountId,
      actorUserId: ctx.userId,
      action: AUDIT_ACTIONS.LEAD_SOURCE_CREATED,
      entityType: 'lead_source',
      entityId: (data as unknown as { id: string }).id,
      metadata: { name: write.name, kind: 'site_bot' },
    })
    return NextResponse.json({ source: data }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
