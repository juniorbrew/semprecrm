// ============================================================
// Página de agendamento (migration 114) — server side.
//
// Everything here runs with the SERVICE-ROLE client: the public page has no
// user session. So every read is scoped by the page row (found by its slug)
// and, after the phone check, by the signed session's contact. Nothing that
// points at CRM rows is ever taken from the request except ids that are
// re-checked against the page (service, professional) or the session
// (appointment -> its contact).
//
// The agenda rules live in src/lib/agenda/service.ts (hours, days off,
// buffers, notice, horizon, conflicts) and the database constraint is the
// guarantee against two bookings in the same slot. This file only adds the
// page's own rules on top.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { loadConfig, loadTimezone, resourcesForService } from '@/lib/agenda/data'
import { AgendaError, isAgendaError } from '@/lib/agenda/errors'
import {
  bookAppointment,
  getAppointment,
  getAvailability,
  listUpcomingForContact,
  rescheduleAppointment,
  setAppointmentStatus,
  type RpcWriter,
} from '@/lib/agenda/service'
import type { Slot } from '@/lib/agenda/types'
import { shiftDate, todayIn } from '@/lib/agenda/ui'
import { parseBranding } from '@/lib/branding'
import { accountHasModule, accountIsWritable } from '@/lib/plans-server'
import type { CalendarEvent } from '@/types'

import {
  canClientChange,
  CHECK_TTL_MS,
  cleanName,
  filterSlots,
  generateCode,
  hashSecret,
  resourceOffered,
  serviceOffered,
  startAllowed,
  whatsappCodeLink,
  type BookingPageRules,
  type BookingSession,
} from './core'

export interface BookingPageRow extends BookingPageRules {
  id: string
  account_id: string
  slug: string
  enabled: boolean
  title: string | null
  intro: string | null
  whatsapp_number: string | null
  show_prices: boolean
}

const PAGE_COLUMNS =
  'id, account_id, slug, enabled, title, intro, whatsapp_number, show_prices, service_ids, resource_ids, ' +
  'min_notice_minutes, max_days_ahead, max_future_per_contact, allow_cancel, allow_reschedule, change_limit_hours'

export async function loadPageBySlug(db: SupabaseClient, slug: string): Promise<BookingPageRow | null> {
  const res = await db.from('booking_pages').select(PAGE_COLUMNS).eq('slug', slug).maybeSingle()
  if (res.error) throw new Error(`booking page read failed: ${res.error.code ?? 'unknown'}`)
  return (res.data as unknown as BookingPageRow | null) ?? null
}

/** Is a WhatsApp number of the account connected (official config or QR session)? */
export async function whatsappConnected(db: SupabaseClient, accountId: string): Promise<boolean> {
  const [official, qr] = await Promise.all([
    db.from('whatsapp_config').select('id').eq('account_id', accountId).eq('status', 'connected').limit(1),
    db.from('wa_qr_sessions').select('account_id').eq('account_id', accountId).eq('status', 'connected').limit(1),
  ])
  return (official.data ?? []).length > 0 || (qr.data ?? []).length > 0
}

/**
 * 'ok'           customers can book
 * 'off'          page off, module not in the plan, or account blocked: the page does not exist (404)
 * 'unavailable'  read-only account (billing): the page shows "indisponível no momento"
 * 'no_whatsapp'  no connected WhatsApp / no number: nobody can confirm a phone, so nobody books
 */
export type PageState = 'ok' | 'off' | 'unavailable' | 'no_whatsapp'

export async function pageState(db: SupabaseClient, page: BookingPageRow | null): Promise<PageState> {
  if (!page || !page.enabled) return 'off'
  const [booking, calendar] = await Promise.all([
    accountHasModule(db, page.account_id, 'booking_page', { allowReadOnly: true }),
    accountHasModule(db, page.account_id, 'calendar', { allowReadOnly: true }),
  ])
  if (!booking || !calendar) return 'off'
  if (!(await accountIsWritable(db, page.account_id))) return 'unavailable'
  if (!page.whatsapp_number || !(await whatsappConnected(db, page.account_id))) return 'no_whatsapp'
  return 'ok'
}

