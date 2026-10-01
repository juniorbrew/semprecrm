// ============================================================
// GET /api/contacts/[id]/export — LGPD data export. Admin+.
//
// Streams one JSON document (contact, custom fields, tags,
// conversations + messages with media URLs, notes, deals, tasks and
// comments, calendar, flows, lead events, companies, AI memory and
// hand-overs, CSAT, consent events — with a per-section `manifest`) as
// an attachment `contato-<id>.json`. Audited as `contact.exported`; the
// audit row is part of the action — if it cannot be written, nothing is
// exported (500).
//
// Reads with the caller's RLS-scoped client (see src/lib/lgpd/export.ts).
// ============================================================

import { NextResponse } from 'next/server'

import { AUDIT_ACTIONS } from '@/lib/audit'
import { AuditWriteError, auditStrict } from '@/lib/audit-server'
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

    try {
      await auditStrict({
        accountId: ctx.accountId,
        actorUserId: ctx.userId,
        action: AUDIT_ACTIONS.CONTACT_EXPORTED,
        entityType: 'contact',
        entityId: id,
        metadata: {
          contact_name: (payload.contact?.name as string | undefined) ?? null,
          sections: Object.fromEntries(Object.entries(payload.manifest).map(([k, v]) => [k, v.count])),
          incomplete_sections: Object.entries(payload.manifest)
            .filter(([, v]) => !v.complete)
            .map(([k]) => k),
        },
      })
    } catch (err) {
      if (!(err instanceof AuditWriteError)) throw err
      console.error('[GET /api/contacts/:id/export] audit write failed — export refused')
      return NextResponse.json(
        { error: 'Não foi possível registrar a exportação na auditoria. Nada foi exportado; tente novamente.', code: 'audit_failed' },
        { status: 500 },
      )
    }

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
