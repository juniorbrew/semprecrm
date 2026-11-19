// ============================================================
// Página de agendamento (migration 113) — server side.
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
import { isMailConfigured, sendMail } from '@/lib/mail/smtp'

import { googleConfigured } from './google'
import { findSuppressedPhones } from '@/lib/lgpd/suppression'
import { accountHasModule, accountIsWritable } from '@/lib/plans-server'
import type { CalendarEvent } from '@/types'

import {
  canClientChange,
  EMAIL_CODE_MAX_ATTEMPTS,
  EMAIL_CODE_TTL_MS,
  hashEmailCode,
  sameHash,
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
  /** Ways to sign in besides WhatsApp: shown only when the server can do them (SMTP / Google client). */
  login: { email: boolean; google: boolean }
  /** max_days_ahead: the stricter of the page and the agenda (the week arrows stop there). */
  rules: { allow_cancel: boolean; allow_reschedule: boolean; change_limit_hours: number; max_days_ahead: number }
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
    login: { email: isMailConfigured(), google: googleConfigured() },
    rules: {
      allow_cancel: page.allow_cancel,
      allow_reschedule: page.allow_reschedule,
      change_limit_hours: page.change_limit_hours,
      max_days_ahead: Math.min(page.max_days_ahead ?? Infinity, config.settings.max_days_ahead),
    },
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
// Session: a confirmed contact (WhatsApp) or an identity (e-mail / Google, 114)
// ------------------------------------------------------------

interface IdentityRow {
  id: string
  kind: 'email' | 'google'
  email: string | null
  name: string | null
  contact_id: string | null
  revoked_before: string | null
}

async function loadIdentity(db: SupabaseClient, session: BookingSession): Promise<IdentityRow | null> {
  if (!session.identityId) return null
  const res = await db
    .from('booking_identities')
    .select('id, kind, email, name, contact_id, revoked_before')
    .eq('account_id', session.accountId)
    .eq('id', session.identityId)
    .maybeSingle()
  if (res.error) throw new Error(`identity read failed: ${res.error.code ?? 'unknown'}`)
  const row = res.data as IdentityRow | null
  if (!row) return null
  if (row.revoked_before && session.issuedAt <= Date.parse(row.revoked_before)) return null
  return row
}

async function contactUsable(db: SupabaseClient, accountId: string, contactId: string): Promise<boolean> {
  const res = await db.from('contacts').select('id, anonymized_at').eq('account_id', accountId).eq('id', contactId).maybeSingle()
  if (res.error) throw new Error(`contact read failed: ${res.error.code ?? 'unknown'}`)
  const c = res.data as { anonymized_at: string | null } | null
  return !!c && !c.anonymized_at
}

/**
 * The session still works: its contact exists, is not anonymised and was not
 * signed out of every device after the session was issued (113); or its
 * identity exists and was not signed out (114).
 */
export async function usableSession(db: SupabaseClient, session: BookingSession): Promise<boolean> {
  if (session.identityId) return !!(await loadIdentity(db, session))
  if (!session.contactId) return false
  const [ok, revoked] = await Promise.all([
    contactUsable(db, session.accountId, session.contactId),
    db
      .from('booking_session_revocations')
      .select('revoked_before')
      .eq('account_id', session.accountId)
      .eq('contact_id', session.contactId)
      .maybeSingle(),
  ])
  if (revoked.error) throw new Error(`revocation read failed: ${revoked.error.code ?? 'unknown'}`)
  const before = (revoked.data as { revoked_before?: string } | null)?.revoked_before
  return ok && (!before || session.issuedAt > Date.parse(before))
}

export interface SessionInfo {
  kind: 'whatsapp' | 'email' | 'google'
  /** E-mail / Google identity that has not given a phone yet: the next booking asks for it. */
  needs_phone: boolean
  /** The name the customer gave (or Google's), to prefill the form. */
  name: string | null
}

export async function sessionInfo(db: SupabaseClient, session: BookingSession | null): Promise<SessionInfo | null> {
  if (!session) return null
  if (session.identityId) {
    const identity = await loadIdentity(db, session)
    if (!identity) return null
    const hasContact = !!identity.contact_id && (await contactUsable(db, session.accountId, identity.contact_id))
    return { kind: identity.kind, needs_phone: !hasContact, name: identity.name }
  }
  return (await usableSession(db, session)) ? { kind: 'whatsapp', needs_phone: false, name: null } : null
}

/** Ends every session of this contact / identity on this account (every device). */
export async function revokeSessions(db: SupabaseClient, session: BookingSession, now: Date = new Date()): Promise<void> {
  const res = session.identityId
    ? await db
        .from('booking_identities')
        .update({ revoked_before: now.toISOString() })
        .eq('account_id', session.accountId)
        .eq('id', session.identityId)
    : await db
        .from('booking_session_revocations')
        .upsert({ account_id: session.accountId, contact_id: session.contactId, revoked_before: now.toISOString() })
  if (res.error) throw new Error(`revoke failed: ${res.error.code ?? 'unknown'}`)
}

/** Creates or updates the identity of an e-mail / Google login; returns its id. */
export async function upsertIdentity(
  db: SupabaseClient,
  input: { accountId: string; kind: 'email' | 'google'; subject: string; email: string | null; name: string | null },
): Promise<string> {
  const row: Record<string, unknown> = { account_id: input.accountId, kind: input.kind, subject: input.subject, email: input.email }
  if (input.name) row.name = cleanName(input.name) || null
  const res = await db.from('booking_identities').upsert(row, { onConflict: 'account_id,kind,subject' }).select('id').single()
  if (res.error || !res.data) throw new Error(`identity upsert failed: ${res.error?.code ?? 'unknown'}`)
  return (res.data as { id: string }).id
}

/** Same mobile with and without the Brazilian 9th digit (exact match otherwise). */
function phoneForms(phone: string): string[] {
  if (phone.startsWith('55') && phone.length === 13 && phone[4] === '9') return [phone, phone.slice(0, 4) + phone.slice(5)]
  if (phone.startsWith('55') && phone.length === 12) return [phone, phone.slice(0, 4) + '9' + phone.slice(4)]
  return [phone]
}

/**
 * The contact of a phone an e-mail / Google customer TYPED (not confirmed):
 * exact number only, and an existing contact is never renamed or changed —
 * typing someone's number must not touch their record. Null when that number
 * belongs to an anonymised contact.
 */
async function contactForTypedPhone(db: SupabaseClient, accountId: string, phone: string, name: string): Promise<string | null> {
  const forms = phoneForms(phone)
  const found = await db
    .from('contacts')
    .select('id, anonymized_at')
    .eq('account_id', accountId)
    .in('phone_normalized', forms)
    .order('created_at')
    .limit(1)
  if (found.error) throw new Error(`contact read failed: ${found.error.code ?? 'unknown'}`)
  const hit = (found.data ?? [])[0] as { id: string; anonymized_at: string | null } | undefined
  if (hit) return hit.anonymized_at ? null : hit.id

  const account = await db.from('accounts').select('owner_user_id').eq('id', accountId).maybeSingle()
  const owner = (account.data as { owner_user_id?: string } | null)?.owner_user_id
  if (!owner) throw new Error('account owner not found')
  // Fail closed: if the opt-out list cannot be read, no new contact is created from a typed phone.
  const suppressed = (await findSuppressedPhones(db, accountId, [phone])).size > 0
  const ins = await db
    .from('contacts')
    .insert({ account_id: accountId, user_id: owner, phone, name, ...(suppressed ? { opted_out_at: new Date().toISOString() } : {}) })
    .select('id')
    .single()
  if (!ins.error) return (ins.data as { id: string }).id
  if (ins.error.code === '23505') return contactForTypedPhone(db, accountId, phone, name)
  throw new Error(`contact insert failed: ${ins.error.code ?? 'unknown'}`)
}

/** L3: the customer sees / changes only appointments of what this page offers (not every staff booking). */
function offeredEvent(page: BookingPageRow, e: Pick<CalendarEvent, 'service_id' | 'resource_id'>): boolean {
  return !!e.service_id && serviceOffered(page, e.service_id) && (!e.resource_id || resourceOffered(page, e.resource_id))
}

/** Upcoming open appointments this session may see: its contact's, or only those its identity booked. */
async function sessionUpcoming(db: SupabaseClient, page: BookingPageRow, session: BookingSession, now: Date): Promise<CalendarEvent[]> {
  if (session.contactId) return listUpcomingForContact(db, { accountId: page.account_id, contactId: session.contactId, now, limit: 20 })
  const links = await db
    .from('booking_identity_events')
    .select('event_id')
    .eq('account_id', page.account_id)
    .eq('identity_id', session.identityId as string)
    .limit(200)
  if (links.error) throw new Error(`identity events read failed: ${links.error.code ?? 'unknown'}`)
  const ids = (links.data ?? []).map((l) => (l as { event_id: string }).event_id)
  if (!ids.length) return []
  const res = await db
    .from('calendar_events')
    .select('*')
    .eq('account_id', page.account_id)
    .in('id', ids)
    .not('service_id', 'is', null)
    .in('status', ['scheduled', 'confirmed'])
    .gte('ends_at', now.toISOString())
    .order('starts_at')
    .limit(20)
  if (res.error) throw new Error(`identity events read failed: ${res.error.code ?? 'unknown'}`)
  return (res.data ?? []) as CalendarEvent[]
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
  if (!(await usableSession(db, session))) return []
  const [events, config] = await Promise.all([sessionUpcoming(db, page, session, now), loadConfig(db, page.account_id)])
  return events
    .filter((e) => offeredEvent(page, e))
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
  | { ok: false; reason: 'limit' | 'contact' | 'unavailable' | 'needs_phone'; message: string; alternatives: Slot[] }

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

/** booking_client_book refused: the contact or identity reached the page's limit (AG012). */
class ClientLimitError extends Error {}

function limitResult(count: number): BookResult {
  return {
    ok: false,
    reason: 'limit',
    message: `Você já tem ${count} horário(s) marcado(s). Cancele um para marcar outro ou fale com a empresa.`,
    alternatives: [],
  }
}

const CONTACT_FAIL: BookResult = {
  ok: false,
  reason: 'contact',
  message: 'Não foi possível agendar para este celular. Fale com a empresa.',
  alternatives: [],
}

export async function bookForClient(
  db: SupabaseClient,
  page: BookingPageRow,
  session: BookingSession,
  input: {
    serviceId: string
    resourceId: string | null
    startsAt: string
    idempotencyKey: string
    /** E-mail / Google customers without a phone yet: name + typed phone (not confirmed). */
    details?: { name: string; phone: string } | null
    now?: Date
  },
): Promise<BookResult> {
  const now = input.now ?? new Date()
  if (!serviceOffered(page, input.serviceId)) throw new AgendaError('not_found', 'Serviço não encontrado.')
  if (input.resourceId && !resourceOffered(page, input.resourceId)) throw new AgendaError('not_found', 'Profissional não encontrado.')

  // Who the appointment is for.
  let contactId: string
  let identity: IdentityRow | null = null
  if (session.identityId) {
    identity = await loadIdentity(db, session)
    if (!identity) return CONTACT_FAIL
    if (identity.contact_id && (await contactUsable(db, page.account_id, identity.contact_id))) {
      contactId = identity.contact_id
    } else {
      if (!input.details) {
        return { ok: false, reason: 'needs_phone', message: 'Informe seu nome e celular para os lembretes.', alternatives: [] }
      }
      const found = await contactForTypedPhone(db, page.account_id, input.details.phone, input.details.name)
      if (!found) return CONTACT_FAIL
      contactId = found
      const upd = await db
        .from('booking_identities')
        .update({ contact_id: contactId, name: input.details.name })
        .eq('account_id', page.account_id)
        .eq('id', identity.id)
      if (upd.error) throw new Error(`identity update failed: ${upd.error.code ?? 'unknown'}`)
    }
  } else {
    if (!session.contactId || !(await usableSession(db, session))) return CONTACT_FAIL
    contactId = session.contactId
  }

  // The same key returns the same appointment (double tap, retry after a timeout).
  const key = `client:${page.id}:${input.idempotencyKey}`
  const prior = await db.from('calendar_events').select('*').eq('account_id', page.account_id).eq('idempotency_key', key).maybeSingle()
  // Needed here (not only inside bookAppointment) so a retry after the limit is reached still gets its booking.
  if (prior.data) {
    const p = prior.data as CalendarEvent
    if (p.contact_id !== contactId) throw new AgendaError('idempotency_conflict')
    if (p.status === 'scheduled' || p.status === 'confirmed') return { ok: true, appointment: p }
    throw new AgendaError('idempotency_conflict', 'Esse agendamento foi cancelado. Escolha o horário de novo.')
  }

  // Friendly early answer for logins; the database (booking_client_book) is the guarantee for everyone.
  const upcoming = await sessionUpcoming(db, page, session, now)
  let counted = upcoming.length
  if (!identity && upcoming.length) {
    // WhatsApp customer: bookings made by e-mail / Google logins with this phone typed in do not count.
    const linked = await db.from('booking_identity_events').select('event_id').in('event_id', upcoming.map((e) => e.id))
    if (linked.error) throw new Error(`identity events read failed: ${linked.error.code ?? 'unknown'}`)
    counted -= (linked.data ?? []).length
  }
  if (counted >= page.max_future_per_contact) return limitResult(counted)

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

  // Staff see who booked and that the phone was not confirmed (the name, never the e-mail).
  const notes = identity
    ? `Agendado pelo link (entrou com ${identity.kind === 'google' ? 'Google' : 'e-mail'}) — celular não confirmado.`
    : null

  // The count above is the friendly early answer; the guarantee is booking_client_book (113/114),
  // which locks the contact (and the identity) and counts again in the booking's own transaction.
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
        p_identity_id: identity?.id ?? null,
        p_notes: notes,
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
          contactId,
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
  let mine = false
  if (ev && session.contactId) mine = ev.contact_id === session.contactId
  if (ev && session.identityId) {
    const link = await db
      .from('booking_identity_events')
      .select('event_id')
      .eq('account_id', page.account_id)
      .eq('identity_id', session.identityId)
      .eq('event_id', ev.id)
      .maybeSingle()
    mine = !!link.data
  }
  if (
    !ev ||
    !mine ||
    (ev.status !== 'scheduled' && ev.status !== 'confirmed') ||
    !offeredEvent(page, ev) ||
    !(await usableSession(db, session))
  ) {
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

// ------------------------------------------------------------
// E-mail code (114): we send a 6-digit code; the device that asked types it
// ------------------------------------------------------------

/** Codes one e-mail may have open on one page (each send is an e-mail out). */
export const MAX_OPEN_EMAIL_CODES = 3

export type StartEmailResult = { ok: true } | { ok: false; reason: 'too_many' | 'mail_off' | 'send_failed' }

export async function startEmailCode(
  db: SupabaseClient,
  page: BookingPageRow,
  input: { email: string; browserSecret: string; businessName: string; now?: Date },
): Promise<StartEmailResult> {
  if (!isMailConfigured()) return { ok: false, reason: 'mail_off' }
  const now = input.now ?? new Date()
  await db.from('booking_email_codes').delete().lt('expires_at', now.toISOString())
  const open = await db
    .from('booking_email_codes')
    .select('id', { count: 'exact', head: true })
    .eq('page_id', page.id)
    .eq('email', input.email)
  if (open.error) throw new Error(`email code read failed: ${open.error.code ?? 'unknown'}`)
  if ((open.count ?? 0) >= MAX_OPEN_EMAIL_CODES) return { ok: false, reason: 'too_many' }

  const code = generateCode()
  const ins = await db
    .from('booking_email_codes')
    .insert({
      account_id: page.account_id,
      page_id: page.id,
      email: input.email,
      code_hash: hashEmailCode(input.email, code),
      browser_hash: hashSecret(input.browserSecret),
      expires_at: new Date(now.getTime() + EMAIL_CODE_TTL_MS).toISOString(),
    })
    .select('id')
    .single()
  if (ins.error) throw new Error(`email code insert failed: ${ins.error.code ?? 'unknown'}`)
  const name = input.businessName.replace(/[\r\n]+/g, ' ').slice(0, 80)
  const sent = await sendMail({
    to: input.email,
    subject: 'Seu código de agendamento',
    text:
      `Seu código para entrar na página de agendamento de ${name} é: ${code}\n\n` +
      'Ele vale por 10 minutos. Se não foi você quem pediu, ignore este e-mail.',
  })
  if (!sent) {
    await db.from('booking_email_codes').delete().eq('id', (ins.data as { id: string }).id)
    return { ok: false, reason: 'send_failed' }
  }
  return { ok: true }
}

export type VerifyEmailResult = { ok: true; identityId: string } | { ok: false; reason: 'wrong' | 'expired' | 'too_many' }

export async function verifyEmailCode(
  db: SupabaseClient,
  page: BookingPageRow,
  input: { browserSecret: string; code: string; now?: Date },
): Promise<VerifyEmailResult> {
  const now = input.now ?? new Date()
  const res = await db
    .from('booking_email_codes')
    .select('id, email, code_hash, attempts, expires_at')
    .eq('page_id', page.id)
    .eq('browser_hash', hashSecret(input.browserSecret))
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (res.error) throw new Error(`email code read failed: ${res.error.code ?? 'unknown'}`)
  const row = res.data as { id: string; email: string; code_hash: string; attempts: number; expires_at: string } | null
  if (!row || Date.parse(row.expires_at) <= now.getTime() || row.attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
    if (row) await db.from('booking_email_codes').delete().eq('id', row.id)
    return { ok: false, reason: row && row.attempts >= EMAIL_CODE_MAX_ATTEMPTS ? 'too_many' : 'expired' }
  }
  // The attempt is counted in the database BEFORE comparing (parallel guesses cannot all see 0).
  const tried = await db.rpc('booking_email_code_try', { p_id: row.id, p_max_attempts: EMAIL_CODE_MAX_ATTEMPTS })
  if (tried.error) throw new Error(`email code try failed: ${tried.error.code ?? 'unknown'}`)
  const attempt = ((tried.data ?? []) as { email: string; code_hash: string; attempts: number }[])[0]
  if (!attempt) return { ok: false, reason: 'too_many' }
  if (!/^\d{6}$/.test(input.code) || !sameHash(attempt.code_hash, hashEmailCode(attempt.email, input.code))) {
    return { ok: false, reason: attempt.attempts >= EMAIL_CODE_MAX_ATTEMPTS ? 'too_many' : 'wrong' }
  }
  // Single use: only the request that deletes the row signs in.
  const del = await db.from('booking_email_codes').delete().eq('id', row.id).select('id')
  if (del.error || !(del.data ?? []).length) return { ok: false, reason: 'expired' }
  const identityId = await upsertIdentity(db, { accountId: page.account_id, kind: 'email', subject: row.email, email: row.email, name: null })
  return { ok: true, identityId }
}
