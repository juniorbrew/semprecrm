import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  canClientChange,
  codeMessage,
  filterSlots,
  hashEmailCode,
  normalizeEmail,
  sameHash,
  isAcceptablePhone,
  isValidSlug,
  parseCodeMessage,
  sameWhatsAppPhone,
  signSession,
  slugFromName,
  startAllowed,
  verifySession,
  whatsappCodeLink,
  type BookingPageRules,
} from './core'

const SECRET = 'a'.repeat(64)
const ACC = '11111111-1111-4111-8111-111111111111'
const PAGE = '22222222-2222-4222-8222-222222222222'
const CONTACT = '33333333-3333-4333-8333-333333333333'

const RULES: BookingPageRules = {
  service_ids: null,
  resource_ids: null,
  min_notice_minutes: null,
  max_days_ahead: null,
  max_future_per_contact: 2,
  allow_cancel: true,
  allow_reschedule: true,
  change_limit_hours: 2,
}

describe('slug', () => {
  it('accepts lowercase words with single hyphens, refuses reserved and malformed', () => {
    expect(isValidSlug('barbearia-do-joao')).toBe(true)
    expect(isValidSlug('ab')).toBe(false)
    expect(isValidSlug('Barbearia')).toBe(false)
    expect(isValidSlug('a--b')).toBe(false)
    expect(isValidSlug('-abc')).toBe(false)
    expect(isValidSlug('admin')).toBe(false)
    expect(isValidSlug('x'.repeat(41))).toBe(false)
  })
  it('suggests an address from the business name', () => {
    expect(slugFromName('Barbearia do João!')).toBe('barbearia-do-joao')
    expect(slugFromName('  Salão  Bela & Cia ')).toBe('salao-bela-cia')
  })
})

describe('code message', () => {
  it('round-trips the prefilled text, with or without accents / case / spaces', () => {
    expect(parseCodeMessage(codeMessage('048213'))).toBe('048213')
    expect(parseCodeMessage('codigo de agendamento 048213')).toBe('048213')
    expect(parseCodeMessage('  CÓDIGO DE AGENDAMENTO: 048213. ')).toBe('048213')
  })
  it('ignores ordinary messages that merely contain digits', () => {
    expect(parseCodeMessage('meu cpf é 048213')).toBeNull()
    expect(parseCodeMessage('Código de agendamento: 04821')).toBeNull()
    expect(parseCodeMessage('Código de agendamento: 048213 e mais uma coisa')).toBeNull()
    expect(parseCodeMessage(null)).toBeNull()
  })
  it('builds the wa.me link only for a usable number', () => {
    expect(whatsappCodeLink('+55 (11) 98765-4321', '000001')).toBe(
      'https://wa.me/5511987654321?text=C%C3%B3digo%20de%20agendamento%3A%20000001',
    )
    expect(whatsappCodeLink('123', '000001')).toBeNull()
    expect(whatsappCodeLink(null, '000001')).toBeNull()
  })
})

describe('sameWhatsAppPhone (identity, not the loose duplicate match)', () => {
  it('matches exact and the Brazilian 9th digit variant', () => {
    expect(sameWhatsAppPhone('5511987654321', '5511987654321')).toBe(true)
    expect(sameWhatsAppPhone('5511987654321', '551187654321')).toBe(true)
    expect(sameWhatsAppPhone('551187654321', '5511987654321')).toBe(true)
  })
  it('refuses another DDD or another number with the same last 8 digits', () => {
    expect(sameWhatsAppPhone('5511987654321', '5521987654321')).toBe(false)
    expect(sameWhatsAppPhone('5511987654321', '5511887654321')).toBe(false)
    expect(sameWhatsAppPhone('15551234567', '5551234567')).toBe(false)
    expect(sameWhatsAppPhone('', '5511987654321')).toBe(false)
  })
  it('accepts typed phones with country code only', () => {
    expect(isAcceptablePhone('5511987654321')).toBe(true)
    expect(isAcceptablePhone('11987654321')).toBe(false)
  })
})