// ------------------------------------------------------------
// What the customer sees
// ------------------------------------------------------------

export interface PublicService {
  id: string
  name: string
  description: string | null
  duration_minutes: number
  price_cents: number | null
  resource_ids: string[]
}

export interface PublicResource {
  id: string
  name: string
  color: string | null
}

export interface PublicPage {
  slug: string
  name: string
  intro: string | null
  logo_url: string | null
  color: string | null
  timezone: string
  state: PageState
  services: PublicService[]
  resources: PublicResource[]
  rules: { allow_cancel: boolean; allow_reschedule: boolean; change_limit_hours: number }
}

export async function loadPublicPage(db: SupabaseClient, page: BookingPageRow, state: PageState): Promise<PublicPage> {
  const [account, config] = await Promise.all([
    db.from('accounts').select('name, branding').eq('id', page.account_id).maybeSingle(),
    loadConfig(db, page.account_id),
  ])
  const branding = parseBranding((account.data as { branding?: unknown } | null)?.branding)
  const offered = new Set<string>()
  const services: PublicService[] = []
  if (state === 'ok') {
    for (const s of config.services) {
      if (!s.is_active || !serviceOffered(page, s.id)) continue
      const ids = resourcesForService(config, s.id).filter((r) => resourceOffered(page, r.id)).map((r) => r.id)
      if (!ids.length) continue
      ids.forEach((id) => offered.add(id))
      services.push({
        id: s.id,
        name: s.name,
        description: s.description,
        duration_minutes: s.duration_minutes,
        price_cents: page.show_prices ? s.price_cents : null,
        resource_ids: ids,
      })
    }
  }
  return {
    slug: page.slug,
    name: page.title || ((account.data as { name?: string } | null)?.name ?? '') || 'Agendamento',
    intro: page.intro,
    logo_url: branding.logo_url,
    color: branding.primary_color,
    timezone: config.timezone,
    state,
    services,
    resources: config.resources
      .filter((r) => offered.has(r.id))
      .map((r) => ({ id: r.id, name: r.name, color: r.color })),
    rules: { allow_cancel: page.allow_cancel, allow_reschedule: page.allow_reschedule, change_limit_hours: page.change_limit_hours },
  }
}

/** Days the customer sees per request. */
export const SLOT_DAYS = 7

export async function pageSlots(
  db: SupabaseClient,
  page: BookingPageRow,
  q: { serviceId: string; resourceId: string | null; from: string; now?: Date },
): Promise<{ timezone: string; slots: Slot[] }> {
  if (!serviceOffered(page, q.serviceId)) throw new AgendaError('not_found', 'Serviço não encontrado.')
  if (q.resourceId && !resourceOffered(page, q.resourceId)) throw new AgendaError('not_found', 'Profissional não encontrado.')
  const now = q.now ?? new Date()
  const res = await getAvailability(db, {
    accountId: page.account_id,
    serviceId: q.serviceId,
    resourceId: q.resourceId,
    from: q.from,
    to: shiftDate(q.from, SLOT_DAYS - 1),
    now,
    source: 'client',
  })
  return { timezone: res.timezone, slots: filterSlots(res.slots, page, now) }
}

// ------------------------------------------------------------
// Phone check
// ------------------------------------------------------------

/** Active (not expired) checks one phone may have open on one page. */
export const MAX_OPEN_CHECKS_PER_PHONE = 3

export type StartCheckResult =
  | { ok: true; code: string; whatsappUrl: string; expiresAt: string }
  | { ok: false; reason: 'too_many' | 'no_whatsapp' }

