// ============================================================
// POST /api/contacts/[id]/anonymize — LGPD anonymisation. Admin+.
//
// Body: `{ confirm: "<contact name>" }` — must match the contact's
// current name exactly (trimmed; the phone when the contact has no
// name), the same guard the UI dialog enforces. Irreversible; see
// src/lib/lgpd/anonymize.ts for what is scrubbed.
//
// Resumable: a contact that was marked anonymised but whose scrub did
// not finish (anonymization_completed_at NULL) can be re-run — its name
// is then "Contato anonimizado", which is what `confirm` must say.
// Responses: 200 `{ ok: true, result }` when everything was scrubbed;
// 207 `{ ok: false, code: 'anonymization_incomplete', result }` when a
// step failed (re-run to finish) or the audit row could not be written.
//
// Audited as `contact.anonymized` WITHOUT the former name / phone (the
// scrub also drops them from the contact's earlier audit rows).
//
// The contact is looked up with the caller's RLS-scoped client (so a
// contact outside the account is a 404), then the scrub itself runs
// with the service role — it has to update messages and remove
// storage objects across RLS boundaries.
// ============================================================

import { NextResponse } from 'next/server'

import { AUDIT_ACTIONS } from '@/lib/audit'
import { auditStrict } from '@/lib/audit-server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { AnonymizeError, anonymizeContact } from '@/lib/lgpd/anonymize'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(`admin:contact-anonymize:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Invalid contact id' }, { status: 400 })
    }

    const body = (await request.json().catch(() => null)) as { confirm?: unknown } | null
    const confirm = typeof body?.confirm === 'string' ? body.confirm.trim() : ''
    if (!confirm) {
      return NextResponse.json({ error: "'confirm' must be the contact's name" }, { status: 400 })
    }

    const { data: contact, error: readErr } = await ctx.supabase
      .from('contacts')
      .select('id, name, phone, anonymized_at, anonymization_completed_at')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (readErr) {
      console.error('[POST /api/contacts/:id/anonymize] read failed:', readErr)
      return NextResponse.json({ error: 'Failed to load contact' }, { status: 500 })
    }
    if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    const row = contact as {
      name: string | null
      phone: string
      anonymized_at: string | null
      anonymization_completed_at: string | null
    }
    if (row.anonymized_at && row.anonymization_completed_at) {
      return NextResponse.json(
        { error: 'Contact is already anonymized', code: 'already_anonymized' },
        { status: 409 },
      )
    }

    const expected = (row.name?.trim() || row.phone).trim()
    if (confirm !== expected) {
      return NextResponse.json(
        { error: 'Confirmation does not match the contact name', code: 'confirm_mismatch' },
        { status: 400 },
      )
    }

    const admin = supabaseAdmin()
    let result
    try {
      result = await anonymizeContact(admin, ctx.accountId, id)
    } catch (err) {
      if (err instanceof AnonymizeError) {
        const status =
          err.code === 'not_found' ? 404 : err.code === 'already_anonymized' ? 409 : 500
        return NextResponse.json({ error: err.message, code: err.code }, { status })
      }
      console.error('[POST /api/contacts/:id/anonymize] failed:', err)
      return NextResponse.json({ error: 'Failed to anonymize contact' }, { status: 500 })
    }

    const audited = await auditStrict({
      accountId: ctx.accountId,
      actorUserId: ctx.userId,
      action: AUDIT_ACTIONS.CONTACT_ANONYMIZED,
      entityType: 'contact',
      entityId: id,
      metadata: {
        resumed: result.resumed,
        completed: result.completed,
        conversations: result.conversations,
        messages_scrubbed: result.messagesScrubbed,
        media_deleted: result.mediaDeleted,
        notes_deleted: result.notesDeleted,
        custom_values_deleted: result.customValuesDeleted,
        ai_memories_deleted: result.memoriesDeleted,
        warnings: result.warnings.slice(0, 20),
      },
    }).then(
      () => true,
      () => false,
    )
    if (!audited) {
      console.error('[POST /api/contacts/:id/anonymize] AUDIT WRITE FAILED for contact', id)
      result.warnings.push('audit_log: write failed')
    }

    if (!result.completed || !audited) {
      return NextResponse.json(
        {
          ok: false,
          code: result.completed ? 'audit_failed' : 'anonymization_incomplete',
          error: result.completed
            ? 'Os dados foram removidos, mas o registro na auditoria falhou. Avise o suporte.'
            : 'A anonimização não foi concluída. O contato já está bloqueado; tente novamente para terminar a remoção dos dados.',
          result,
        },
        { status: 207 },
      )
    }
    return NextResponse.json({ ok: true, result })
  } catch (err) {
    return toErrorResponse(err)
  }
}
