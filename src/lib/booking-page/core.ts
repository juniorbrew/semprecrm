// ============================================================
// Página de agendamento (migration 113) — pure rules, no I/O.
//
//   slug            the public address /agendar/<slug>
//   phone check     the customer SENDS "Código de agendamento: 123456" to the
//                   business on WhatsApp; inbound matches account + code +
//                   expiry + attempts + the sender's REAL phone = the typed one
//   session         signed cookie {account, page, contact, issued} (30 days),
//                   HMAC with a subkey of ENCRYPTION_KEY
//   page rules      services / professionals offered, notice, horizon, how
//                   many future bookings, until when the customer may change
// ============================================================

import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'

import type { Slot } from '@/lib/agenda/types'

export const SLUG_RE = /^[a-z0-9](-?[a-z0-9])+$/
export const SLUG_MIN = 3
export const SLUG_MAX = 40
/** Words that read like the product itself or a system page. */
export const RESERVED_SLUGS = new Set([
  'admin', 'api', 'app', 'agendar', 'agenda', 'login', 'semprecrm', 'suporte', 'support', 'teste', 'test',
  'www', 'manifest', 'icon', 'icons', 'meus', 'novo', 'nova', 'config', 'settings', 'plataforma', 'platform', 'google',
])

export function isValidSlug(slug: unknown): slug is string {
  return (
    typeof slug === 'string' &&
    slug.length >= SLUG_MIN &&
    slug.length <= SLUG_MAX &&
    SLUG_RE.test(slug) &&
    !RESERVED_SLUGS.has(slug)
  )
}

/** "Barbearia do João" -> "barbearia-do-joao" (a suggestion; validity is checked separately). */
export function slugFromName(name: string): string {
  return (name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '')
}

// ------------------------------------------------------------
// Phone check
// ------------------------------------------------------------

export const CHECK_TTL_MS = 10 * 60_000
export const CHECK_MAX_ATTEMPTS = 5
export const CODE_PREFIX = 'Código de agendamento:'

export function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

/** The prefilled message the customer sends. */
export function codeMessage(code: string): string {
  return `${CODE_PREFIX} ${code}`
}

/**
 * The code in a customer's message, or null. The whole message must be the
 * prefilled text (the customer may add nothing but spaces), so an ordinary
 * message that happens to hold 6 digits is never taken as a code.
 */
export function parseCodeMessage(text: string | null | undefined): string | null {
  if (typeof text !== 'string' || text.length > 80) return null
  const folded = text.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase()
  const m = /^codigo de agendamento\s*:?\s*(\d{6})\s*\.?$/.exec(folded)
  return m ? m[1] : null
}

/**
 * Whether the phone a person TYPED (already normalized, digits with country
 * code) is the WhatsApp sender. Exact, or — Brazil only — the same mobile with
 * and without the 9th digit (WhatsApp still reports some accounts in the old
 * 12-digit form). Never the loose last-8-digits match used for duplicates:
 * this is an identity check.
 */
export function sameWhatsAppPhone(typed: string, sender: string): boolean {
  const a = (typed ?? '').replace(/\D/g, '')
  const b = (sender ?? '').replace(/\D/g, '')
  if (!a || !b) return false
  if (a === b) return true
  const strip9 = (p: string) => (p.startsWith('55') && p.length === 13 && p[4] === '9' ? p.slice(0, 4) + p.slice(5) : p)
  const isBr12 = (p: string) => p.startsWith('55') && p.length === 12
  const sa = strip9(a)
  const sb = strip9(b)
  return sa === sb && isBr12(sa)
}

/** A typed phone we accept: digits with country code, 12–15 long (BR mobile = 13). */
export function isAcceptablePhone(phone: string): boolean {
  return /^[1-9]\d{11,14}$/.test(phone)
}