export async function startPhoneCheck(
  db: SupabaseClient,
  page: BookingPageRow,
  input: { name: string; phone: string; browserSecret: string; now?: Date },
): Promise<StartCheckResult> {
  const now = input.now ?? new Date()
  // Housekeeping: expired checks are worthless (indexed on expires_at).
  await db.from('booking_phone_checks').delete().lt('expires_at', now.toISOString())

  const open = await db
    .from('booking_phone_checks')
    .select('id', { count: 'exact', head: true })
    .eq('page_id', page.id)
    .eq('phone', input.phone)
  if (open.error) throw new Error(`booking check read failed: ${open.error.code ?? 'unknown'}`)
  if ((open.count ?? 0) >= MAX_OPEN_CHECKS_PER_PHONE) return { ok: false, reason: 'too_many' }

  const expiresAt = new Date(now.getTime() + CHECK_TTL_MS).toISOString()
  for (let i = 0; i < 5; i++) {
    const code = generateCode()
    const url = whatsappCodeLink(page.whatsapp_number, code)
    if (!url) return { ok: false, reason: 'no_whatsapp' }
    const ins = await db.from('booking_phone_checks').insert({
      account_id: page.account_id,
      page_id: page.id,
      code,
      phone: input.phone,
      name: cleanName(input.name) || 'Cliente',
      browser_hash: hashSecret(input.browserSecret),
      expires_at: expiresAt,
    })
    if (!ins.error) return { ok: true, code, whatsappUrl: url, expiresAt }
    if (ins.error.code !== '23505') throw new Error(`booking check insert failed: ${ins.error.code ?? 'unknown'}`)
  }
  throw new Error('booking check: no free code')
}

export type CheckStatus = { status: 'pending' } | { status: 'expired' } | { status: 'confirmed'; contactId: string }

/**
 * The browser that started the check (its HttpOnly secret) asks whether the
 * customer already sent the code. A confirmed check is consumed here (deleted:
 * single use) and turns into a session for that contact.
 */
export async function readPhoneCheck(
  db: SupabaseClient,
  page: BookingPageRow,
  browserSecret: string,
  now: Date = new Date(),
): Promise<CheckStatus> {
  const res = await db
    .from('booking_phone_checks')
    .select('id, contact_id, confirmed_at, expires_at')
    .eq('page_id', page.id)
    .eq('browser_hash', hashSecret(browserSecret))
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (res.error) throw new Error(`booking check read failed: ${res.error.code ?? 'unknown'}`)
  const row = res.data as { id: string; contact_id: string | null; confirmed_at: string | null; expires_at: string } | null
  if (!row) return { status: 'expired' }
  if (row.confirmed_at && row.contact_id) {
    const del = await db.from('booking_phone_checks').delete().eq('id', row.id).select('id')
    // Two polls at once: only the one that deleted the row gets the session.
    if (del.error || !(del.data ?? []).length) return { status: 'expired' }
    return { status: 'confirmed', contactId: row.contact_id }
  }
  if (Date.parse(row.expires_at) <= now.getTime()) {
    await db.from('booking_phone_checks').delete().eq('id', row.id)
    return { status: 'expired' }
  }
  return { status: 'pending' }
}

// ------------------------------------------------------------
// Contact + bookings of the session
// ------------------------------------------------------------

async function usableContact(db: SupabaseClient, session: BookingSession): Promise<boolean> {
  const res = await db
    .from('contacts')
    .select('id, anonymized_at')
    .eq('account_id', session.accountId)
    .eq('id', session.contactId)
    .maybeSingle()
  if (res.error) throw new Error(`contact read failed: ${res.error.code ?? 'unknown'}`)
  const c = res.data as { anonymized_at: string | null } | null
  return !!c && !c.anonymized_at
}

export interface MyAppointment {
  id: string
  service_id: string
  service: string
  resource_id: string | null
  professional: string | null
  starts_at: string
  ends_at: string
  status: string
  can_cancel: boolean
  can_reschedule: boolean
}

