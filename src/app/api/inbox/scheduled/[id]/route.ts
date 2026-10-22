import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { canManageScheduled, MAYBE_SENT } from '@/lib/scheduled-messages/permissions'
import {
  SCHEDULE_ERROR_PT,
  SCHEDULE_MIN_LEAD_MS,
  SCHEDULE_TEXT_MAX,
  validateScheduleAt,
} from '@/lib/scheduled-messages/schedule'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

const BUSY = {
  error: 'Esta mensagem já está sendo enviada ou foi enviada. Atualize a conversa.',
  code: 'not_editable',
}
const FORBIDDEN = {
  error: 'Só quem agendou a mensagem (ou um administrador) pode alterá-la.',
  code: 'not_author',
}
const CONFIRM = {
  error: 'Esta mensagem pode já ter sido enviada. Confira a conversa e confirme para tentar de novo.',
  code: 'confirm_required',
}

interface Row {
  id: string
  created_by: string
  scheduled_for: string
  status: string
  error_code: string | null
}

async function loadRow(accountId: string, id: string): Promise<Row | null> {
  const { data } = await supabaseAdmin()
    .from('scheduled_messages')
    .select('id, created_by, scheduled_for, status, error_code')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle()
  return (data as Row | null) ?? null
}

/**
 * Edit the text and/or the time. A failed message goes back to the queue,
 * so it needs a new FUTURE time when the stored one has passed, and a row
 * that may already have gone out needs an explicit `confirm`. Editing the
 * text of someone else's message (admin+) makes the editor its author: the
 * sent message is credited to whoever wrote the final words.
 */
export async function PATCH(request: Request, { params }: Ctx) {
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }
  const { id } = await params
  const body = (await request.json().catch(() => null)) as {
    content_text?: unknown
    scheduled_for?: unknown
    confirm?: unknown
  } | null

  const row = await loadRow(ctx.accountId, id)
  if (!row) return NextResponse.json({ error: 'Mensagem agendada não encontrada.' }, { status: 404 })
  if (!canManageScheduled(ctx.role, ctx.userId, row.created_by)) {
    return NextResponse.json(FORBIDDEN, { status: 403 })
  }
  if (!['pending', 'failed'].includes(row.status)) return NextResponse.json(BUSY, { status: 409 })
  if (row.error_code === MAYBE_SENT && body?.confirm !== true) return NextResponse.json(CONFIRM, { status: 409 })

  const now = new Date()
  const patch: Record<string, unknown> = {}
  if (body?.content_text !== undefined) {
    const text = typeof body.content_text === 'string' ? body.content_text.trim() : ''
    if (!text) return NextResponse.json({ error: 'A mensagem não pode ficar vazia.' }, { status: 400 })
    if (text.length > SCHEDULE_TEXT_MAX) {
      return NextResponse.json({ error: `A mensagem passa de ${SCHEDULE_TEXT_MAX} caracteres.` }, { status: 400 })
    }
    patch.content_text = text
    patch.created_by = ctx.userId
  }
  if (body?.scheduled_for !== undefined) {
    const when = validateScheduleAt(typeof body.scheduled_for === 'string' ? body.scheduled_for : null, now)
    if (!when.ok) return NextResponse.json({ error: SCHEDULE_ERROR_PT[when.code], code: when.code }, { status: 400 })
    patch.scheduled_for = when.date.toISOString()
  } else if (new Date(row.scheduled_for).getTime() < now.getTime() + SCHEDULE_MIN_LEAD_MS) {
    // Re-queuing with a time in the past would send it within the minute.
    return NextResponse.json(
      { error: 'O horário agendado já passou. Escolha um novo horário para reenviar.', code: 'needs_new_time' },
      { status: 400 },
    )
  }
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: 'Nada para alterar.' }, { status: 400 })

  // status filter = the edit loses against a claim that got there first.
  const { data, error } = await supabaseAdmin()
    .from('scheduled_messages')
    .update({ ...patch, status: 'pending', error_code: null, error_text: null, updated_at: now.toISOString() })
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .in('status', ['pending', 'failed'])
    .select('id, conversation_id, created_by, content_text, scheduled_for, timezone, status, error_code, error_text, attempts, created_at')
  if (error) {
    console.error('[scheduled] patch failed:', error.message)
    return NextResponse.json({ error: 'Não foi possível salvar.' }, { status: 500 })
  }
  if (!data?.length) return NextResponse.json(BUSY, { status: 409 })
  return NextResponse.json({ item: data[0] })
}

/** Cancel: the row is removed and its text handed back so nothing is lost. */
export async function DELETE(_request: Request, { params }: Ctx) {
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }
  const { id } = await params
  const row = await loadRow(ctx.accountId, id)
  if (!row) return NextResponse.json({ error: 'Mensagem agendada não encontrada.' }, { status: 404 })
  if (!canManageScheduled(ctx.role, ctx.userId, row.created_by)) {
    return NextResponse.json(FORBIDDEN, { status: 403 })
  }
  const { data, error } = await supabaseAdmin()
    .from('scheduled_messages')
    .delete()
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .in('status', ['pending', 'failed'])
    .select('content_text')
  if (error) {
    console.error('[scheduled] cancel failed:', error.message)
    return NextResponse.json({ error: 'Não foi possível cancelar.' }, { status: 500 })
  }
  if (!data?.length) return NextResponse.json(BUSY, { status: 409 })
  return NextResponse.json({ content_text: (data[0] as { content_text: string }).content_text })
}
