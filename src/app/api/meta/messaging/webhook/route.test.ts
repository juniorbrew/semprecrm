import crypto from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ------------------------------------------------------------
// Instagram / Messenger webhook: handshake, signature, account
// resolution by recipient id, redelivery, echo. The shared inbound
// pipeline is covered by src/lib/whatsapp/inbound*.test.ts; here it is a
// spy and the database is a tiny in-memory fake.
// ------------------------------------------------------------

const h = vi.hoisted(() => ({
  pending: [] as Promise<unknown>[],
  ingest: vi.fn<(...a: unknown[]) => Promise<{ ok: boolean; reason?: string }>>(async () => ({ ok: true })),
  channels: [] as Record<string, unknown>[],
  contacts: [] as Record<string, unknown>[],
  conversations: [] as Record<string, unknown>[],
  messages: [] as Record<string, unknown>[],
  /** Modules the plan includes (migration 101). */
  modules: new Set<string>(['channel_instagram', 'channel_messenger']),
  moduleCalls: [] as unknown[][],
  kicked: 0,
  agents: [] as Record<string, unknown>[],
  triage: [] as unknown[][],
}))

vi.mock('next/server', () => ({
  after: (cb: () => Promise<unknown>) => void h.pending.push(Promise.resolve(cb())),
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }),
  },
}))
vi.mock('@/lib/plans-server', () => ({
  accountHasModule: async (...a: unknown[]) => {
    h.moduleCalls.push(a)
    return h.modules.has(a[2] as string)
  },
}))
vi.mock('@/lib/ai/auto-reply-runtime', async (orig) => ({
  ...(await orig<typeof import('@/lib/ai/auto-reply-runtime')>()),
  kickAutoReplies: async () => void h.kicked++,
}))
vi.mock('@/lib/support/triage-trigger', () => ({ scheduleTriageIfDue: (...a: unknown[]) => void h.triage.push(a) }))
vi.mock('@/lib/supabase/url', () => ({ supabaseServerUrl: () => 'http://db' }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => `dec:${v}` }))
vi.mock('@/lib/whatsapp/inbound', () => ({
  ingestInboundMessage: (...a: unknown[]) => h.ingest(...a),
  previewText: (t: string | null) => t ?? '',
  findStoredMessage: async (_db: unknown, id: string, convIds: string[]) =>
    h.messages.find((m) => m.message_id === id && convIds.includes(m.conversation_id as string)) ?? null,
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    storage: { from: () => ({ upload: async () => ({ error: null }) }) },
    from(table: string) {
      const src = () =>
        table === 'meta_messaging_channels' ? h.channels
        : table === 'contacts' ? h.contacts
        : table === 'conversations' ? h.conversations
        : table === 'messages' ? h.messages
        : table === 'ai_agents' ? h.agents
        : []
      const filters: [string, unknown][] = []
      let insert: Record<string, unknown> | null = null
      let update: Record<string, unknown> | null = null
      const rows = () => src().filter((r) => filters.every(([k, v]) => k.includes('.') || r[k] === v))
      const resolve = () => {
        if (insert) {
          src().push({ id: `new-${src().length}`, ...insert })
          return { data: null, error: null }
        }
        if (update) {
          for (const r of rows()) Object.assign(r, update)
          return { data: null, error: null }
        }
        return { data: rows(), error: null }
      }
      const b: Record<string, unknown> = {
        select: () => b,
        insert: (p: Record<string, unknown>) => ((insert = p), b),
        update: (p: Record<string, unknown>) => ((update = p), b),
        eq: (k: string, v: unknown) => (filters.push([k, v]), b),
        or: () => b,
        order: () => b,
        limit: () => b,
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) => Promise.resolve(resolve()).then(f, r),
      }
      return b
    },
  }),
}))

import { __resetRateLimitForTests } from '@/lib/rate-limit'
import { GET, POST } from './route'

const SECRET = 'app-secret'
const sign = (raw: string, secret = SECRET) => 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex')

