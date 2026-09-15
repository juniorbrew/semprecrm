import { beforeEach, describe, expect, it, vi } from 'vitest'

// ------------------------------------------------------------
// /api/v1/webhooks/in/[token] — status codes and dispatch wiring.
// Ingest and the automation engine are stubbed; the service-role
// client only serves the source lookup and the plan row.
// ------------------------------------------------------------

const TOKEN = 'a'.repeat(64)

const h = vi.hoisted(() => ({
  state: {
    source: null as Record<string, unknown> | null,
    account: {
      plan: 'trial',
      plan_status: 'trial',
      plan_expires_at: null as string | null,
      module_overrides: {} as Record<string, unknown>,
      limit_overrides: {} as Record<string, unknown>,
    },
    lookups: [] as string[],
  },
  ingest: vi.fn(),
  automations: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const filters: [string, unknown][] = []
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (k: string, v: unknown) => (filters.push([k, v]), b),
        maybeSingle: () => {
          if (table === 'lead_sources') {
            h.state.lookups.push(String(filters[0]?.[1]))
            const s = h.state.source
            return Promise.resolve({ data: s && s.token === filters[0]?.[1] ? s : null, error: null })
          }
          if (table === 'accounts') return Promise.resolve({ data: h.state.account, error: null })
          return Promise.resolve({ data: null, error: null })
        },
      }
      return b
    },
  }),
}))

vi.mock('@/lib/lead-capture/ingest', () => ({
  ingestLead: (...args: unknown[]) => h.ingest(...args),
}))

vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: vi.fn(async (args: Record<string, unknown>) => {
    h.automations.push(args)
  }),
}))

import { __resetRateLimitForTests } from '@/lib/rate-limit'

import { GET, POST } from './route'

const ctx = (token = TOKEN) => ({ params: Promise.resolve({ token }) })

function post(body: string, contentType = 'application/x-www-form-urlencoded', token = TOKEN) {
  return new Request(`http://localhost/api/v1/webhooks/in/${token}`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  })
}

beforeEach(() => {
  __resetRateLimitForTests()
  h.state.source = {
    id: 'src-1',
    account_id: 'acct-1',
    name: 'Landing',
    token: TOKEN,
    is_active: true,
    pipeline_id: null,
    stage_id: null,
    tag_ids: [],
    assignee_user_id: null,
    field_map: {},
    received_count: 0,
  }
  h.state.account = {
    plan: 'trial',
    plan_status: 'trial',
    plan_expires_at: null,
    module_overrides: {},
    limit_overrides: {},
  }
  h.state.lookups.length = 0
  h.automations.length = 0
  h.ingest.mockReset()
  h.ingest.mockResolvedValue({
    status: 'ok',
    httpStatus: 200,
    contactId: 'c-1',
    dealId: 'd-1',
    duplicate: false,
    contactCreated: true,
  })
})

describe('GET', () => {
  it('200 with the source name for a live token', async () => {
    const res = await GET(new Request('http://localhost'), ctx())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, source: 'Landing' })
  })

  it('404 for an unknown, malformed or inactive token (no DB hit when malformed)', async () => {
    expect((await GET(new Request('http://localhost'), ctx('b'.repeat(64)))).status).toBe(404)
    expect((await GET(new Request('http://localhost'), ctx('short'))).status).toBe(404)
    expect(h.state.lookups).toEqual(['b'.repeat(64)])
    h.state.source!.is_active = false
    expect((await GET(new Request('http://localhost'), ctx())).status).toBe(404)
  })
})

describe('POST', () => {
  it('200 with contact/deal ids and fires both triggers for a new contact', async () => {
    const res = await POST(post('nome=Ana&telefone=5511999990000'), ctx())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, contact_id: 'c-1', deal_id: 'd-1', duplicate: false })

    expect(h.ingest).toHaveBeenCalledTimes(1)
    const [, source, payload] = h.ingest.mock.calls[0]
    expect(source).toMatchObject({ id: 'src-1', account_id: 'acct-1' })
    expect(payload).toEqual({ nome: 'Ana', telefone: '5511999990000' })

    expect(h.automations.map((a) => a.triggerType)).toEqual(['new_contact_created', 'lead_captured'])
    expect(h.automations[1]).toMatchObject({
      accountId: 'acct-1',
      contactId: 'c-1',
      context: { vars: { source_id: 'src-1', source_name: 'Landing', deal_id: 'd-1', duplicate: false } },
    })
  })

  it('only fires lead_captured for a duplicate contact', async () => {
    h.ingest.mockResolvedValue({
      status: 'duplicate',
      httpStatus: 200,
      contactId: 'c-9',
      duplicate: true,
      contactCreated: false,
    })
    const res = await POST(post(JSON.stringify({ phone: '5511999990000' }), 'application/json'), ctx())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, contact_id: 'c-9', deal_id: null, duplicate: true })
    expect(h.automations.map((a) => a.triggerType)).toEqual(['lead_captured'])
  })

  it('404 for an unknown token and never ingests', async () => {
    const res = await POST(post('phone=1', undefined, 'c'.repeat(64)), ctx('c'.repeat(64)))
    expect(res.status).toBe(404)
    expect(h.ingest).not.toHaveBeenCalled()
  })

  it('403 when the account lacks the lead_capture module', async () => {
    h.state.account.plan = 'basico'
    h.state.account.plan_status = 'active'
    const res = await POST(post('phone=5511999990000'), ctx())
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('module_not_included')
    expect(h.ingest).not.toHaveBeenCalled()
  })

  it('403 when the account is blocked (expired trial)', async () => {
    h.state.account.plan_expires_at = '2000-01-01T00:00:00.000Z'
    expect((await POST(post('phone=5511999990000'), ctx())).status).toBe(403)
  })

  it('400 for an unreadable body', async () => {
    const res = await POST(post('[1,2,3]', 'application/json'), ctx())
    expect(res.status).toBe(400)
    expect(h.ingest).not.toHaveBeenCalled()
  })

  it('propagates the ingest error status (400 invalid phone) and fires nothing', async () => {
    h.ingest.mockResolvedValue({
      status: 'error',
      httpStatus: 400,
      error: 'phone_invalid',
      duplicate: false,
      contactCreated: false,
    })
    const res = await POST(post('phone=123'), ctx())
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ ok: false, error: 'phone_invalid' })
    expect(h.automations).toHaveLength(0)
  })

  it('429 after 60 requests in a minute for the same token', async () => {
    for (let i = 0; i < 60; i++) {
      expect((await GET(new Request('http://localhost'), ctx())).status).toBe(200)
    }
    const res = await POST(post('phone=5511999990000'), ctx())
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBeTruthy()
    expect(h.ingest).not.toHaveBeenCalled()
  })
})
