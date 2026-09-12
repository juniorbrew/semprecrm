import { beforeEach, describe, expect, it, vi } from 'vitest'

// ------------------------------------------------------------
// /api/channels/qr/{inbound,ack,status-event} — the gateway → app
// callbacks. Only `x-gateway-secret` authenticates them; writes go
// through the service-role client.
// ------------------------------------------------------------

const h = vi.hoisted(() => ({
  ingest: vi.fn(),
  writes: [] as { table: string; op: string; payload: unknown; filters: [string, unknown][] }[],
}))

vi.mock('@/lib/whatsapp/inbound', () => ({
  ingestInboundMessage: h.ingest,
}))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const filters: [string, unknown][] = []
      const rec = { table, op: '', payload: undefined as unknown, filters }
      const b: Record<string, unknown> = {
        update: (p: unknown) => ((rec.op = 'update'), (rec.payload = p), h.writes.push(rec), b),
        upsert: (p: unknown) => ((rec.op = 'upsert'), (rec.payload = p), h.writes.push(rec), b),
        select: () => b,
        eq: (k: string, v: unknown) => (filters.push([k, v]), b),
        maybeSingle: () => Promise.resolve({ data: rec.payload, error: null }),
        then: (onF: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(onF),
      }
      return b
    },
  }),
}))

import { POST as inbound } from './inbound/route'
import { POST as ack } from './ack/route'
import { POST as statusEvent } from './status-event/route'
import { POST as statusPost } from './status/route'

const SECRET = 'a-very-long-shared-secret'

function req(path: string, body: unknown, secret: string | null = SECRET) {
  return new Request(`http://localhost/api/channels/qr/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret !== null ? { 'x-gateway-secret': secret } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

beforeEach(() => {
  process.env.WA_GATEWAY_URL = 'http://gateway.test:3201'
  process.env.WA_GATEWAY_SECRET = SECRET
  h.writes.length = 0
  h.ingest.mockReset()
  h.ingest.mockResolvedValue({ ok: true, conversationId: 'conv-1' })
})

describe('gateway secret', () => {
  it('401 without the header', async () => {
    expect((await inbound(req('inbound', {}, null))).status).toBe(401)
    expect((await ack(req('ack', {}, null))).status).toBe(401)
    expect((await statusEvent(req('status-event', {}, null))).status).toBe(401)
  })

  it('401 with a wrong secret (same length too)', async () => {
    expect((await ack(req('ack', {}, 'nope'))).status).toBe(401)
    const sameLen = 'b'.repeat(SECRET.length)
    expect((await ack(req('ack', {}, sameLen))).status).toBe(401)
    expect(h.ingest).not.toHaveBeenCalled()
  })

  it('401 (fail closed) when WA_GATEWAY_SECRET is unset', async () => {
    delete process.env.WA_GATEWAY_SECRET
    expect((await inbound(req('inbound', {}, SECRET))).status).toBe(401)
  })

  it('400 on invalid JSON', async () => {
    expect((await inbound(req('inbound', '{not json'))).status).toBe(400)
  })
})

describe('POST /inbound', () => {
  it('validates the payload', async () => {
    const res = await inbound(req('inbound', { account_id: 'a', message_id: 'm' }))
    expect(res.status).toBe(400)
    expect(h.ingest).not.toHaveBeenCalled()
  })

  it('runs the shared ingestion with channel=qr', async () => {
    const res = await inbound(
      req('inbound', {
        account_id: 'acct-1',
        message_id: 'ABCD',
        from: '5511999990000',
        push_name: 'Maria',
        timestamp: 1_757_700_000,
        type: 'image',
        text: 'legenda',
        media: { url: 'https://x/chat-media/a.jpg', mimetype: 'image/jpeg' },
        quoted_message_id: 'PARENT',
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, conversation_id: 'conv-1' })
    expect(h.ingest).toHaveBeenCalledTimes(1)
    expect(h.ingest.mock.calls[0][0]).toMatchObject({
      accountId: 'acct-1',
      channel: 'qr',
      from: '5511999990000',
      pushName: 'Maria',
      messageId: 'ABCD',
      type: 'image',
      text: 'legenda',
      mediaUrl: 'https://x/chat-media/a.jpg',
      mimeType: 'image/jpeg',
      quotedMessageId: 'PARENT',
      timestamp: 1_757_700_000,
    })
  })

  it('uses the filename as text for a caption-less document', async () => {
    await inbound(
      req('inbound', {
        account_id: 'acct-1',
        message_id: 'D1',
        from: '5511',
        type: 'document',
        media: { url: 'u', mimetype: 'application/pdf', filename: 'nota.pdf' },
      }),
    )
    expect(h.ingest.mock.calls[0][0]).toMatchObject({ text: 'nota.pdf' })
  })

  it('422 when ingestion cannot place the message', async () => {
    h.ingest.mockResolvedValueOnce({ ok: false, reason: 'account_owner_not_found' })
    const res = await inbound(
      req('inbound', { account_id: 'x', message_id: 'm', from: '55', type: 'text', text: 'oi' }),
    )
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ reason: 'account_owner_not_found' })
  })
})

describe('POST /ack', () => {
  it('updates messages.status by message_id on the qr channel', async () => {
    const res = await ack(
      req('ack', { account_id: 'acct-1', message_id: 'ABCD', status: 'read' }),
    )
    expect(res.status).toBe(200)
    expect(h.writes).toHaveLength(1)
    expect(h.writes[0]).toMatchObject({
      table: 'messages',
      op: 'update',
      payload: { status: 'read' },
    })
    expect(h.writes[0].filters).toEqual([
      ['message_id', 'ABCD'],
      ['channel', 'qr'],
    ])
  })

  it('rejects unknown statuses', async () => {
    const res = await ack(
      req('ack', { account_id: 'acct-1', message_id: 'ABCD', status: 'seen' }),
    )
    expect(res.status).toBe(400)
    expect(h.writes).toHaveLength(0)
  })
})

describe('POST /status-event (and /status alias)', () => {
  it('upserts the session row with phone + name', async () => {
    const res = await statusEvent(
      req('status-event', {
        account_id: 'acct-1',
        status: 'connected',
        phone: '5511999990000',
        name: 'Loja',
      }),
    )
    expect(res.status).toBe(200)
    expect(h.writes[0]).toMatchObject({
      table: 'wa_qr_sessions',
      op: 'upsert',
      payload: {
        account_id: 'acct-1',
        status: 'connected',
        phone_number: '5511999990000',
        display_name: 'Loja',
        last_error: null,
      },
    })
    expect((h.writes[0].payload as { connected_at?: string }).connected_at).toBeTruthy()
  })

  it('stores last_error and clears connected_at on disconnect', async () => {
    await statusPost(
      req('status', { account_id: 'acct-1', status: 'disconnected', error: 'loggedOut' }),
    )
    expect(h.writes[0].payload).toMatchObject({
      status: 'disconnected',
      last_error: 'loggedOut',
      connected_at: null,
    })
  })

  it('rejects an unknown status', async () => {
    const res = await statusEvent(req('status-event', { account_id: 'a', status: 'weird' }))
    expect(res.status).toBe(400)
  })
})