export function newBrowserSecret(): string {
  return randomBytes(32).toString('hex')
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

export function isBrowserSecret(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

/** wa.me link with the code message, or null when the number is not usable. */
export function whatsappCodeLink(number: string | null | undefined, code: string): string | null {
  const digits = (number ?? '').replace(/\D/g, '')
  if (!/^[1-9]\d{9,14}$/.test(digits)) return null
  return `https://wa.me/${digits}?text=${encodeURIComponent(codeMessage(code))}`
}

// ------------------------------------------------------------
// E-mail code (114)
// ------------------------------------------------------------

export const EMAIL_CODE_TTL_MS = 10 * 60_000
export const EMAIL_CODE_MAX_ATTEMPTS = 5
export const EMAIL_COOKIE = 'sc_agendar_email'

/** Lowercased, trimmed e-mail, or null when it does not look like one. */
export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const e = input.trim().toLowerCase()
  if (e.length < 3 || e.length > 254) return null
  return /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/.test(e) ? e : null
}

function codeKey(secret: string | undefined = process.env.ENCRYPTION_KEY): Buffer {
  const hex = (secret ?? '').trim()
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('ENCRYPTION_KEY must be 64 hex chars to hash booking codes')
  return createHmac('sha256', Buffer.from(hex, 'hex')).update('booking-email-code:v1').digest()
}

/** HMAC of a 6-digit code (a plain hash of 1,000,000 values would be trivial to reverse). */
export function hashEmailCode(email: string, code: string, secret?: string): string {
  return createHmac('sha256', codeKey(secret)).update(`${email}:${code}`).digest('hex')
}

export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

// ------------------------------------------------------------
// Session cookie
// ------------------------------------------------------------

export const SESSION_MAX_AGE_S = 30 * 24 * 3600
export const SESSION_COOKIE = 'sc_agendar'
export const CHECK_COOKIE = 'sc_agendar_check'

/**
 * Exactly one of the two:
 *   contactId   the phone was confirmed on WhatsApp: the session sees that contact's appointments
 *   identityId  entered with e-mail / Google (114): sees only what this identity booked
 */
export interface BookingSession {
  accountId: string
  pageId: string
  contactId: string | null
  identityId: string | null
  issuedAt: number
}

function sessionKey(secret: string | undefined = process.env.ENCRYPTION_KEY): Buffer {
  const hex = (secret ?? '').trim()
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('ENCRYPTION_KEY must be 64 hex chars to sign the booking session')
  return createHmac('sha256', Buffer.from(hex, 'hex')).update('booking-session:v1').digest()
}

const sign = (payload: string, secret?: string) => createHmac('sha256', sessionKey(secret)).update(payload).digest('hex')

export function signSession(
  s: { accountId: string; pageId: string; issuedAt?: number } & ({ contactId: string } | { identityId: string }),
  secret?: string,
): string {
  const who = 'contactId' in s ? { c: s.contactId } : { i: s.identityId }
  const body = { a: s.accountId, p: s.pageId, ...who, t: s.issuedAt ?? Date.now() }
  const payload = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url')
  return `${payload}.${sign(payload, secret)}`
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Null on a bad signature, malformed payload, expiry, or a session for another page. */
export function verifySession(
  token: string | null | undefined,
  opts: { pageId: string; accountId: string; now?: number; secret?: string },
): BookingSession | null {
  if (typeof token !== 'string' || token.length > 1024) return null
  const dot = token.indexOf('.')
  if (dot <= 0) return null
  const payload = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  let expected: string
  try {
    expected = sign(payload, opts.secret)
  } catch {
    return null
  }
  const a = Buffer.from(sig, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  let body: { a?: unknown; p?: unknown; c?: unknown; i?: unknown; t?: unknown }
  try {
    body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof body.a !== 'string' || typeof body.p !== 'string' || typeof body.t !== 'number') return null
  const contact = typeof body.c === 'string' && UUID_RE.test(body.c) ? body.c : null
  const identity = typeof body.i === 'string' && UUID_RE.test(body.i) ? body.i : null
  if (!contact === !identity || (body.c !== undefined && !contact) || (body.i !== undefined && !identity)) return null
  if (body.a !== opts.accountId || body.p !== opts.pageId) return null
  const now = opts.now ?? Date.now()
  if (body.t > now + 60_000 || now - body.t > SESSION_MAX_AGE_S * 1000) return null
  return { accountId: body.a, pageId: body.p, contactId: contact, identityId: identity, issuedAt: body.t }
}

// ------------------------------------------------------------
// Page rules
// ------------------------------------------------------------

export interface BookingPageRules {
  service_ids: string[] | null
  resource_ids: string[] | null
  min_notice_minutes: number | null
  max_days_ahead: number | null
  max_future_per_contact: number
  allow_cancel: boolean
  allow_reschedule: boolean
  change_limit_hours: number
}

export function serviceOffered(rules: Pick<BookingPageRules, 'service_ids'>, serviceId: string): boolean {
  return !rules.service_ids || rules.service_ids.includes(serviceId)
}

export function resourceOffered(rules: Pick<BookingPageRules, 'resource_ids'>, resourceId: string): boolean {
  return !rules.resource_ids || rules.resource_ids.includes(resourceId)
}

/**
 * The page's own limits on top of the agenda's (both apply; the stricter
 * wins): drop slots too soon or too far, keep only the professionals the page
 * offers, drop slots nobody offered is free for.
 */
export function filterSlots(slots: readonly Slot[], rules: BookingPageRules, now: Date): Slot[] {
  const out: Slot[] = []
  for (const s of slots) {
    if (!startAllowed(rules, s.starts_at, now)) continue
    const ids = s.resource_ids.filter((id) => resourceOffered(rules, id))
    if (ids.length) out.push({ ...s, resource_ids: ids })
  }
  return out
}

/** Whether a start passes the page's own notice / horizon (the agenda re-checks its own rules). */
export function startAllowed(
  rules: Pick<BookingPageRules, 'min_notice_minutes' | 'max_days_ahead'>,
  startsAt: string,
  now: Date,
): boolean {
  const start = Date.parse(startsAt)
  if (!Number.isFinite(start)) return false
  if (start < now.getTime() + (rules.min_notice_minutes ?? 0) * 60_000) return false
  return rules.max_days_ahead == null || start <= now.getTime() + rules.max_days_ahead * 86_400_000
}

/** The customer may cancel / move it only up to `change_limit_hours` before the start. */
export function canClientChange(
  rules: Pick<BookingPageRules, 'allow_cancel' | 'allow_reschedule' | 'change_limit_hours'>,
  kind: 'cancel' | 'reschedule',
  startsAt: string,
  now: Date,
): boolean {
  if (kind === 'cancel' ? !rules.allow_cancel : !rules.allow_reschedule) return false
  return Date.parse(startsAt) - now.getTime() >= rules.change_limit_hours * 3_600_000
}

/** Display name a person typed: trimmed, inner spaces collapsed, control chars out. */
export function cleanName(input: unknown): string {
  if (typeof input !== 'string') return ''
  return input.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
}
