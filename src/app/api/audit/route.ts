// ============================================================
// /api/audit
//
//   GET  — page through the account's audit log.        Admin+.
//          ?action=…&actor=<user_id>&from=<iso>&to=<iso>&cursor=…&limit=50
//          Newest first, cursor = base64url({ created_at, id }) of the
//          last row of the previous page.
//   POST — record a client-originated action.           Agent+.
//          Body: { action, entityType, entityId?, metadata? }.
//          Only `CLIENT_AUDIT_ACTIONS` are accepted (deletes done
//          straight through Supabase from the browser); the actor is
//          always the session user — the body cannot name someone else.
//
// Reads go through the RLS-scoped client (admin+ SELECT policy from
// migration 034); the write uses the service role because there is
// deliberately no INSERT policy for authenticated users.
// ============================================================

import { NextResponse } from 'next/server'

import {
  AUDIT_ENTITY_TYPES,
  CLIENT_AUDIT_ACTIONS,
  isAuditAction,
  type AuditLogRow,
} from '@/lib/audit'
import { audit } from '@/lib/audit-server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface Cursor {
  created_at: string
  id: string
}

function encodeCursor(row: AuditLogRow): string {
  return Buffer.from(JSON.stringify({ created_at: row.created_at, id: row.id }), 'utf8').toString(
    'base64url',
  )
}

function decodeCursor(raw: string | null): Cursor | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<Cursor>
    if (
      typeof parsed.created_at !== 'string' ||
      typeof parsed.id !== 'string' ||
      Number.isNaN(Date.parse(parsed.created_at)) ||
      !UUID_RE.test(parsed.id)
    ) {
      return null
    }
    return { created_at: parsed.created_at, id: parsed.id }
  } catch {
    return null
  }
}

function isoOrNull(raw: string | null): string | null {
  if (!raw) return null
  const ms = Date.parse(raw)
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const url = new URL(request.url)

    const limitRaw = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT)
    const limit = Number.isFinite(limitRaw)
      ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(limitRaw)))
      : DEFAULT_LIMIT

    const action = url.searchParams.get('action')
    if (action && !isAuditAction(action)) {
      return NextResponse.json({ error: 'Unknown action filter' }, { status: 400 })
    }
    const actor = url.searchParams.get('actor')
    if (actor && !UUID_RE.test(actor)) {
      return NextResponse.json({ error: "'actor' must be a UUID" }, { status: 400 })
    }
    const from = isoOrNull(url.searchParams.get('from'))
    const to = isoOrNull(url.searchParams.get('to'))
    const cursorRaw = url.searchParams.get('cursor')
    const cursor = decodeCursor(cursorRaw)
    if (cursorRaw && !cursor) {
      return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 })
    }

    let q = ctx.supabase
      .from('audit_log')
      .select('id, account_id, actor_user_id, actor_name, action, entity_type, entity_id, metadata, created_at')
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1)

    if (action) q = q.eq('action', action)
    if (actor) q = q.eq('actor_user_id', actor)
    if (from) q = q.gte('created_at', from)
    if (to) q = q.lte('created_at', to)
    if (cursor) {
      // (created_at, id) < (cursor.created_at, cursor.id) — keyset paging
      // that survives two rows sharing a timestamp.
      q = q.or(
        `created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`,
      )
    }

    const { data, error } = await q
    if (error) {
      console.error('[GET /api/audit] query failed:', error)
      return NextResponse.json({ error: 'Failed to load audit log' }, { status: 500 })
    }

    const rows = (data ?? []) as AuditLogRow[]
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const nextCursor = hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]) : null

    return NextResponse.json({ entries: page, nextCursor })
  } catch (err) {
    return toErrorResponse(err)
  }
}

const MAX_ENTITY_ID_LEN = 200

export async function POST(request: Request) {
  try {
    // Agents delete contacts / deals and toggle automations, so the
    // floor is agent — the actions themselves are already gated by RLS
    // on the mutation that preceded this call.
    const ctx = await requireRole('agent')

    const limit = checkRateLimit(`audit:record:${ctx.userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    const action = body?.action
    if (!isAuditAction(action) || !CLIENT_AUDIT_ACTIONS.has(action)) {
      return NextResponse.json(
        { error: 'This action cannot be recorded from the client' },
        { status: 400 },
      )
    }
    const entityType = body?.entityType
    if (
      typeof entityType !== 'string' ||
      !(AUDIT_ENTITY_TYPES as readonly string[]).includes(entityType)
    ) {
      return NextResponse.json({ error: "'entityType' is not recognised" }, { status: 400 })
    }
    const entityIdRaw = body?.entityId
    const entityId =
      typeof entityIdRaw === 'string' && entityIdRaw.length <= MAX_ENTITY_ID_LEN
        ? entityIdRaw
        : null
    const metadata =
      body?.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
        ? (body.metadata as Record<string, unknown>)
        : {}

    const ok = await audit({
      accountId: ctx.accountId,
      actorUserId: ctx.userId,
      action,
      entityType,
      entityId,
      metadata,
    })
    if (!ok) {
      return NextResponse.json({ error: 'Failed to record audit entry' }, { status: 500 })
    }
    return NextResponse.json({ ok: true }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
