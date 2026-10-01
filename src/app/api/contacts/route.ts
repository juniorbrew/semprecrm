// ============================================================
// DELETE /api/contacts — hard delete of contacts. Admin+.
//
// Body: `{ ids: string[] }` (1–50 contact ids of the caller's account).
// Deleting a person is destructive and, like the LGPD export and the
// anonymisation, admin-only; agents get a 403 with a pt-BR message.
// The contacts DELETE policy is gone (migration 077), so this route is
// the only way to delete a contact.
//
// Per contact (lib/lgpd/anonymize.ts `deleteContact`, service role):
// removes the chat-media objects of its messages and the stored profile
// photo, scrubs the personal text of the tables that only lose their
// link on delete (deals, tasks, calendar, flows, lead events, broadcast
// params, automation logs, audit snapshots), then deletes the row. A
// contact whose media could not be removed is NOT deleted (it would
// leave public files nobody can find again) and is reported as failed.
//
// Each deleted contact gets a `contact.deleted` audit row (no name /
// phone — the person is gone). Response: `{ deleted: string[], failed:
// { id, code, error }[] }`.
// ============================================================

import { NextResponse } from 'next/server'

import { AUDIT_ACTIONS } from '@/lib/audit'
import { auditStrict } from '@/lib/audit-server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { DeleteContactError, deleteContact } from '@/lib/lgpd/anonymize'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DELETE_CONTACTS_MAX_IDS = 50

const ADMIN_REQUIRED_MESSAGE =
  'Somente administradores podem excluir contatos. Peça a um administrador da conta.'

export async function DELETE(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    if (!hasMinRole(ctx.role, 'admin')) {
      return NextResponse.json({ error: ADMIN_REQUIRED_MESSAGE, code: 'admin_required' }, { status: 403 })
    }
    const limit = checkRateLimit(`admin:contact-delete:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as { ids?: unknown } | null
    const raw = Array.isArray(body?.ids) ? body.ids : []
    const ids = [...new Set(raw.filter((id): id is string => typeof id === 'string' && UUID_RE.test(id)))]
    if (ids.length === 0 || ids.length !== raw.length || ids.length > DELETE_CONTACTS_MAX_IDS) {
      return NextResponse.json(
        { error: `'ids' must list 1–${DELETE_CONTACTS_MAX_IDS} distinct contact ids` },
        { status: 400 },
      )
    }

    const admin = supabaseAdmin()
    const deleted: string[] = []
    const failed: { id: string; code: string; error: string }[] = []
    for (const id of ids) {
      try {
        const report = await deleteContact(admin, ctx.accountId, id)
        deleted.push(id)
        await auditStrict({
          accountId: ctx.accountId,
          actorUserId: ctx.userId,
          action: AUDIT_ACTIONS.CONTACT_DELETED,
          entityType: 'contact',
          entityId: id,
          metadata: {
            bulk: ids.length > 1,
            conversations: report.conversations,
            media_deleted: report.mediaDeleted,
          },
        }).catch(() => console.error('[DELETE /api/contacts] AUDIT WRITE FAILED for deleted contact', id))
      } catch (err) {
        if (err instanceof DeleteContactError) {
          if (err.warnings.length) console.error('[DELETE /api/contacts] scrub incomplete:', id, err.warnings)
          failed.push({
            id,
            code: err.code,
            error:
              err.code === 'not_found'
                ? 'Contato não encontrado.'
                : 'Não foi possível remover todos os dados do contato (mídias). Ele não foi excluído; tente novamente.',
          })
        } else {
          console.error('[DELETE /api/contacts] failed:', id, err)
          failed.push({ id, code: 'db_error', error: 'Falha ao excluir o contato.' })
        }
      }
    }

    return NextResponse.json({ deleted, failed }, { status: failed.length > 0 && deleted.length === 0 ? 500 : 200 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
