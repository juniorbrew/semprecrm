// @vitest-environment node
// Real-database check of the booking page (migration 113): phone check through
// the real inbound pipeline, booking through the real agenda RPCs, isolation
// between contacts and accounts. Needs a local Supabase with 113 applied and an
// account that has agenda services; skipped unless BOOKING_DB_TEST=1:
//
//   BOOKING_DB_TEST=1 BOOKING_DB_ACCOUNT=<account uuid> NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:56021 \
//   SUPABASE_SERVICE_ROLE_KEY=<local service key> npx vitest run src/lib/booking-page/booking.db.test.ts
//
// Everything it creates is removed at the end (the QR session row is restored).

import { randomUUID } from 'node:crypto'

import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { ingestInboundMessage } from '@/lib/whatsapp/inbound'

import { codeMessage, hashEmailCode, hashSecret, newBrowserSecret, type BookingSession } from './core'
import {
  bookForClient,
  cancelForClient,
  listMine,
  loadPageBySlug,
  loadPublicPage,
  pageSlots,
  pageState,
  readPhoneCheck,
  rescheduleForClient,
  sessionInfo,
  upsertIdentity,
  verifyEmailCode,
  revokeSessions,
  startPhoneCheck,
  usableSession,
  type BookingPageRow,
} from './server'

const RUN = process.env.BOOKING_DB_TEST === '1'
const ACCOUNT = process.env.BOOKING_DB_ACCOUNT ?? ''
const SLUG = `teste-${randomUUID().slice(0, 8)}`
const PHONE_A = `55119${String(Date.now()).slice(-8)}`
const PHONE_B = `55219${String(Date.now() + 1).slice(-8)}`
/** Same last 8 digits as A in another DDD: the CRM's loose dedupe merges it into A's contact. */
const PHONE_A_TWIN = `55319${String(Date.now()).slice(-8)}`

