// ============================================================
// POST /api/contacts/[id]/anonymize — LGPD anonymisation. Admin+.
//
// Body: `{ confirm: "<contact name>" }` — must match the contact's
// current name exactly (trimmed; the phone when the contact has no
// name), the same guard the UI dialog enforces. Irreversible; see
// src/lib/lgpd/anonymize.ts for what is scrubbed. Audited as
// `contact.anonymized` with the pre-anonymisation name so the trail
// still says who the record used to be.
//
// The contact is looked up with the caller's RLS-scoped client (so a
// contact outside the account is a 404), then the scrub itself runs
// with the service role — it has to update messages and remove
// storage objects across RLS boundaries.
// ============================================================

import { NextResponse } from 'next/server'

import { AUDIT_ACTIONS, logAudit } from '@/lib/audit'
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
      .select('id, name, phone, anonymized_at')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (readErr) {
      console.error('[POST /api/contacts/:id/anonymize] read failed:', readErr)
      return NextResponse.json({ error: 'Failed to load contact' }, { status: 500 })
    }
    if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    const row = contact as { name: string | null; phone: string; anonymized_at: string | null }
    if (row.anonymized_at) {
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

    await logAudit(admin, {
      accountId: ctx.accountId,
      actorUserId: ctx.userId,
      action: AUDIT_ACTIONS.CONTACT_ANONYMIZED,
      entityType: 'contact',
      entityId: id,
      metadata: {
        contact_name: row.name ?? null,
        conversations: result.conversations,
        messages_scrubbed: result.messagesScrubbed,
        media_deleted: result.mediaDeleted,
        notes_deleted: result.notesDeleted,
        custom_values_deleted: result.customValuesDeleted,
        warnings: result.warnings,
      },
    })

    return NextResponse.json({ ok: true, result })
  } catch (err) {
    return toErrorResponse(err)
  }
}
