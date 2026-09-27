import { beforeEach, describe, expect, it, vi } from 'vitest'

// ------------------------------------------------------------
// Meta webhook route — the parts ported from wacrm:
//   #535  failed status → Meta's reason persisted on messages and
//         folded into broadcast_recipients.error_message
//   #478  template quick-reply taps (`type: 'button'`) → interactive
//         reply handed to the shared inbound pipeline
// The inbound pipeline itself is covered by src/lib/whatsapp/inbound.test.ts.
// ------------------------------------------------------------

const h = vi.hoisted(() => ({
  signatureOk: true,
  configRows: [] as Record<string, unknown>[],
  recipient: null as { id: string; status: string } | null,
  updates: [] as { table: string; payload: Record<string, unknown>; filters: [string, unknown][] }[],
  ingest: vi.fn<(...args: unknown[]) => Promise<{ ok: boolean }>>(async () => ({ ok: true })),
  templateChange: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
}))

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      body,
      status: init?.status ?? 200,
    }),
  },
}))

vi.mock('@/lib/supabase/url', () => ({ supabaseServerUrl: () => 'http://db' }))

vi.mock('@/lib/whatsapp/webhook-signature', () => ({
  verifyMetaWebhookSignature: () => h.signatureOk,
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: () => 'token',
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}))

vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: vi.fn(async () => ({ url: 'https://x' })),
}))

vi.mock('@/lib/whatsapp/inbound', () => ({
  ingestInboundMessage: (...a: unknown[]) => h.ingest(...a),
  findOrCreateContact: vi.fn(),
  findOrCreateConversation: vi.fn(),
  lookupInternalIdByProviderId: vi.fn(),
}))

vi.mock('@/lib/whatsapp/template-webhook', () => ({
  isTemplateWebhookField: (f: string) => f.startsWith('message_template'),
  handleTemplateWebhookChange: (...a: unknown[]) => h.templateChange(...a),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      const filters: [string, unknown][] = []
      let payload: Record<string, unknown> | null = null
      const resolve = () => {
        if (payload) {
          h.updates.push({ table, payload, filters: [...filters] })
          return { data: null, error: null }
        }
        if (table === 'whatsapp_config') return { data: h.configRows, error: null }
        return { data: [], error: null }
      }
      const b: Record<string, unknown> = {
        select: () => b,
        update: (p: Record<string, unknown>) => ((payload = p), b),
        eq: (k: string, v: unknown) => (filters.push([k, v]), b),
        maybeSingle: async () =>
          table === 'broadcast_recipients'
            ? { data: h.recipient, error: null }
            : { data: null, error: null },
        then: (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) =>
          Promise.resolve(resolve()).then(f, r),
      }
      return b
    },
  }),
}))

import { POST } from './route'

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/whatsapp/webhook', {
      method: 'POST',
      headers: { 'x-hub-signature-256': 'sha256=abc' },
      body: JSON.stringify(body),
    }),
  ) as unknown as Promise<{ body: unknown; status: number }>
}

/** processWebhook is fire-and-forget after the 200 — let it settle. */
const settle = () => new Promise((r) => setTimeout(r, 10))

function statusPayload(status: Record<string, unknown>) {
  return {
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '5511', phone_number_id: 'pn-1' },
              statuses: [
                { id: 'wamid.X', timestamp: '1757700000', recipient_id: '5511999990000', ...status },
              ],
            },
          },
        ],
      },
    ],
  }
}

function messagePayload(message: Record<string, unknown>) {
  return {
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '5511', phone_number_id: 'pn-1' },
              contacts: [{ profile: { name: 'Maria' }, wa_id: '5511999990000' }],
              messages: [
                { id: 'wamid.IN', from: '5511999990000', timestamp: '1757700000', ...message },
              ],
            },
          },
        ],
      },
    ],
  }
}

let warn: { mock: { calls: unknown[][] } }

beforeEach(() => {
  h.signatureOk = true
  h.configRows = [{ id: 'cfg-1', account_id: 'acct-1', user_id: 'owner-1', access_token: 'enc' }]
  h.recipient = null
  h.updates = []
  h.ingest.mockClear()
  h.templateChange.mockClear()
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('POST /api/whatsapp/webhook — signature', () => {
  it('rejects an invalid signature before touching the database', async () => {
    h.signatureOk = false
    const res = await post(statusPayload({ status: 'failed' }))
    await settle()
    expect(res.status).toBe(401)
    expect(h.updates).toEqual([])
  })
})

describe('status webhook — failure reason (wacrm #535)', () => {
  const errors = [
    {
      code: 131049,
      title: 'This message was not delivered to maintain healthy ecosystem engagement.',
      error_data: { details: 'Per-user marketing message limit reached.' },
    },
  ]

  it('persists code / title / details on the messages row and warns once', async () => {
    await post(statusPayload({ status: 'failed', errors }))
    await settle()

    const msg = h.updates.find((u) => u.table === 'messages')
    expect(msg?.payload).toEqual({
      status: 'failed',
      error_code: 131049,
      error_title: errors[0].title,
      error_details: 'Per-user marketing message limit reached.',
    })
    expect(msg?.filters).toEqual([['message_id', 'wamid.X']])
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('wamid.X'))).toHaveLength(1)
  })

  it('folds the reason into the broadcast recipient error_message', async () => {
    h.recipient = { id: 'rec-1', status: 'sent' }
    await post(statusPayload({ status: 'failed', errors }))
    await settle()

    const rec = h.updates.find((u) => u.table === 'broadcast_recipients')
    expect(rec?.payload).toMatchObject({
      status: 'failed',
      error_message: `[131049] ${errors[0].title}: Per-user marketing message limit reached.`,
    })
  })

  it('updates only status for a failed status without errors', async () => {
    await post(statusPayload({ status: 'failed' }))
    await settle()
    expect(h.updates.find((u) => u.table === 'messages')?.payload).toEqual({ status: 'failed' })
  })

  it('never writes (or clears) the error columns on a non-failed status', async () => {
    await post(statusPayload({ status: 'delivered', errors }))
    await settle()
    expect(h.updates.find((u) => u.table === 'messages')?.payload).toEqual({ status: 'delivered' })
  })
})

describe('inbound — template quick-reply tap (wacrm #478)', () => {
  it('hands the tap to the pipeline as an interactive reply, scoped to the config account', async () => {
    await post(
      messagePayload({
        type: 'button',
        button: { text: 'Quero saber mais', payload: 'SABER_MAIS' },
      }),
    )
    await settle()

    expect(h.ingest).toHaveBeenCalledTimes(1)
    expect(h.ingest.mock.calls[0][0]).toMatchObject({
      accountId: 'acct-1',
      userId: 'owner-1',
      channel: 'official',
      type: 'button',
      text: 'Quero saber mais',
      interactiveReplyId: 'SABER_MAIS',
    })
  })

  it('falls back to the label when the template button carries no payload', async () => {
    await post(messagePayload({ type: 'button', button: { text: 'Sim' } }))
    await settle()
    expect(h.ingest.mock.calls[0][0]).toMatchObject({ text: 'Sim', interactiveReplyId: 'Sim' })
  })

  it('drops the message when no config owns the phone number id', async () => {
    h.configRows = []
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await post(messagePayload({ type: 'button', button: { text: 'Sim', payload: 'S' } }))
    await settle()
    expect(h.ingest).not.toHaveBeenCalled()
  })
})