function post(payload: unknown, headers: Record<string, string> = {}, raw = JSON.stringify(payload)) {
  return POST(
    new Request('http://localhost/api/meta/messaging/webhook', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sign(raw), ...headers },
      body: raw,
    }),
  ) as unknown as Promise<{ body: unknown; status: number }>
}
const settle = () => Promise.all(h.pending.splice(0))

const text = (sender: string, recipient: string, mid: string, extra: Record<string, unknown> = {}) => ({
  sender: { id: sender }, recipient: { id: recipient }, timestamp: 1_700_000_000_000, message: { mid, text: 'oi', ...extra },
})
const igBody = (...messaging: unknown[]) => ({ object: 'instagram', entry: [{ id: 'IG1', time: 1, messaging }] })
const entryBody = (id: string, ...messaging: unknown[]) => ({ object: 'instagram', entry: [{ id, time: 1, messaging }] })

beforeEach(() => {
  process.env.META_APP_SECRET = SECRET
  delete process.env.INSTAGRAM_APP_SECRET
  process.env.META_MESSAGING_VERIFY_TOKEN = 'verify-me'
  h.pending = []
  h.ingest.mockClear()
  h.ingest.mockResolvedValue({ ok: true })
  h.channels = [{ account_id: 'acct-1', kind: 'instagram', external_id: 'IG1', status: 'active', access_token: 'ct', id: 'ch-1' }]
  h.contacts = [{ id: 'ct-1', account_id: 'acct-1', instagram_id: 'IGSID', anonymized_at: null }]
  h.conversations = [{ id: 'cv-1', account_id: 'acct-1', contact_id: 'ct-1', status: 'open', created_at: '2026-01-01' }]
  h.messages = []
  h.modules = new Set(['channel_instagram', 'channel_messenger'])
  h.moduleCalls = []
  h.kicked = 0
  h.agents = [{ account_id: 'acct-1', enabled: true, channels: ['instagram'] }]
  h.triage = []
  __resetRateLimitForTests()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('GET handshake', () => {
  const get = (qs: string) => GET(new Request(`http://localhost/api/meta/messaging/webhook?${qs}`)) as unknown as Promise<Response & { status: number }>
  it('echoes the challenge for the right verify token', async () => {
    const res = await get('hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=123')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('123')
  })
  it('refuses a wrong token, a missing token variable and missing params', async () => {
    expect((await get('hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1')).status).toBe(403)
    expect((await get('hub.mode=subscribe')).status).toBe(400)
    delete process.env.META_MESSAGING_VERIFY_TOKEN
    expect((await get('hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=1')).status).toBe(403)
  })
})

describe('POST signature', () => {
  it('rejects an unsigned or wrongly signed payload and processes nothing', async () => {
    const payload = igBody(text('IGSID', 'IG1', 'm1'))
    expect((await post(payload, { 'x-hub-signature-256': '' })).status).toBe(401)
    expect((await post(payload, { 'x-hub-signature-256': sign(JSON.stringify(payload), 'other') })).status).toBe(401)
    await settle()
    expect(h.ingest).not.toHaveBeenCalled()
  })

  it('accepts the Instagram app secret as well', async () => {
    delete process.env.META_APP_SECRET
    process.env.INSTAGRAM_APP_SECRET = 'ig-secret'
    const raw = JSON.stringify(igBody(text('IGSID', 'IG1', 'm1')))
    expect((await post(null, { 'x-hub-signature-256': sign(raw, 'ig-secret') }, raw)).status).toBe(200)
    await settle()
    expect(h.ingest).toHaveBeenCalledOnce()
  })

  it('answers 400 on a signed but malformed body', async () => {
    const raw = '{not json'
    expect((await post(null, {}, raw)).status).toBe(400)
  })
})

describe('POST events', () => {
  it('resolves the account from recipient.id and ingests on the instagram channel', async () => {
    expect((await post(igBody(text('IGSID', 'IG1', 'm1')))).status).toBe(200)
    await settle()
    expect(h.ingest).toHaveBeenCalledOnce()
    expect(h.ingest.mock.calls[0][0]).toMatchObject({
      accountId: 'acct-1', channel: 'instagram', from: 'IGSID', messageId: 'm1', type: 'text', text: 'oi',
    })
  })

  it('a Page event goes to messenger for the page owner', async () => {
    h.channels.push({ account_id: 'acct-2', kind: 'messenger', external_id: 'PG1', status: 'active', access_token: 'ct2', id: 'ch-2' })
    await post({ object: 'page', entry: [{ id: 'PG1', messaging: [text('PSID', 'PG1', 'm9')] }] })
    await settle()
    expect(h.ingest.mock.calls[0][0]).toMatchObject({ accountId: 'acct-2', channel: 'messenger', from: 'PSID' })
  })

  it('an unknown recipient id is acknowledged and ingests nothing', async () => {
    expect((await post(entryBody('UNKNOWN', text('IGSID', 'UNKNOWN', 'm1')))).status).toBe(200)
    await settle()
    expect(h.ingest).not.toHaveBeenCalled()
  })

  it('skips an event whose recipient is not the entry id (cannot be routed to another account)', async () => {
    h.channels.push({ account_id: 'acct-9', kind: 'instagram', external_id: 'OTHER', status: 'active', access_token: 'x', id: 'ch-9' })
    expect((await post(entryBody('IG1', text('IGSID', 'OTHER', 'm1')))).status).toBe(200)
    await settle()
    expect(h.ingest).not.toHaveBeenCalled()
  })

  it('answers 500 when an event failed transiently, so Meta redelivers; unknown recipients stay 200', async () => {
    h.ingest.mockResolvedValueOnce({ ok: false, reason: 'message_insert_failed' })
    expect((await post(igBody(text('IGSID', 'IG1', 'm1')))).status).toBe(500)
    h.ingest.mockResolvedValueOnce({ ok: false, reason: 'account_owner_not_found' })
    expect((await post(igBody(text('IGSID', 'IG1', 'm2')))).status).toBe(200)
  })

  it('dedupes each part on its own: part 0 stored, part 1 still ingested', async () => {
    h.messages = [{ id: 'msg-1', conversation_id: 'cv-1', message_id: 'm1' }]
    const att = (n: number) => ({ type: 'story_mention', payload: { url: `https://lookaside.fbsbx.com/${n}` } })
    await post(igBody({ sender: { id: 'IGSID' }, recipient: { id: 'IG1' }, timestamp: 1, message: { mid: 'm1', attachments: [att(0), att(1)] } }))
    expect(h.ingest).toHaveBeenCalledOnce()
    expect(h.ingest.mock.calls[0][0]).toMatchObject({ messageId: 'm1:1' })
  })

  it('only the first attachment of a message may start automations / flows / the AI (the rest are store-only)', async () => {
    const att = (n: number) => ({ type: 'story_mention', payload: { url: `https://lookaside.fbsbx.com/${n}` } })
    await post(igBody({ sender: { id: 'IGSID' }, recipient: { id: 'IG1' }, timestamp: 1, message: { mid: 'm7', attachments: [att(0), att(1), att(2)] } }))
    expect(h.ingest.mock.calls.map((c) => [(c[0] as { messageId: string }).messageId, (c[0] as { storeOnly: boolean }).storeOnly])).toEqual([
      ['m7', false],
      ['m7:1', true],
      ['m7:2', true],
    ])
  })

  it('refuses a body above 1 MB before reading it', async () => {
    const res = (await POST(
      new Request('http://localhost/api/meta/messaging/webhook', {
        method: 'POST',
        headers: { 'content-length': String(2 * 1024 * 1024), 'x-hub-signature-256': 'sha256=x' },
        body: '{}',
      }),
    )) as unknown as { status: number }
    expect(res.status).toBe(413)
  })

  it('an account whose plan lacks the channel module gets 200 and nothing is stored (inbound and echo)', async () => {
    h.modules = new Set(['channel_messenger'])
    expect((await post(igBody(text('IGSID', 'IG1', 'm1')))).status).toBe(200)
    expect((await post(igBody({ ...text('IG1', 'IGSID', 'm2', { is_echo: true }) }))).status).toBe(200)
    await settle()
    expect(h.ingest).not.toHaveBeenCalled()
    expect(h.messages).toHaveLength(0)
    // read-only accounts still receive: the check is the plan's module, with allowReadOnly
    expect(h.moduleCalls[0].slice(2)).toEqual(['channel_instagram', { allowReadOnly: true }])
  })

  it('the module is its own channel module: a messenger event needs channel_messenger', async () => {
    h.channels.push({ account_id: 'acct-2', kind: 'messenger', external_id: 'PG1', status: 'active', access_token: 'x', id: 'ch-2' })
    h.modules = new Set(['channel_instagram'])
    await post({ object: 'page', entry: [{ id: 'PG1', messaging: [text('PSID', 'PG1', 'm9')] }] })
    expect(h.ingest).not.toHaveBeenCalled()
    h.modules = new Set(['channel_messenger'])
    await post({ object: 'page', entry: [{ id: 'PG1', messaging: [text('PSID', 'PG1', 'm9')] }] })
    expect(h.ingest).toHaveBeenCalledOnce()
  })

  it('an ingested message hands the AI triage hint to the scheduler and kicks the auto-reply drain (part C)', async () => {
    h.ingest.mockResolvedValueOnce({ ok: true, aiReplyQueued: true, triageDue: true, conversationId: 'cv-1' } as never)
    await post(igBody(text('IGSID', 'IG1', 'm1')))
    await settle()
    expect(h.triage).toEqual([[expect.objectContaining({ triageDue: true, conversationId: 'cv-1' }), 'acct-1']])
    expect(h.kicked).toBe(1)
  })

  it('triage on Instagram / Messenger is opt-in: no agent listing the channel, no triage', async () => {
    h.agents = [{ account_id: 'acct-1', enabled: true, channels: [] }]
    h.ingest.mockResolvedValueOnce({ ok: true, triageDue: true, conversationId: 'cv-1' } as never)
    await post(igBody(text('IGSID', 'IG1', 'm1')))
    await settle()
    expect(h.triage).toHaveLength(0)
    h.agents = [{ account_id: 'acct-1', enabled: true, channels: ['messenger'] }]
    h.ingest.mockResolvedValueOnce({ ok: true, triageDue: true, conversationId: 'cv-1' } as never)
    await post(igBody(text('IGSID', 'IG1', 'm2')))
    expect(h.triage).toHaveLength(0)
  })

  it('no AI reply queued: the drain is not kicked', async () => {
    await post(igBody(text('IGSID', 'IG1', 'm1')))
    await settle()
    expect(h.kicked).toBe(0)
  })

  it('a revoked connection does not receive messages', async () => {
    h.channels[0].status = 'revoked'
    await post(igBody(text('IGSID', 'IG1', 'm1')))
    await settle()
    expect(h.ingest).not.toHaveBeenCalled()
  })

  it('a redelivered mid already stored is not ingested again', async () => {
    h.messages = [{ id: 'msg-1', conversation_id: 'cv-1', message_id: 'm1' }]
    await post(igBody(text('IGSID', 'IG1', 'm1')))
    await settle()
    expect(h.ingest).not.toHaveBeenCalled()
  })

  it('an echo becomes an outbound row (agent, origin phone, instagram) and never an inbound ingest', async () => {
    await post(igBody({ ...text('IG1', 'IGSID', 'm5', { is_echo: true }) }))
    await settle()
    expect(h.ingest).not.toHaveBeenCalled()
    expect(h.messages).toHaveLength(1)
    expect(h.messages[0]).toMatchObject({
      conversation_id: 'cv-1', sender_type: 'agent', origin: 'phone', channel: 'instagram', status: 'sent', message_id: 'm5', content_text: 'oi',
    })
  })

  it('a repeated echo does not duplicate the row', async () => {
    const payload = igBody({ ...text('IG1', 'IGSID', 'm5', { is_echo: true }) })
    await post(payload)
    await settle()
    await post(payload)
    await settle()
    expect(h.messages).toHaveLength(1)
  })

  it('an echo to a customer we never talked to stores nothing', async () => {
    h.contacts = []
    await post(igBody({ ...text('IG1', 'SOMEONE', 'm6', { is_echo: true }) }))
    await settle()
    expect(h.messages).toHaveLength(0)
  })
})
