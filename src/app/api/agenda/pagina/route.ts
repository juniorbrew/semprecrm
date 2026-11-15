// /api/agenda/pagina — Settings → Página de agendamento (migration 114).
//
//   GET  the account's page (or null) + hints for the form: a suggested
//        address, the QR session's number, whether a WhatsApp is connected.
//   PUT  create / update it (admin). Needs the `calendar` and `booking_page`
//        modules and a writable account. Address taken by another business:
//        409 (the unique index decides; RLS hides other accounts' rows).

import { NextResponse } from 'next/server'

import { requireModule } from '@/lib/auth/account'
import { agendaContext, agendaErrorResponse, parseBody } from '@/lib/agenda/route'
import { AgendaError } from '@/lib/agenda/errors'
import { isValidSlug, slugFromName } from '@/lib/booking-page/core'
import { bookingPageSchema } from '@/lib/booking-page/schemas'
import { whatsappConnected } from '@/lib/booking-page/server'

export const dynamic = 'force-dynamic'

const COLUMNS =
  'id, slug, enabled, title, intro, whatsapp_number, show_prices, service_ids, resource_ids, min_notice_minutes, ' +
  'max_days_ahead, max_future_per_contact, allow_cancel, allow_reschedule, change_limit_hours'

export async function GET() {
  try {
    const ctx = await agendaContext('admin', false)
    await requireModule(ctx, 'booking_page', { allowReadOnly: true })
    const [page, account, qr, connected] = await Promise.all([
      ctx.supabase.from('booking_pages').select(COLUMNS).eq('account_id', ctx.accountId).maybeSingle(),
      ctx.supabase.from('accounts').select('name').eq('id', ctx.accountId).maybeSingle(),
      ctx.supabase.from('wa_qr_sessions').select('phone_number, status').eq('account_id', ctx.accountId).maybeSingle(),
      whatsappConnected(ctx.supabase, ctx.accountId),
    ])
    if (page.error) throw new AgendaError('internal')
    const suggested = slugFromName((account.data as { name?: string } | null)?.name ?? '')
    const qrRow = qr.data as { phone_number?: string | null; status?: string } | null
    return NextResponse.json({
      page: page.data ?? null,
      hints: {
        suggested_slug: isValidSlug(suggested) ? suggested : '',
        qr_number: qrRow?.status === 'connected' ? (qrRow.phone_number ?? '').replace(/\D/g, '') || null : null,
        whatsapp_connected: connected,
      },
    })
  } catch (err) {
    return agendaErrorResponse(err)
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await agendaContext('admin', true)
    await requireModule(ctx, 'booking_page')
    const body = await parseBody(request, bookingPageSchema)
    const res = await ctx.supabase
      .from('booking_pages')
      .upsert({ ...body, account_id: ctx.accountId }, { onConflict: 'account_id' })
      .select(COLUMNS)
      .single()
    if (res.error) {
      if (res.error.code === '23505') throw new AgendaError('conflict', 'Esse endereço já está em uso. Escolha outro.')
      throw new AgendaError('internal')
    }
    return NextResponse.json({ page: res.data })
  } catch (err) {
    return agendaErrorResponse(err)
  }
}