export async function listMine(
  db: SupabaseClient,
  page: BookingPageRow,
  session: BookingSession,
  now: Date = new Date(),
): Promise<MyAppointment[]> {
  if (!(await usableContact(db, session))) return []
  const [events, config] = await Promise.all([
    listUpcomingForContact(db, { accountId: page.account_id, contactId: session.contactId, now, limit: 20 }),
    loadConfig(db, page.account_id),
  ])
  return events
    .filter((e) => e.service_id)
    .map((e) => ({
      id: e.id,
      service_id: e.service_id as string,
      service: config.services.find((s) => s.id === e.service_id)?.name ?? 'Atendimento',
      resource_id: e.resource_id ?? null,
      professional: config.resources.find((r) => r.id === e.resource_id)?.name ?? null,
      starts_at: e.starts_at,
      ends_at: e.ends_at,
      status: e.status as string,
      can_cancel: canClientChange(page, 'cancel', e.starts_at, now),
      can_reschedule: canClientChange(page, 'reschedule', e.starts_at, now),
    }))
}

export type BookResult =
  | { ok: true; appointment: CalendarEvent }
  | { ok: false; reason: 'limit' | 'contact' | 'unavailable'; message: string; alternatives: Slot[] }

/** The next free slots of the same service / professional, for a "this one was taken" answer. */
async function alternativesFor(
  db: SupabaseClient,
  page: BookingPageRow,
  serviceId: string,
  resourceId: string | null,
  startsAt: string,
  now: Date,
): Promise<Slot[]> {
  try {
    const timezone = await loadTimezone(db, page.account_id)
    const from = todayIn(timezone, new Date(Math.max(Date.parse(startsAt) || 0, now.getTime())))
    const { slots } = await pageSlots(db, page, { serviceId, resourceId, from, now })
    return slots.filter((s) => s.starts_at !== startsAt).slice(0, 6)
  } catch {
    return []
  }
}

const RETRY_NEXT = new Set(['slot_taken', 'busy', 'resource_unavailable', 'outside_hours', 'service_not_offered'])

/** booking_client_book refused: the contact reached the page's limit (AG012). */
class ClientLimitError extends Error {}

function limitResult(count: number): BookResult {
  return {
    ok: false,
    reason: 'limit',
    message: `Você já tem ${count} horário(s) marcado(s). Cancele um para marcar outro ou fale com a empresa.`,
    alternatives: [],
  }
}

export async function bookForClient(
  db: SupabaseClient,
  page: BookingPageRow,
  session: BookingSession,
  input: { serviceId: string; resourceId: string | null; startsAt: string; idempotencyKey: string; now?: Date },
): Promise<BookResult> {
  const now = input.now ?? new Date()
  if (!serviceOffered(page, input.serviceId)) throw new AgendaError('not_found', 'Serviço não encontrado.')
  if (input.resourceId && !resourceOffered(page, input.resourceId)) throw new AgendaError('not_found', 'Profissional não encontrado.')
  if (!(await usableContact(db, session))) {
    return { ok: false, reason: 'contact', message: 'Não foi possível agendar para este celular. Fale com a empresa.', alternatives: [] }
  }

  // The same key returns the same appointment (double tap, retry after a timeout).
  const key = `client:${page.id}:${input.idempotencyKey}`
  const prior = await db.from('calendar_events').select('*').eq('account_id', page.account_id).eq('idempotency_key', key).maybeSingle()
  if (prior.data) {
    const p = prior.data as CalendarEvent
    if (p.contact_id !== session.contactId) throw new AgendaError('idempotency_conflict')
    return { ok: true, appointment: p }
  }

  const upcoming = await listUpcomingForContact(db, { accountId: page.account_id, contactId: session.contactId, now, limit: 11 })
  if (upcoming.length >= page.max_future_per_contact) return limitResult(upcoming.length)

  const unavailable = async (message: string): Promise<BookResult> => ({
    ok: false,
    reason: 'unavailable',
    message,
    alternatives: await alternativesFor(db, page, input.serviceId, input.resourceId, input.startsAt, now),
  })

  if (!startAllowed(page, input.startsAt, now)) return unavailable('Esse horário não está disponível para agendamento online.')

  let candidates: string[]
  if (input.resourceId) {
    candidates = [input.resourceId]
  } else {
    const config = await loadConfig(db, page.account_id)
    candidates = resourcesForService(config, input.serviceId).filter((r) => resourceOffered(page, r.id)).map((r) => r.id)
  }

  // The count above is the friendly early answer; the guarantee is booking_client_book (114),
  // which locks the contact and counts again in the booking's own transaction.
  const writer: RpcWriter = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn !== 'agenda_book_appointment') return db.rpc(fn, args)
      const res = await db.rpc('booking_client_book', {
        p_account_id: args.p_account_id,
        p_service_id: args.p_service_id,
        p_resource_id: args.p_resource_id,
        p_contact_id: args.p_contact_id,
        p_starts_at: args.p_starts_at,
        p_max_future: page.max_future_per_contact,
        p_idempotency_key: args.p_idempotency_key,
      })
      if (res.error?.code === 'AG012') throw new ClientLimitError()
      return res
    },
  } as unknown as RpcWriter

  let last: AgendaError | null = null
  for (const resourceId of candidates) {
    try {
      const appointment = await bookAppointment(
        db,
        {
          accountId: page.account_id,
          actorId: null,
          serviceId: input.serviceId,
          resourceId,
          contactId: session.contactId,
          startsAt: input.startsAt,
          source: 'client',
          idempotencyKey: key,
          now,
        },
        writer,
      )
      return { ok: true, appointment }
    } catch (err) {
      if (err instanceof ClientLimitError) return limitResult(page.max_future_per_contact)
      if (isAgendaError(err) && (RETRY_NEXT.has(err.code) || err.code === 'min_notice' || err.code === 'max_ahead')) {
        last = err
        continue
      }
      throw err
    }
  }
  return unavailable(last && last.code !== 'busy' ? last.message : 'Esse horário acabou de ser ocupado. Escolha outro horário.')
}

