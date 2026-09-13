// ============================================================
// POST /api/lead-sources — create a lead source (admin+).
//
// Everything else about a source (edit, pause, delete, list, events)
// goes straight through the RLS-scoped Supabase client in the settings
// panel. Creation lives here only because the token — the source's one
// credential — must be minted server-side (32 random bytes, hex).
// ============================================================

import { NextResponse } from 'next/server'

import { requireModule, requireRole, toErrorResponse } from '@/lib/auth/account'
import { LEAD_SOURCE_COLUMNS, normalizeFieldMap } from '@/lib/lead-capture'
import { generateLeadSourceToken } from '@/lib/lead-capture/token'
import { AUDIT_ACTIONS } from '@/lib/audit'
import { audit } from '@/lib/audit-server'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

const MAX_NAME_LEN = 80

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const optionalUuid = (v: unknown): string | null =>
  typeof v === 'string' && UUID_RE.test(v) ? v : null

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    await requireModule(ctx, 'lead_capture')

    const limit = checkRateLimit(`admin:lead-source-create:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    if (!name) return NextResponse.json({ error: 'Name is required' }, { status: 400 })
    if (name.length > MAX_NAME_LEN) {
      return NextResponse.json({ error: `Name must be ${MAX_NAME_LEN} characters or fewer` }, { status: 400 })
    }

    const pipelineId = optionalUuid(body?.pipeline_id)
    const stageId = pipelineId ? optionalUuid(body?.stage_id) : null
    const tagIds = Array.isArray(body?.tag_ids)
      ? (body!.tag_ids as unknown[]).map(optionalUuid).filter((v): v is string => v !== null)
      : []

    const { data, error } = await ctx.supabase
      .from('lead_sources')
      .insert({
        account_id: ctx.accountId,
        name,
        token: generateLeadSourceToken(),
        is_active: body?.is_active === false ? false : true,
        pipeline_id: pipelineId,
        stage_id: stageId,
        tag_ids: tagIds,
        assignee_user_id: optionalUuid(body?.assignee_user_id),
        field_map: normalizeFieldMap(body?.field_map),
        created_by: ctx.userId,
      })
      .select(LEAD_SOURCE_COLUMNS)
      .single()

    if (error) {
      console.error('[POST /api/lead-sources] insert failed:', error)
      return NextResponse.json({ error: 'Failed to create lead source' }, { status: 500 })
    }
    await audit({
      accountId: ctx.accountId,
      actorUserId: ctx.userId,
      action: AUDIT_ACTIONS.LEAD_SOURCE_CREATED,
      entityType: 'lead_source',
      entityId: (data as { id: string }).id,
      metadata: { name },
    })
    return NextResponse.json({ source: data }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
