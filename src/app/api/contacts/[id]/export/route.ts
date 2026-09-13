// ============================================================
// GET /api/contacts/[id]/export — LGPD data export. Admin+.
//
// Streams one JSON document (contact, custom fields, tags,
// conversations + messages with media URLs, notes, deals, tasks,
// consent events) as an attachment `contato-<id>.json`. Audited as
// `contact.exported`.
//
// Reads with the caller's RLS-scoped client (see src/lib/lgpd/export.ts).
// ============================================================

import { NextResponse } from 'next/server'

import { AUDIT_ACTIONS } from '@/lib/audit'
import { audit } from '@/lib/audit-server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { ExportNotFoundError, buildContactExport } from '@/lib/lgpd/export'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(`admin:contact-export:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Invalid contact id' }, { status: 400 })
    }

    let payload
    try {
      payload = await buildContactExport(ctx.supabase, ctx.accountId, id)
    } catch (err) {
      if (err instanceof ExportNotFoundError) {
        return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
      }
      console.error('[GET /api/contacts/:id/export] failed:', err)
      return NextResponse.json({ error: 'Failed to export contact' }, { status: 500 })
    }

    await audit({
      accountId: ctx.accountId,
      actorUserId: ctx.userId,
      action: AUDIT_ACTIONS.CONTACT_EXPORTED,
      entityType: 'contact',
      entityId: id,
      metadata: {
        contact_name: (payload.contact?.name as string | undefined) ?? null,
        conversations: payload.conversations.length,
        messages: payload.conversations.reduce((n, c) => n + c.messages.length, 0),
        notes: payload.notes.length,
        deals: payload.deals.length,
        tasks: payload.tasks.length,
      },
    })

    return new NextResponse(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="contato-${id}.json"`,
        'cache-control': 'no-store',
      },
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