/** The session's own open appointment on this page's account, or a not_found error. */
async function ownAppointment(db: SupabaseClient, page: BookingPageRow, session: BookingSession, eventId: string): Promise<CalendarEvent> {
  const ev = await getAppointment(db, page.account_id, eventId)
  if (!ev || ev.contact_id !== session.contactId || (ev.status !== 'scheduled' && ev.status !== 'confirmed')) {
    throw new AgendaError('not_found', 'Agendamento não encontrado.')
  }
  return ev
}

export async function cancelForClient(
  db: SupabaseClient,
  page: BookingPageRow,
  session: BookingSession,
  eventId: string,
  now: Date = new Date(),
): Promise<void> {
  const ev = await ownAppointment(db, page, session, eventId)
  if (!canClientChange(page, 'cancel', ev.starts_at, now)) {
    throw new AgendaError('forbidden', 'Não é mais possível cancelar por aqui. Fale com a empresa.')
  }
  await setAppointmentStatus(db, { accountId: page.account_id, eventId, status: 'cancelled', now }, db)
}

export async function rescheduleForClient(
  db: SupabaseClient,
  page: BookingPageRow,
  session: BookingSession,
  input: { eventId: string; startsAt: string; now?: Date },
): Promise<BookResult> {
  const now = input.now ?? new Date()
  const ev = await ownAppointment(db, page, session, input.eventId)
  if (!canClientChange(page, 'reschedule', ev.starts_at, now)) {
    throw new AgendaError('forbidden', 'Não é mais possível remarcar por aqui. Fale com a empresa.')
  }
  const serviceId = ev.service_id as string
  const resourceId = ev.resource_id ?? null
  const unavailable = async (message: string): Promise<BookResult> => ({
    ok: false,
    reason: 'unavailable',
    message,
    alternatives: await alternativesFor(db, page, serviceId, resourceId, input.startsAt, now),
  })
  if (!startAllowed(page, input.startsAt, now)) return unavailable('Esse horário não está disponível para agendamento online.')
  try {
    const appointment = await rescheduleAppointment(
      db,
      { accountId: page.account_id, eventId: ev.id, startsAt: input.startsAt, source: 'client', now },
      db,
    )
    return { ok: true, appointment }
  } catch (err) {
    if (isAgendaError(err) && (RETRY_NEXT.has(err.code) || err.code === 'min_notice' || err.code === 'max_ahead')) {
      return unavailable(err.code === 'busy' ? 'Esse horário acabou de ser ocupado. Escolha outro horário.' : err.message)
    }
    throw err
  }
}
