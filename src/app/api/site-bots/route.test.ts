import { beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultBotConfig } from '@/lib/site-bot'

// ------------------------------------------------------------
// POST /api/site-bots and PATCH /api/site-bots/[id] — the editor's
// server half: admin only, key minted server-side, config validated.
// ------------------------------------------------------------

const FIELD = '11111111-1111-4111-8111-111111111111'
const BOT_ID = '22222222-2222-4222-8222-222222222222'

const h = vi.hoisted(() => ({
  role: 'admin' as 'admin' | 'agent',
  moduleOk: true,
  inserted: [] as Record<string, unknown>[],
  updated: [] as { patch: Record<string, unknown>; filters: [string, unknown][] }[],
  fields: [{ id: '11111111-1111-4111-8111-111111111111' }] as { id: string }[],
  updateRow: { id: '22222222-2222-4222-8222-222222222222' } as Record<string, unknown> | null,
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/audit-server', () => ({ audit: vi.fn(async () => {}) }))

vi.mock('@/lib/auth/account', async (orig) => {
  const real = await orig<typeof import('@/lib/auth/account')>()
  function db() {
    return {
      from: (table: string) => {
        const filters: [string, unknown][] = []
        let patch: Record<string, unknown> | null = null
        const b: Record<string, unknown> = {
          select: () => b,
          eq: (k: string, v: unknown) => (filters.push([k, v]), b),
          in: () => Promise.resolve({ data: h.fields, error: null }),
          insert: (row: Record<string, unknown>) => (h.inserted.push(row), b),
          update: (p: Record<string, unknown>) => ((patch = p), b),
          single: () => Promise.resolve({ data: { id: 'new', ...(h.inserted.at(-1) ?? {}) }, error: null }),
          maybeSingle: () => {
            if (patch) h.updated.push({ patch, filters })
            return Promise.resolve({ data: h.updateRow, error: null })
          },
        }
        void table
        return b
      },
    }
  }
  return {
    ...real,
    requireRole: async (min: string) => {
      if (min === 'admin' && h.role !== 'admin') throw new real.ForbiddenError("This action requires the 'admin' role or higher")
      return { supabase: db(), accountId: 'acct-1', userId: 'user-1', role: h.role }
    },
    requireModule: async () => {
      if (!h.moduleOk) throw new real.ModuleNotIncludedError('lead_capture')
      return {}
    },
  }
})

import { __resetRateLimitForTests } from '@/lib/rate-limit'

import { PATCH } from './[id]/route'
import { POST } from './route'

const bodyOf = (over: Record<string, unknown> = {}) => ({
  name: 'Robo da Loja',
  pipeline_id: '33333333-3333-4333-8333-333333333333',
  stage_id: '44444444-4444-4444-8444-444444444444',
  tag_ids: ['55555555-5555-4555-8555-555555555555'],
  assignee_user_id: '66666666-6666-4666-8666-666666666666',
  config: defaultBotConfig(),
  ...over,
})

const req = (method: string, body: unknown) =>
  new Request('http://localhost/api/site-bots', { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

beforeEach(() => {
  __resetRateLimitForTests()
  h.role = 'admin'
  h.moduleOk = true
  h.inserted.length = 0
  h.updated.length = 0
  h.fields = [{ id: FIELD }]
  h.updateRow = { id: BOT_ID }
})

describe('POST /api/site-bots', () => {
  it('creates a site_bot source with server-minted key and token and a validated config', async () => {
    const res = await POST(req('POST', bodyOf()))
    expect(res.status).toBe(201)
    const row = h.inserted[0]
    expect(row).toMatchObject({ account_id: 'acct-1', kind: 'site_bot', name: 'Robo da Loja', is_active: true, field_map: {}, created_by: 'user-1' })
    expect(row.public_key).toMatch(/^[0-9a-f]{32}$/)
    expect(row.token).toMatch(/^[0-9a-f]{64}$/)
    expect((row.bot_config as { appearance: { color: string } }).appearance.color).toBe('#2563eb')
  })

  it('ignores a key, token, account or kind sent by the client', async () => {
    await POST(req('POST', bodyOf({ public_key: 'f'.repeat(32), token: 'e'.repeat(64), account_id: 'acct-evil', kind: 'webhook' })))
    expect(h.inserted[0]).toMatchObject({ account_id: 'acct-1', kind: 'site_bot' })
    expect(h.inserted[0].public_key).not.toBe('f'.repeat(32))
    expect(h.inserted[0].token).not.toBe('e'.repeat(64))
  })

  it('403 for an agent, nothing written', async () => {
    h.role = 'agent'
    expect((await POST(req('POST', bodyOf()))).status).toBe(403)
    expect(h.inserted).toHaveLength(0)
  })

  it('403 when the plan does not include lead capture', async () => {
    h.moduleOk = false
    expect((await POST(req('POST', bodyOf()))).status).toBe(403)
    expect(h.inserted).toHaveLength(0)
  })

  it('400 for an invalid config, with the reasons', async () => {
    const bad = { ...defaultBotConfig(), questions: [], domains: ['sem espaco.com'] }
    const res = await POST(req('POST', bodyOf({ config: bad })))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.details).toEqual(expect.arrayContaining(['exactly one name question is required']))
    expect(h.inserted).toHaveLength(0)
  })

  it('400 for a missing name, a bad id, or a body that is not JSON', async () => {
    expect((await POST(req('POST', bodyOf({ name: '  ' })))).status).toBe(400)
    expect((await POST(req('POST', bodyOf({ pipeline_id: 'nope' })))).status).toBe(400)
    expect((await POST(req('POST', bodyOf({ tag_ids: ['nope'] })))).status).toBe(400)
    const res = await POST(new Request('http://x', { method: 'POST', body: 'not json' }))
    expect(res.status).toBe(400)
  })

  it('400 when a question points at a custom field of another account', async () => {
    h.fields = []
    const cfg = {
      ...defaultBotConfig(),
      questions: [...defaultBotConfig().questions, { id: 'c', text: 'x', type: 'text', required: false, target: 'custom', customFieldId: FIELD }],
    }
    const res = await POST(req('POST', bodyOf({ config: cfg })))
    expect(res.status).toBe(400)
    expect(h.inserted).toHaveLength(0)
  })

  it('drops the stage when there is no pipeline', async () => {
    await POST(req('POST', bodyOf({ pipeline_id: null })))
    expect(h.inserted[0]).toMatchObject({ pipeline_id: null, stage_id: null })
  })
})

describe('PATCH /api/site-bots/[id]', () => {
  const ctx = (id = BOT_ID) => ({ params: Promise.resolve({ id }) })

  it('updates only this account, only site_bot rows', async () => {
    const res = await PATCH(req('PATCH', { is_active: false }), ctx())
    expect(res.status).toBe(200)
    expect(h.updated[0].patch).toEqual({ is_active: false })
    expect(h.updated[0].filters).toEqual([
      ['id', BOT_ID],
      ['account_id', 'acct-1'],
      ['kind', 'site_bot'],
    ])
  })

  it('validates a new config and never lets the client change the key or kind', async () => {
    const res = await PATCH(req('PATCH', { config: defaultBotConfig(), public_key: 'f'.repeat(32), kind: 'webhook', account_id: 'x' }), ctx())
    expect(res.status).toBe(200)
    expect(Object.keys(h.updated[0].patch)).toEqual(['bot_config'])
    expect((await PATCH(req('PATCH', { config: { ...defaultBotConfig(), greeting: '' } }), ctx())).status).toBe(400)
  })

  it('clearing the pipeline clears the stage', async () => {
    await PATCH(req('PATCH', { pipeline_id: null }), ctx())
    expect(h.updated[0].patch).toEqual({ pipeline_id: null, stage_id: null })
  })

  it('404 for an unknown or foreign bot and for a malformed id; 400 for an empty patch; 403 for an agent', async () => {
    h.updateRow = null
    expect((await PATCH(req('PATCH', { is_active: true }), ctx())).status).toBe(404)
    expect((await PATCH(req('PATCH', { is_active: true }), ctx('nope'))).status).toBe(404)
    h.updateRow = { id: BOT_ID }
    expect((await PATCH(req('PATCH', {}), ctx())).status).toBe(400)
    h.role = 'agent'
    expect((await PATCH(req('PATCH', { is_active: true }), ctx())).status).toBe(403)
  })
})
