import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  gatewayConfigured: true,
  gatewayCalls: [] as Record<string, unknown>[],
  metaCalls: [] as Record<string, unknown>[],
}))

vi.mock('./qr-gateway', () => ({
  isGatewayConfigured: () => h.gatewayConfigured,
  markReadViaGateway: vi.fn(async (input: Record<string, unknown>) => {
    h.gatewayCalls.push(input)
    return { read: (input.messageIds as string[]).length }
  }),
}))

vi.mock('./meta-api', () => ({
  markMessageRead: vi.fn(async (input: Record<string, unknown>) => {
    h.metaCalls.push(input)
  }),
}))

vi.mock('./encryption', () => ({ decrypt: (v: string) => `plain:${v}` }))

import { ConversationNotFoundError, sendReadReceipts } from './read-receipts'

type Row = Record<string, unknown>

function makeDb(tables: Record<string, Row[]>) {
  const updates: { table: string; payload: Row }[] = []
  function builder(table: string) {
    const filters: ((r: Row) => boolean)[] = []
    let op: 'select' | 'update' = 'select'
    let payload: Row = {}
    let desc = false
    let limitN = Infinity
    const rows = () => {
      let r = (tables[table] ?? []).filter((x) => filters.every((f) => f(x)))
      r = [...r].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) * (desc ? -1 : 1))
      return r.slice(0, limitN)
    }
    const run = () => {
      if (op === 'update') {
        updates.push({ table, payload })
        for (const r of rows()) Object.assign(r, payload)
        return { data: null, error: null }
      }
      return { data: rows(), error: null }
    }
    const b: Record<string, unknown> = {
      select: () => b,
      update: (p: Row) => ((op = 'update'), (payload = p), b),
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), b),
      not: (k: string) => (filters.push((r) => r[k] != null), b),
      gt: (k: string, v: unknown) => (filters.push((r) => String(r[k]) > String(v)), b),
      order: (_k: string, o: { ascending: boolean }) => ((desc = !o.ascending), b),
      limit: (n: number) => ((limitN = n), b),
      maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
      then: (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) => Promise.resolve(run()).then(f, r),
    }
    return b
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: { from: (t: string) => builder(t) } as any, updates, tables }
}

const ACCOUNT = 'acct-1'

function seed(channel: 'qr' | 'official', readAt: string | null = null) {
  return makeDb({
    conversations: [{ id: 'conv-1', account_id: ACCOUNT, channel, contact_id: 'c1', read_receipt_at: readAt }],
    contacts: [{ id: 'c1', account_id: ACCOUNT, phone: '+55 (11) 98888-7777' }],
    messages: [
      { conversation_id: 'conv-1', sender_type: 'customer', message_id: 'M1', created_at: '2026-09-26T10:00:00Z' },
      { conversation_id: 'conv-1', sender_type: 'agent', message_id: 'A1', created_at: '2026-09-26T10:01:00Z' },
      { conversation_id: 'conv-1', sender_type: 'customer', message_id: 'M2', created_at: '2026-09-26T10:02:00Z' },
    ],
    whatsapp_config: [{ account_id: ACCOUNT, phone_number_id: 'pn-1', access_token: 'enc' }],
  })
}

beforeEach(() => {
  h.gatewayConfigured = true
  h.gatewayCalls = []
  h.metaCalls = []
})

describe('sendReadReceipts', () => {
  it('QR: confirms the customer messages oldest-first through the gateway and remembers the newest', async () => {
    const { db, tables } = seed('qr')
    const res = await sendReadReceipts(db, { accountId: ACCOUNT, conversationId: 'conv-1' })
    expect(res).toEqual({ sent: 2 })
    expect(h.gatewayCalls).toEqual([{ accountId: ACCOUNT, to: '5511988887777', messageIds: ['M1', 'M2'] }])
    expect(tables.conversations[0].read_receipt_at).toBe('2026-09-26T10:02:00Z')
  })

  it('only sends what is newer than the last confirmation', async () => {
    const { db } = seed('qr', '2026-09-26T10:00:00Z')
    await sendReadReceipts(db, { accountId: ACCOUNT, conversationId: 'conv-1' })
    expect(h.gatewayCalls[0].messageIds).toEqual(['M2'])
  })

  it('does nothing when everything is already confirmed', async () => {
    const { db } = seed('qr', '2026-09-26T10:02:00Z')
    expect(await sendReadReceipts(db, { accountId: ACCOUNT, conversationId: 'conv-1' })).toEqual({
      sent: 0,
      skipped: 'nothing_new',
    })
    expect(h.gatewayCalls).toHaveLength(0)
  })

  it('official channel: marks only the newest message through Meta', async () => {
    const { db } = seed('official')
    const res = await sendReadReceipts(db, { accountId: ACCOUNT, conversationId: 'conv-1' })
    expect(res).toEqual({ sent: 2 })
    expect(h.metaCalls).toEqual([{ phoneNumberId: 'pn-1', accessToken: 'plain:enc', messageId: 'M2' }])
  })

  it('skips quietly without a gateway, and never touches another account', async () => {
    h.gatewayConfigured = false
    const { db, tables } = seed('qr')
    expect((await sendReadReceipts(db, { accountId: ACCOUNT, conversationId: 'conv-1' })).skipped).toBe(
      'gateway_not_configured',
    )
    expect(tables.conversations[0].read_receipt_at).toBeNull()
    await expect(sendReadReceipts(db, { accountId: 'other', conversationId: 'conv-1' })).rejects.toBeInstanceOf(
      ConversationNotFoundError,
    )
  })
})
