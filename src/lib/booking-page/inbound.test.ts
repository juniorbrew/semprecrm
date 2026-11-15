import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetRateLimitForTests } from '@/lib/rate-limit'

import { codeMessage } from './core'
import { ACK_CONFIRMED, ACK_CONTACT, ACK_UNKNOWN, tryHandleBookingCode, type BookingCodeInput } from './inbound'

type Row = Record<string, unknown>

/** Just enough of the query builder for inbound.ts: select / update with eq / is / gt filters. */
function fakeDb(tables: Record<string, Row[]>) {
  const from = (table: string) => {
    const filters: ((r: Row) => boolean)[] = []
    let patch: Row | null = null
    const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)))
    const q = {
      select: () => q,
      update: (p: Row) => {
        patch = p
        return q
      },
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
      is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), q),
      gt: (c: string, v: string) => (filters.push((r) => String(r[c]) > v), q),
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) => {
        const hit = rows()
        if (patch) hit.forEach((r) => Object.assign(r, patch))
        return Promise.resolve({ data: hit, error: null }).then(resolve)
      },
    }
    return q
  }
  return { from } as unknown as SupabaseClient
}

const NOW = new Date('2026-11-15T12:00:00Z')
const ACC = 'acc-1'

function setup(check: Partial<Row> = {}) {
  const tables: Record<string, Row[]> = {
    booking_phone_checks: [
      {
        id: 'chk-1',
        account_id: ACC,
        page_id: 'page-1',
        code: '123456',
        phone: '5511987654321',
        name: 'Ana',
        attempts: 0,
        confirmed_at: null,
        contact_id: null,
        expires_at: '2026-11-15T12:05:00Z',
        ...check,
      },
    ],
    booking_pages: [{ id: 'page-1', account_id: ACC, enabled: true }],
    contacts: [{ id: 'c-1', account_id: ACC, name: '5511987654321' }],
  }
  const send = vi.fn().mockResolvedValue({ whatsapp_message_id: 'w' })
  const input: BookingCodeInput = {
    accountId: ACC,
    contactId: 'c-1',
    contactName: '5511987654321',
    contactPhone: '5511987654321',
    senderPhone: '5511987654321',
    conversationId: 'conv-1',
    userId: 'u-1',
    type: 'text',
    text: codeMessage('123456'),
    now: NOW,
  }
  return { db: fakeDb(tables), tables, send, input }
}

describe('tryHandleBookingCode', () => {
  beforeEach(() => __resetRateLimitForTests())

  it('leaves ordinary messages alone', async () => {
    const { db, send, input } = setup()
    expect(await tryHandleBookingCode(db, { ...input, text: 'oi, tudo bem? 123456' }, { send })).toBeNull()
    expect(await tryHandleBookingCode(db, { ...input, type: 'image' }, { send })).toBeNull()
    expect(send).not.toHaveBeenCalled()
  })

  it('confirms once: binds the sender contact, names it, answers; a replay is unknown', async () => {
    const { db, tables, send, input } = setup()
    expect(await tryHandleBookingCode(db, input, { send })).toBe('confirmed')
    expect(tables.booking_phone_checks[0]).toMatchObject({ contact_id: 'c-1', confirmed_at: NOW.toISOString() })
    expect(tables.contacts[0].name).toBe('Ana')
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: ACK_CONFIRMED, contactId: 'c-1' }))
    expect(await tryHandleBookingCode(db, input, { send })).toBe('unknown')
  })

  it('accepts the 12-digit form WhatsApp reports for some Brazilian mobiles', async () => {
    const { db, send, input } = setup()
    expect(await tryHandleBookingCode(db, { ...input, senderPhone: '551187654321', contactPhone: '551187654321' }, { send })).toBe('confirmed')
  })

  it('refuses a code sent from another phone and counts the attempt', async () => {
    const { db, tables, send, input } = setup()
    const other = { ...input, senderPhone: '5521987654321', contactPhone: '5521987654321' }
    expect(await tryHandleBookingCode(db, other, { send })).toBe('other_phone')
    expect(tables.booking_phone_checks[0]).toMatchObject({ attempts: 1, confirmed_at: null })
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: ACK_UNKNOWN }))
  })

  it('refuses when inbound resolved a contact whose phone is not exactly the sender (loose dedupe)', async () => {
    const { db, tables, send, input } = setup()
    expect(await tryHandleBookingCode(db, { ...input, contactPhone: '5531987654321' }, { send })).toBe('contact_mismatch')
    expect(tables.booking_phone_checks[0].confirmed_at).toBeNull()
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: ACK_CONTACT }))
  })

  it('refuses an expired, exhausted, other-account or disabled-page check', async () => {
    for (const [check, extra] of [
      [{ expires_at: '2026-11-15T11:59:00Z' }, {}],
      [{ attempts: 5 }, {}],
      [{ account_id: 'acc-2' }, {}],
    ] as const) {
      const { db, send, input } = setup(check)
      expect(await tryHandleBookingCode(db, { ...input, ...extra }, { send })).toBe('unknown')
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: ACK_UNKNOWN }))
    }
    const off = setup()
    off.tables.booking_pages[0].enabled = false
    expect(await tryHandleBookingCode(off.db, off.input, { send: off.send })).toBe('unknown')
    expect(off.tables.booking_phone_checks[0].confirmed_at).toBeNull()
  })

  it('stops answering a contact that pastes codes in a loop', async () => {
    const { db, send, input } = setup({ code: '000000' })
    for (let i = 0; i < 8; i++) await tryHandleBookingCode(db, input, { send })
    expect(send).toHaveBeenCalledTimes(5)
  })
})