describe('session cookie', () => {
  const now = Date.UTC(2026, 10, 15)
  const token = signSession({ accountId: ACC, pageId: PAGE, contactId: CONTACT, issuedAt: now }, SECRET)

  it('verifies for the same page and account', () => {
    expect(verifySession(token, { pageId: PAGE, accountId: ACC, now, secret: SECRET })).toEqual({
      accountId: ACC,
      pageId: PAGE,
      contactId: CONTACT,
      identityId: null,
      issuedAt: now,
    })
  })

  it('carries an identity (e-mail / Google) instead of a contact, never both', () => {
    const t = signSession({ accountId: ACC, pageId: PAGE, identityId: CONTACT, issuedAt: now }, SECRET)
    expect(verifySession(t, { pageId: PAGE, accountId: ACC, now, secret: SECRET })).toMatchObject({ contactId: null, identityId: CONTACT })
    const both = Buffer.from(JSON.stringify({ a: ACC, p: PAGE, c: CONTACT, i: CONTACT, t: now })).toString('base64url')
    const sig = createHmac('sha256', createHmac('sha256', Buffer.from(SECRET, 'hex')).update('booking-session:v1').digest()).update(both).digest('hex')
    expect(verifySession(`${both}.${sig}`, { pageId: PAGE, accountId: ACC, now, secret: SECRET })).toBeNull()
  })
  it('refuses another page / account, a tampered payload, another key and an expired token', () => {
    expect(verifySession(token, { pageId: ACC, accountId: ACC, now, secret: SECRET })).toBeNull()
    expect(verifySession(token, { pageId: PAGE, accountId: PAGE, now, secret: SECRET })).toBeNull()
    const [payload, sig] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ a: ACC, p: PAGE, c: '44444444-4444-4444-8444-444444444444', t: now })).toString('base64url')
    expect(verifySession(`${forged}.${sig}`, { pageId: PAGE, accountId: ACC, now, secret: SECRET })).toBeNull()
    expect(verifySession(`${payload}.${sig}`, { pageId: PAGE, accountId: ACC, now, secret: 'b'.repeat(64) })).toBeNull()
    expect(verifySession(token, { pageId: PAGE, accountId: ACC, now: now + 31 * 86_400_000, secret: SECRET })).toBeNull()
    expect(verifySession('garbage', { pageId: PAGE, accountId: ACC, now, secret: SECRET })).toBeNull()
  })
})

describe('e-mail code', () => {
  it('normalizes e-mails and refuses junk', () => {
    expect(normalizeEmail('  Maria@Exemplo.com.BR ')).toBe('maria@exemplo.com.br')
    expect(normalizeEmail('maria@exemplo')).toBeNull()
    expect(normalizeEmail('a b@x.com')).toBeNull()
    expect(normalizeEmail(42)).toBeNull()
  })
  it('hashes the code with a server key, bound to the e-mail', () => {
    const h = hashEmailCode('a@b.com', '123456', SECRET)
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(sameHash(h, hashEmailCode('a@b.com', '123456', SECRET))).toBe(true)
    expect(sameHash(h, hashEmailCode('c@b.com', '123456', SECRET))).toBe(false)
    expect(sameHash(h, hashEmailCode('a@b.com', '123456', 'b'.repeat(64)))).toBe(false)
  })
})

describe('page rules', () => {
  const now = new Date('2026-11-15T12:00:00Z')
  const slot = (iso: string, ids: string[]) => ({ starts_at: iso, ends_at: iso, resource_ids: ids })

  it('applies the page notice and horizon on top of the agenda', () => {
    const rules = { ...RULES, min_notice_minutes: 120, max_days_ahead: 1 }
    expect(startAllowed(rules, '2026-11-15T13:00:00Z', now)).toBe(false)
    expect(startAllowed(rules, '2026-11-15T14:00:00Z', now)).toBe(true)
    expect(startAllowed(rules, '2026-11-16T12:00:01Z', now)).toBe(false)
    expect(startAllowed(rules, 'not a date', now)).toBe(false)
  })

  it('keeps only offered professionals and drops slots nobody offered is free for', () => {
    const rules = { ...RULES, resource_ids: ['r1'] }
    const out = filterSlots([slot('2026-11-16T10:00:00Z', ['r1', 'r2']), slot('2026-11-16T11:00:00Z', ['r2'])], rules, now)
    expect(out).toEqual([slot('2026-11-16T10:00:00Z', ['r1'])])
  })

  it('lets the customer change only inside the window and when allowed', () => {
    expect(canClientChange(RULES, 'cancel', '2026-11-15T14:00:00Z', now)).toBe(true)
    expect(canClientChange(RULES, 'cancel', '2026-11-15T13:59:00Z', now)).toBe(false)
    expect(canClientChange({ ...RULES, allow_reschedule: false }, 'reschedule', '2026-11-20T10:00:00Z', now)).toBe(false)
    expect(canClientChange({ ...RULES, allow_cancel: false }, 'cancel', '2026-11-20T10:00:00Z', now)).toBe(false)
  })
})
