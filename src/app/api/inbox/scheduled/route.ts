import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import {
  SCHEDULE_ACCOUNT_CAP,
  SCHEDULE_ERROR_PT,
  SCHEDULE_TEXT_MAX,
  validateScheduleAt,
} from '@/lib/scheduled-messages/schedule'
import { windowEndsAt } from '@/lib/scheduled-messages/window'

export const dynamic = 'force-dynamic'

const COLUMNS =
  'id, conversation_id, created_by, content_text, scheduled_for, timezone, status, error_code, error_text, attempts, created_at'

/**
 * Open scheduled messages (pending / sending / failed) — RLS: members of the account.
 * With `conversation_id`: that thread's panel. Without: the account-wide
 * "Agendadas" list (`mine=1` narrows it to the caller's own).
 */
export async function GET(request: Request) {
  let ctx
  try {
    ctx = await requireRole('viewer')
  } catch (err) {
    return toErrorResponse(err)
  }
  const params = new URL(request.url).searchParams
  const conversationId = params.get('conversation_id')

  if (!conversationId) {
    let q = ctx.supabase
      .from('scheduled_messages')
      .select(`${COLUMNS}, contact_id, contact:contacts(name)`)
      .eq('account_id', ctx.accountId)
      .neq('status', 'sent')
      .order('scheduled_for', { ascending: true })
      .limit(SCHEDULE_ACCOUNT_CAP)
    if (params.get('mine') === '1') q = q.eq('created_by', ctx.userId)
    const { data, error } = await q
    if (error) {
      if (/42P01|PGRST205|does not exist|schema cache/i.test(`${error.code ?? ''} ${error.message}`)) {
        return NextResponse.json({ items: [] })
      }
      console.error('[scheduled] account list failed:', error.message)
      return NextResponse.json({ error: 'Não foi possível carregar as mensagens agendadas.' }, { status: 500 })
    }
    const items = ((data ?? []) as unknown as Array<Record<string, unknown> & { contact: { name?: string | null } | { name?: string | null }[] | null }>).map(
      ({ contact, ...row }) => ({
        ...row,
        contact_name: (Array.isArray(contact) ? contact[0] : contact)?.name ?? null,
      }),
    )
    return NextResponse.json({ items })
  }

  const { data, error } = await ctx.supabase
    .from('scheduled_messages')
    .select(COLUMNS)
    .eq('conversation_id', conversationId)
    .eq('account_id', ctx.accountId)
    .neq('status', 'sent')
    .order('scheduled_for', { ascending: true })
    .limit(SCHEDULE_ACCOUNT_CAP)
  if (error) {
    // Migration 092 not applied yet: an empty list, not a broken inbox.
    if (/42P01|PGRST205|does not exist|schema cache/i.test(`${error.code ?? ''} ${error.message}`)) {
      return NextResponse.json({ items: [], window_ends_at: null })
    }
    console.error('[scheduled] list failed:', error.message)
    return NextResponse.json({ error: 'Não foi possível carregar as mensagens agendadas.' }, { status: 500 })
  }

  const { data: conv } = await ctx.supabase
    .from('conversations')
    .select('channel, last_customer_message_at')
    .eq('id', conversationId)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  const c = conv as { channel: string | null; last_customer_message_at: string | null } | null
  return NextResponse.json({
    items: data ?? [],
    window_ends_at: c && c.channel !== 'qr' ? windowEndsAt(c.last_customer_message_at) : null,
  })
}

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = (await request.json().catch(() => null)) as {
    conversation_id?: unknown
    content_text?: unknown
    scheduled_for?: unknown
    timezone?: unknown
  } | null
  const conversationId = typeof body?.conversation_id === 'string' ? body.conversation_id : ''
  const text = typeof body?.content_text === 'string' ? body.content_text.trim() : ''
  if (!conversationId) return NextResponse.json({ error: 'conversation_id is required' }, { status: 400 })
  if (!text) return NextResponse.json({ error: 'Escreva a mensagem antes de agendar.' }, { status: 400 })
  if (text.length > SCHEDULE_TEXT_MAX) {
    return NextResponse.json({ error: `A mensagem passa de ${SCHEDULE_TEXT_MAX} caracteres.` }, { status: 400 })
  }
  const when = validateScheduleAt(
    typeof body?.scheduled_for === 'string' ? body.scheduled_for : null,
    new Date(),
  )
  if (!when.ok) return NextResponse.json({ error: SCHEDULE_ERROR_PT[when.code], code: when.code }, { status: 400 })
  const timezone =
    typeof body?.timezone === 'string' && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(body.timezone)
      ? body.timezone
      : null

  const { data: conv } = await ctx.supabase
    .from('conversations')
    .select('id, status, channel, contact_id, last_customer_message_at, contact:contacts(anonymized_at)')
    .eq('id', conversationId)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  const c = conv as unknown as {
    status: string
    channel: string | null
    contact_id: string | null
    last_customer_message_at: string | null
    contact: { anonymized_at: string | null } | { anonymized_at: string | null }[] | null
  } | null
  if (!c || !c.contact_id) return NextResponse.json({ error: 'Conversa não encontrada.' }, { status: 404 })
  const contact = Array.isArray(c.contact) ? c.contact[0] : c.contact
  if (contact?.anonymized_at) {
    return NextResponse.json(
      { error: 'Este contato foi anonimizado (LGPD) e não pode receber mensagens.', code: 'contact_anonymized' },
      { status: 409 },
    )
  }

  const admin = supabaseAdmin()
  const { count } = await admin
    .from('scheduled_messages')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', ctx.accountId)
    .neq('status', 'sent')
  if ((count ?? 0) >= SCHEDULE_ACCOUNT_CAP) {
    return NextResponse.json(
      { error: `Limite de ${SCHEDULE_ACCOUNT_CAP} mensagens agendadas atingido. Cancele ou envie alguma antes.`, code: 'cap' },
      { status: 409 },
    )
  }

  const { data, error } = await admin
    .from('scheduled_messages')
    .insert({
      account_id: ctx.accountId,
      conversation_id: conversationId,
      contact_id: c.contact_id,
      created_by: ctx.userId,
      content_text: text,
      scheduled_for: when.date.toISOString(),
      timezone,
    })
    .select(COLUMNS)
    .single()
  if (error || !data) {
    if (error?.code === '54000') {
      return NextResponse.json(
        { error: `Limite de ${SCHEDULE_ACCOUNT_CAP} mensagens agendadas atingido.`, code: 'cap' },
        { status: 409 },
      )
    }
    console.error('[scheduled] insert failed:', error?.message)
    return NextResponse.json({ error: 'Não foi possível agendar a mensagem.' }, { status: 500 })
  }

  // Official channel: free text dies with the 24 h window. Scheduling past
  // it is allowed (the customer may write again) but the agent is told.
  const endsAt = c.channel !== 'qr' ? windowEndsAt(c.last_customer_message_at) : null
  const outsideWindow = c.channel !== 'qr' && (!endsAt || when.date.getTime() >= new Date(endsAt).getTime())
  return NextResponse.json({ item: data, warning: outsideWindow ? 'outside_window' : null }, { status: 201 })
}
