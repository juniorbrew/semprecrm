// ============================================================
// Página de agendamento (migration 114) — the customer's WhatsApp message
// "Código de agendamento: 123456" confirming their phone.
//
// Called by ingestInboundMessage after the message is stored (WhatsApp only,
// never Instagram / Messenger: there is no phone). The code alone proves
// nothing: the check row must belong to THIS account, still be open (not
// confirmed, not expired, attempts left) and the sender's real WhatsApp phone
// must be the phone typed on the page. Only then the row is marked confirmed
// (once: `confirmed_at IS NULL` in the update) and bound to the sender's
// contact; the browser that started it turns it into a session.
//
// A message in the exact code format is always consumed (flows, automations,
// AI and the out-of-hours notice skip it), with a short answer. Never throws.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { engineSendText } from '@/lib/automations/meta-send'
import { checkRateLimit } from '@/lib/rate-limit'

import { CHECK_MAX_ATTEMPTS, cleanName, parseCodeMessage, sameWhatsAppPhone } from './core'

export interface BookingCodeInput {
  accountId: string
  contactId: string
  contactName: string | null
  /** The phone stored on the contact the inbound pipeline resolved for this sender. */
  contactPhone: string | null
  /** Digits as the transport reported the sender (the real WhatsApp phone). */
  senderPhone: string
  conversationId: string
  /** `user_id` the answer is sent as (account owner). */
  userId: string
  type: string
  text: string | null
  now?: Date
}

export interface BookingCodeDeps {
  send?: typeof engineSendText
}

export const ACK_CONFIRMED =
  'Celular confirmado! Volte para a página de agendamento para concluir. Se não foi você quem pediu, responda avisando a gente.'
export const ACK_UNKNOWN = 'Esse código não vale mais. Volte para a página de agendamento e peça um novo.'
export const ACK_CONTACT = 'Não foi possível confirmar este celular por aqui. Fale com a empresa para agendar.'
export const ACK_OTHER_PHONE =
  'Esse código foi pedido para outro número. Envie a mensagem pelo mesmo celular informado na página.'

const TEXT_TYPES = new Set(['text'])
/** Answers per contact: someone pasting codes in a loop gets a few replies, not one per message. */
const REPLY_LIMIT = { limit: 5, windowMs: 10 * 60_000 }

export type BookingCodeOutcome = 'confirmed' | 'unknown' | 'other_phone' | 'contact_mismatch' | null

export async function tryHandleBookingCode(
  db: SupabaseClient,
  input: BookingCodeInput,
  deps: BookingCodeDeps = {},
): Promise<BookingCodeOutcome> {
  if (!TEXT_TYPES.has(input.type)) return null
  const code = parseCodeMessage(input.text)
  if (!code) return null
  let outcome: Exclude<BookingCodeOutcome, null> = 'unknown'
  try {
    outcome = await handle(db, input, code)
  } catch (err) {
    console.error('[booking-code] failed:', err instanceof Error ? err.message : err)
  }
  if (checkRateLimit(`booking-code-reply:${input.accountId}:${input.contactId}`, REPLY_LIMIT).success) {
    const text =
      outcome === 'confirmed'
        ? ACK_CONFIRMED
        : outcome === 'other_phone'
          ? ACK_OTHER_PHONE
          : outcome === 'contact_mismatch'
            ? ACK_CONTACT
            : ACK_UNKNOWN
    void (deps.send ?? engineSendText)({
      accountId: input.accountId,
      userId: input.userId,
      conversationId: input.conversationId,
      contactId: input.contactId,
      text,
      origin: 'automation',
      priority: 'interactive',
    }).catch((err: unknown) => console.error('[booking-code] answer not sent:', err instanceof Error ? err.message : err))
  }
  return outcome
}

interface CheckRow {
  id: string
  page_id: string
  phone: string
  name: string
  attempts: number
  confirmed_at: string | null
  expires_at: string
}

async function handle(db: SupabaseClient, input: BookingCodeInput, code: string): Promise<Exclude<BookingCodeOutcome, null>> {
  const now = input.now ?? new Date()
  const res = await db
    .from('booking_phone_checks')
    .select('id, page_id, phone, name, attempts, confirmed_at, expires_at')
    .eq('account_id', input.accountId)
    .eq('code', code)
    .maybeSingle()
  if (res.error) throw new Error(`check read failed: ${res.error.code ?? 'unknown'}`)
  const row = res.data as CheckRow | null
  if (!row || row.confirmed_at || Date.parse(row.expires_at) <= now.getTime() || row.attempts >= CHECK_MAX_ATTEMPTS) {
    return 'unknown'
  }

  if (!sameWhatsAppPhone(row.phone, input.senderPhone)) {
    await db.from('booking_phone_checks').update({ attempts: row.attempts + 1 }).eq('id', row.id).is('confirmed_at', null)
    return 'other_phone'
  }

  // The session will open THIS contact's appointments. The CRM merges contacts on a loose
  // last-8-digits match (another DDD, same number), so the contact must be the sender exactly.
  if (!input.contactPhone || !sameWhatsAppPhone(input.contactPhone, input.senderPhone)) return 'contact_mismatch'

  const page = await db.from('booking_pages').select('id, enabled').eq('id', row.page_id).eq('account_id', input.accountId).maybeSingle()
  if (page.error || !(page.data as { enabled?: boolean } | null)?.enabled) return 'unknown'

  // Single use: only the first message that flips confirmed_at wins.
  const upd = await db
    .from('booking_phone_checks')
    .update({ confirmed_at: now.toISOString(), contact_id: input.contactId })
    .eq('id', row.id)
    .is('confirmed_at', null)
    .gt('expires_at', now.toISOString())
    .select('id')
  if (upd.error) throw new Error(`check confirm failed: ${upd.error.code ?? 'unknown'}`)
  if (!(upd.data ?? []).length) return 'unknown'

  // A contact created by this very message is named after the WhatsApp profile / phone: use the typed name.
  const typed = cleanName(row.name)
  const current = (input.contactName ?? '').replace(/\D/g, '')
  if (typed && (!input.contactName || current === input.senderPhone.replace(/\D/g, ''))) {
    await db.from('contacts').update({ name: typed }).eq('id', input.contactId).eq('account_id', input.accountId)
  }
  return 'confirmed'
}
