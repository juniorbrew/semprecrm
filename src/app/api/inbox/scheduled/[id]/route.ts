import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { SCHEDULE_ERROR_PT, SCHEDULE_TEXT_MAX, validateScheduleAt } from '@/lib/scheduled-messages/schedule'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

const BUSY = {
  error: 'Esta mensagem já está sendo enviada ou foi enviada. Atualize a conversa.',
  code: 'not_editable',
}

/** Edit the text and/or the time. A failed message goes back to the queue. */
export async function PATCH(request: Request, { params }: Ctx) {
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }
  const { id } = await params
  const body = (await request.json().catch(() => null)) as { content_text?: unknown; scheduled_for?: unknown } | null

  const patch: Record<string, unknown> = {}
  if (body?.content_text !== undefined) {
    const text = typeof body.content_text === 'string' ? body.content_text.trim() : ''
    if (!text) return NextResponse.json({ error: 'A mensagem não pode ficar vazia.' }, { status: 400 })
    if (text.length > SCHEDULE_TEXT_MAX) {
      return NextResponse.json({ error: `A mensagem passa de ${SCHEDULE_TEXT_MAX} caracteres.` }, { status: 400 })
    }
    patch.content_text = text
  }
  if (body?.scheduled_for !== undefined) {
    const when = validateScheduleAt(typeof body.scheduled_for === 'string' ? body.scheduled_for : null, new Date())
    if (!when.ok) return NextResponse.json({ error: SCHEDULE_ERROR_PT[when.code], code: when.code }, { status: 400 })
    patch.scheduled_for = when.date.toISOString()
  }
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: 'Nada para alterar.' }, { status: 400 })

  // status filter = the edit loses against a claim that got there first.
  const { data, error } = await supabaseAdmin()
    .from('scheduled_messages')
    .update({ ...patch, status: 'pending', error_code: null, error_text: null, updated_at: new Date().toISOString() })
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
