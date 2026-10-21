import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { runScheduledDispatch } from '@/lib/scheduled-messages/dispatch'

export const dynamic = 'force-dynamic'

/**
 * "Enviar agora" (pending) and "Tentar de novo" (failed): claims that one
 * row through the same atomic SQL claim the cron uses, then sends it. If
 * the cron got there first the claim is empty and nothing is sent twice.
 * The message goes out as the agent who SCHEDULED it (author is kept).
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }
  const { id } = await params
  const admin = supabaseAdmin()

  const { data: owned } = await admin
    .from('scheduled_messages')
    .select('id')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (!owned) return NextResponse.json({ error: 'Mensagem agendada não encontrada.' }, { status: 404 })

  const result = await runScheduledDispatch(admin, { id })
  if (result.claimed === 0) {
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