describe.runIf(RUN)('booking page against the local database', () => {
  let db: SupabaseClient
  let page: BookingPageRow
  let qrBefore: Record<string, unknown> | null = null
  const contacts: string[] = []
  const events: string[] = []
  let sessionA: BookingSession
  let sessionB: BookingSession

  beforeAll(async () => {
    db = supabaseAdmin()
    const qr = await db.from('wa_qr_sessions').select('*').eq('account_id', ACCOUNT).maybeSingle()
    qrBefore = qr.data
    await db.from('wa_qr_sessions').upsert({ account_id: ACCOUNT, status: 'connected', phone_number: '5511900000000' })
    const ins = await db
      .from('booking_pages')
      .insert({ account_id: ACCOUNT, slug: SLUG, enabled: true, whatsapp_number: '5511900000000', max_future_per_contact: 2, change_limit_hours: 1 })
      .select('id')
      .single()
    // One page per account: run it on an account without a booking page.
    if (ins.error) throw new Error(`create page failed: ${ins.error.message}`)
    page = (await loadPageBySlug(db, SLUG)) as BookingPageRow
  })

  afterAll(async () => {
    await db.from('booking_identities').delete().eq('account_id', ACCOUNT).like('subject', `%${SLUG}%`)
    if (events.length) await db.from('calendar_events').delete().in('id', events)
    await db.from('booking_pages').delete().eq('slug', SLUG)
    if (contacts.length) {
      await db.from('messages').delete().in('contact_id', contacts)
      await db.from('conversations').delete().in('contact_id', contacts)
      await db.from('contacts').delete().in('id', contacts)
    }
    if (qrBefore) await db.from('wa_qr_sessions').upsert(qrBefore)
    else await db.from('wa_qr_sessions').delete().eq('account_id', ACCOUNT)
  })

  async function confirm(phone: string, sender: string): Promise<{ status: string; contactId?: string }> {
    const secret = newBrowserSecret()
    const start = await startPhoneCheck(db, page, { name: 'Cliente Teste', phone, browserSecret: secret })
    if (!start.ok) throw new Error(start.reason)
    await ingestInboundMessage(
      { accountId: ACCOUNT, channel: 'qr', from: sender, messageId: `test-${randomUUID()}`, type: 'text', text: codeMessage(start.code) },
      db,
    )
    const c = await db.from('contacts').select('id').eq('account_id', ACCOUNT).eq('phone_normalized', sender).maybeSingle()
    if (c.data?.id && !contacts.includes(c.data.id)) contacts.push(c.data.id)
    const status = await readPhoneCheck(db, page, secret)
    return status.status === 'confirmed' ? { status: 'confirmed', contactId: status.contactId } : { status: status.status }
  }

  it('is usable and shows the agenda services', async () => {
    expect(await pageState(db, page)).toBe('ok')
    const pub = await loadPublicPage(db, page, 'ok')
    expect(pub.services.length).toBeGreaterThan(0)
    expect(JSON.stringify(pub)).not.toContain(ACCOUNT)
    expect(JSON.stringify(pub)).not.toContain('5511900000000')
  })

  it('refuses a code sent from another phone, accepts it from the typed phone, once', async () => {
    expect((await confirm(PHONE_A, PHONE_B)).status).toBe('pending')
    const ok = await confirm(PHONE_A, PHONE_A)
    expect(ok.status).toBe('confirmed')
    sessionA = { accountId: ACCOUNT, pageId: page.id, contactId: ok.contactId as string, identityId: null, issuedAt: Date.now() }
    // Typed and sent from the twin number, but inbound resolves A's contact: no session for A's data.
    expect((await confirm(PHONE_A_TWIN, PHONE_A_TWIN)).status).toBe('pending')
    const okB = await confirm(PHONE_B, PHONE_B)
    sessionB = { accountId: ACCOUNT, pageId: page.id, contactId: okB.contactId as string, identityId: null, issuedAt: Date.now() }
    expect(sessionB.contactId).not.toBe(sessionA.contactId)
  })

  it('books, offers alternatives on a taken slot, enforces the per-customer limit', async () => {
    const pub = await loadPublicPage(db, page, 'ok')
    const service = pub.services[0]
    const resourceId = service.resource_ids[0]
    const today = new Date().toISOString().slice(0, 10)
    let { slots } = await pageSlots(db, page, { serviceId: service.id, resourceId, from: today })
    if (slots.length < 3) slots = (await pageSlots(db, page, { serviceId: service.id, resourceId, from: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10) })).slots
    expect(slots.length).toBeGreaterThan(2)

    const first = await bookForClient(db, page, sessionA, { serviceId: service.id, resourceId, startsAt: slots[0].starts_at, idempotencyKey: randomUUID() })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    events.push(first.appointment.id)
    expect(first.appointment.booking_source).toBe('client')
    expect(first.appointment.contact_id).toBe(sessionA.contactId)

    // Same professional, same time, another customer: taken, with other free times offered.
    const clash = await bookForClient(db, page, sessionB, { serviceId: service.id, resourceId, startsAt: slots[0].starts_at, idempotencyKey: randomUUID() })
    expect(clash.ok).toBe(false)
    if (!clash.ok) {
      expect(clash.reason).toBe('unavailable')
      expect(clash.alternatives.length).toBeGreaterThan(0)
      expect(clash.alternatives.some((s) => s.starts_at === slots[0].starts_at)).toBe(false)
    }

    const later = slots[slots.length - 1]
    const second = await bookForClient(db, page, sessionA, { serviceId: service.id, resourceId, startsAt: later.starts_at, idempotencyKey: randomUUID() })
    expect(second.ok).toBe(true)
    if (second.ok) events.push(second.appointment.id)
    const third = await bookForClient(db, page, sessionA, { serviceId: service.id, resourceId, startsAt: slots[1].starts_at, idempotencyKey: randomUUID() })
    expect(third.ok).toBe(false)
    if (!third.ok) expect(third.reason).toBe('limit')

    // Reminders of the existing agenda are planned for the new appointment (097 trigger).
    const reminders = await db.from('agenda_reminders').select('id').eq('event_id', first.appointment.id)
    expect(reminders.error).toBeNull()
  })

  it('holds the per-customer limit under parallel requests (lock in booking_client_book)', async () => {
    const pub = await loadPublicPage(db, page, 'ok')
    const service = pub.services[0]
    const from = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10)
    const { slots } = await pageSlots(db, page, { serviceId: service.id, resourceId: null, from })
    expect(slots.length).toBeGreaterThan(3)
    const picks = [slots[0], slots[Math.floor(slots.length / 2)], slots[slots.length - 1]]
    const results = await Promise.all(
      picks.map((s) => bookForClient(db, page, sessionB, { serviceId: service.id, resourceId: null, startsAt: s.starts_at, idempotencyKey: randomUUID() })),
    )
    for (const r of results) if (r.ok) events.push(r.appointment.id)
    expect(results.filter((r) => r.ok).length).toBe(2)
    expect(results.filter((r) => !r.ok && r.reason === 'limit').length).toBe(1)
    // B's bookings out of the way for the isolation checks below.
    for (const r of results) if (r.ok) await db.from('calendar_events').delete().eq('id', r.appointment.id)
  })

  it('isolates contacts: B cannot see, cancel or move A’s appointments', async () => {
    const mineA = await listMine(db, page, sessionA)
    expect(mineA.length).toBe(2)
    expect(await listMine(db, page, sessionB)).toEqual([])
    await expect(cancelForClient(db, page, sessionB, mineA[0].id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(rescheduleForClient(db, page, sessionB, { eventId: mineA[0].id, startsAt: mineA[0].starts_at })).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('isolates accounts: a page of another account never reaches these appointments', async () => {
    const mineA = await listMine(db, page, sessionA)
    const foreign: BookingPageRow = { ...page, id: randomUUID(), account_id: randomUUID() }
    const foreignSession = { ...sessionA, accountId: foreign.account_id, pageId: foreign.id }
    expect(await listMine(db, foreign, foreignSession)).toEqual([])
    await expect(cancelForClient(db, foreign, foreignSession, mineA[0].id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('reschedules and cancels its own appointment', async () => {
    const mineA = await listMine(db, page, sessionA)
    const target = mineA[0]
    const { slots } = await pageSlots(db, page, { serviceId: target.service_id, resourceId: target.resource_id, from: target.starts_at.slice(0, 10) })
    const free = slots.find((s) => s.starts_at !== target.starts_at && !mineA.some((m) => m.starts_at === s.starts_at))
    expect(free).toBeTruthy()
    const moved = await rescheduleForClient(db, page, sessionA, { eventId: target.id, startsAt: free!.starts_at })
    expect(moved.ok).toBe(true)
    await cancelForClient(db, page, sessionA, target.id)
    const ev = await db.from('calendar_events').select('status').eq('id', target.id).single()
    expect(ev.data?.status).toBe('cancelled')
  })

  it('signs out every device: older sessions stop working, a new one works', async () => {
    expect(await usableSession(db, sessionA)).toBe(true)
    await revokeSessions(db, sessionA, new Date())
    expect(await usableSession(db, sessionA)).toBe(false)
    expect(await listMine(db, page, sessionA)).toEqual([])
    expect(await usableSession(db, { ...sessionA, issuedAt: Date.now() + 1000 })).toBe(true)
    await db.from('booking_session_revocations').delete().eq('contact_id', sessionA.contactId)
  })

  it('e-mail/Google identity: books under the typed phone without touching that contact, sees only its own', async () => {
    const identityId = await upsertIdentity(db, { accountId: ACCOUNT, kind: 'google', subject: `g-${SLUG}`, email: 'x@y.com', name: 'Fulana' })
    const sess: BookingSession = { accountId: ACCOUNT, pageId: page.id, contactId: null, identityId, issuedAt: Date.now() }
    expect(await sessionInfo(db, sess)).toMatchObject({ kind: 'google', needs_phone: true, name: 'Fulana' })

    const pub = await loadPublicPage(db, page, 'ok')
    const service = pub.services[0]
    const from = new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10)
    const { slots } = await pageSlots(db, page, { serviceId: service.id, resourceId: null, from })
    const noPhone = await bookForClient(db, page, sess, { serviceId: service.id, resourceId: null, startsAt: slots[0].starts_at, idempotencyKey: randomUUID() })
    expect(noPhone.ok).toBe(false)
    if (!noPhone.ok) expect(noPhone.reason).toBe('needs_phone')

    const before = await db.from('contacts').select('name').eq('id', sessionA.contactId as string).single()
    const booked = await bookForClient(db, page, sess, {
      serviceId: service.id,
      resourceId: null,
      startsAt: slots[0].starts_at,
      idempotencyKey: randomUUID(),
      details: { name: 'Outra Pessoa', phone: PHONE_A },
    })
    expect(booked.ok).toBe(true)
    if (!booked.ok) return
    events.push(booked.appointment.id)
    // Typed A's phone: the booking lands on A's contact, A's record is not renamed, staff see the note.
    expect(booked.appointment.contact_id).toBe(sessionA.contactId)
    const after = await db.from('contacts').select('name').eq('id', sessionA.contactId as string).single()
    expect(after.data?.name).toBe(before.data?.name)
    expect(booked.appointment.description ?? '').toContain('entrou com Google')
    expect(await sessionInfo(db, sess)).toMatchObject({ needs_phone: false })

    // The identity sees only what it booked; A (WhatsApp-confirmed) sees it as well as its own.
    const mineIdentity = await listMine(db, page, sess)
    expect(mineIdentity.map((m) => m.id)).toEqual([booked.appointment.id])
    const mineA = await listMine(db, page, sessionA)
    const other = mineA.find((m) => m.id !== booked.appointment.id)
    expect(mineA.some((m) => m.id === booked.appointment.id)).toBe(true)
    if (other) await expect(cancelForClient(db, page, sess, other.id)).rejects.toMatchObject({ code: 'not_found' })

    // A's contact is at the page limit (2): the identity cannot add more on that phone.
    if (mineA.length >= 2) {
      const more = await bookForClient(db, page, sess, { serviceId: service.id, resourceId: null, startsAt: slots[slots.length - 1].starts_at, idempotencyKey: randomUUID() })
      expect(more.ok).toBe(false)
      if (!more.ok) expect(more.reason).toBe('limit')
    }
  })

  it('e-mail code: wrong tries count, the right code signs in once', async () => {
    const email = `cliente-${SLUG}@exemplo.com`
    const secret = newBrowserSecret()
    await db.from('booking_email_codes').insert({
      account_id: ACCOUNT,
      page_id: page.id,
      email,
      code_hash: hashEmailCode(email, '123456'),
      browser_hash: hashSecret(secret),
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    })
    expect(await verifyEmailCode(db, page, { browserSecret: newBrowserSecret(), code: '123456' })).toEqual({ ok: false, reason: 'expired' })
    expect(await verifyEmailCode(db, page, { browserSecret: secret, code: '000000' })).toEqual({ ok: false, reason: 'wrong' })
    const ok = await verifyEmailCode(db, page, { browserSecret: secret, code: '123456' })
    expect(ok.ok).toBe(true)
    expect(await verifyEmailCode(db, page, { browserSecret: secret, code: '123456' })).toEqual({ ok: false, reason: 'expired' })
    if (ok.ok) {
      const row = await db.from('booking_identities').select('kind, subject').eq('id', ok.identityId).single()
      expect(row.data).toEqual({ kind: 'email', subject: email })
    }
  })
})
