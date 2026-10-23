import { NextResponse } from 'next/server'

import { requireRole, requireWritable, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { runScheduledDispatch } from '@/lib/scheduled-messages/dispatch'
import { canManageScheduled, MAYBE_SENT } from '@/lib/scheduled-messages/permissions'

export const dynamic = 'force-dynamic'

/**
 * "Enviar agora" (pending) and "Tentar de novo" (failed): claims that one
 * row through the same atomic SQL claim the cron uses, then sends it. If
 * the cron got there first the claim is empty and nothing is sent twice.
 * The message goes out as the agent who SCHEDULED it, so only that author
 * (or an admin+) may trigger it; a row that MAY already have gone out
 * (`maybe_sent`) is only re-sent with `{ "confirm": true }`.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let ctx
  try {
    ctx = await requireWritable(await requireRole('agent'))
  } catch (err) {
    return toErrorResponse(err)
  }
  const { id } = await params
  const admin = supabaseAdmin()

  const { data } = await admin
    .from('scheduled_messages')
    .select('id, created_by, error_code')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  const owned = data as { id: string; created_by: string; error_code: string | null } | null
  if (!owned) return NextResponse.json({ error: 'Mensagem agendada não encontrada.' }, { status: 404 })
  if (!canManageScheduled(ctx.role, ctx.userId, owned.created_by)) {
    return NextResponse.json(
      { error: 'Só quem agendou a mensagem (ou um administrador) pode enviá-la.', code: 'not_author' },
      { status: 403 },
    )
  }
  if (owned.error_code === MAYBE_SENT) {
    const body = (await request.json().catch(() => null)) as { confirm?: unknown } | null
    if (body?.confirm !== true) {
      return NextResponse.json(
        {
          error: 'Esta mensagem pode já ter sido enviada. Confira a conversa e confirme para tentar de novo.',
          code: 'confirm_required',
        },
        { status: 409 },
      )
    }
  }

  // confirm is only ever true here for a maybe_sent row (checked above); the SQL claim
  // takes such a row only with p_confirm and clears its code in the same UPDATE.
  const result = await runScheduledDispatch(admin, { id, confirm: owned.error_code === MAYBE_SENT })
  if (result.claimed === 0) {
    // The claim's sweep may have just parked a stuck `sending` row: same confirmation applies.
    const { data: after } = await admin
      .from('scheduled_messages')
      .select('error_code')
      .eq('id', id)
      .maybeSingle()
    if ((after as { error_code?: string | null } | null)?.error_code === MAYBE_SENT) {
      return NextResponse.json(
        {
          error: 'Esta mensagem pode já ter sido enviada. Confira a conversa e confirme para tentar de novo.',
          code: 'confirm_required',
        },
        { status: 409 },
      )
    }
    return NextResponse.json(
      { error: 'Esta mensagem já está sendo enviada ou foi enviada.', code: 'not_claimable' },
      { status: 409 },
    )
  }
  if (result.failed > 0) {
    const { data: row } = await admin.from('scheduled_messages').select('error_text').eq('id', id).maybeSingle()
    return NextResponse.json(
      { error: (row as { error_text?: string } | null)?.error_text ?? 'Falha ao enviar.', code: 'send_failed' },
      { status: 422 },
    )
  }
  return NextResponse.json({ success: true })
}
