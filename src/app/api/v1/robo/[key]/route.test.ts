import { assignedPlanFixture } from '@/test/plan-fixtures'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ------------------------------------------------------------
// /api/v1/robo/[key] — the public site-bot endpoint. Ingest and the
// automation engine are stubbed; the service-role client only serves
// the bot lookup and the plan row.
// ------------------------------------------------------------

const KEY = '1'.repeat(32)
const FIELD = '11111111-1111-4111-8111-111111111111'
const ORIGIN = 'https://minhaloja.com.br'

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
    filters: [] as [string, unknown][][],
  },
  ingest: vi.fn(),
  automations: [] as Record<string, unknown>[],
  after: [] as (() => unknown)[],
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
            h.state.filters.push(filters)
            const s = h.state.source
            const ok = s && filters.every(([k, v]) => s[k] === v)
            return Promise.resolve({ data: ok ? s : null, error: null })
          }
          if (table === 'accounts') {
            return Promise.resolve({ data: assignedPlanFixture(h.state.account), error: null })
          }
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

// `after()` only runs inside a real request: collect the callbacks and run them by hand.
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (fn: () => unknown) => {
    h.after.push(fn)
  },
}))

vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: vi.fn(async (args: Record<string, unknown>) => {
    h.automations.push(args)
  }),
}))

import { __resetRateLimitForTests } from '@/lib/rate-limit'
import { defaultBotConfig } from '@/lib/site-bot'

import { GET, OPTIONS, POST } from './route'

async function flushAfter() {
  for (const fn of h.after.splice(0)) await fn()
}

const ctx = (key = KEY) => ({ params: Promise.resolve({ key }) })

function botConfig(over: Record<string, unknown> = {}) {
  return {
    ...defaultBotConfig(),
    questions: [
      { id: 'nome', text: 'Nome?', type: 'name', required: true },
      { id: 'fone', text: 'WhatsApp?', type: 'phone', required: true },
      { id: 'mail', text: 'E-mail?', type: 'email', required: false },
      { id: 'cor', text: 'Cor?', type: 'choice', options: ['Azul', 'Verde'], required: false, target: 'custom', customFieldId: FIELD },
    ],
    end: { thanks: 'Valeu', whatsappEnabled: true, whatsappNumber: '5511999990000', messageTemplate: 'Oi, sou {nome}' },
    domains: ['minhaloja.com.br'],
    ...over,
  }
}

const GOOD = {
  answers: { nome: 'Ana Souza', fone: '(11) 98765-4321', mail: 'ana@exemplo.com', cor: 'Azul' },
  consent: true,
  contact_ref: '',
  elapsed_ms: 12_000,
}

function get(origin: string | null = ORIGIN, ip = '203.0.113.5') {
  const headers: Record<string, string> = { 'x-real-ip': ip }
  if (origin) headers.origin = origin
  return new Request(`http://localhost/api/v1/robo/${KEY}`, { headers })
}

function post(body: unknown, opts: { origin?: string | null; ip?: string; raw?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-real-ip': opts.ip ?? '203.0.113.5' }
  const origin = opts.origin === undefined ? ORIGIN : opts.origin
  if (origin) headers.origin = origin
  return new Request(`http://localhost/api/v1/robo/${KEY}`, {
    method: 'POST',
    headers,
    body: opts.raw ?? JSON.stringify(body),
  })
}

beforeEach(() => {
  __resetRateLimitForTests()
  h.state.source = {
    id: 'src-1',
    account_id: 'acct-1',
    name: 'Robo da Loja',
    kind: 'site_bot',
    public_key: KEY,
    is_active: true,
    pipeline_id: 'pipe-1',
    stage_id: 'stage-1',
    tag_ids: ['tag-1'],
    assignee_user_id: 'user-9',
    field_map: {},
    received_count: 3,
    bot_config: botConfig(),
  }
  h.state.account = { plan: 'trial', plan_status: 'trial', plan_expires_at: null, module_overrides: {}, limit_overrides: {} }
  h.state.filters.length = 0
  h.automations.length = 0
  h.after.length = 0
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

afterEach(() => vi.restoreAllMocks())

describe('GET (public config)', () => {
  it('returns only public fields', async () => {
    const res = await GET(get(), ctx())
    expect(res.status).toBe(200)
    const text = JSON.stringify(await res.json())
    for (const secret of ['pipe-1', 'stage-1', 'tag-1', 'user-9', 'acct-1', 'src-1', FIELD, '5511999990000', 'minhaloja.com.br', 'customFieldId', 'target']) {
      expect(text).not.toContain(secret)
    }
    const body = JSON.parse(text)
    expect(body.ok).toBe(true)
    expect(body.config.greeting).toBe(defaultBotConfig().greeting)
    expect(body.config.whatsapp).toBe(true)
    expect(body.config.questions.map((q: { id: string }) => q.id)).toEqual(['nome', 'fone', 'mail', 'cor'])
  })

  it('scopes the lookup by public key, kind site_bot', async () => {
    await GET(get(), ctx())
    expect(h.state.filters[0]).toEqual([
      ['public_key', KEY],
      ['kind', 'site_bot'],
    ])
  })

  it('echoes the allowed origin with Vary: Origin', async () => {
    const res = await GET(get('https://www.minhaloja.com.br'), ctx())
    expect(res.headers.get('access-control-allow-origin')).toBe('https://www.minhaloja.com.br')
    expect(res.headers.get('vary')).toBe('Origin')
  })

  it('403 and no ACAO for an origin that is not registered', async () => {
    const res = await GET(get('https://evil.com'), ctx())
    expect(res.status).toBe(403)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('answers without an Origin header (same-origin fetch) but without CORS headers', async () => {
    const res = await GET(get(null), ctx())
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('404 for malformed, unknown, inactive and webhook-kind keys; no DB hit when malformed', async () => {
    expect((await GET(get(), ctx('short'))).status).toBe(404)
    expect((await GET(get(), ctx('2'.repeat(32)))).status).toBe(404)
    expect(h.state.filters).toHaveLength(1)
    h.state.source!.is_active = false
    expect((await GET(get(), ctx())).status).toBe(404)
    h.state.source!.is_active = true
    h.state.source!.kind = 'webhook'
    expect((await GET(get(), ctx())).status).toBe(404)
  })

  it('404 when the plan lacks lead capture, or the stored config is invalid', async () => {
    h.state.account.plan = 'basico'
    h.state.account.module_overrides = { lead_capture: false }
    expect((await GET(get(), ctx())).status).toBe(404)
    h.state.account.module_overrides = {}
    h.state.source!.bot_config = { nonsense: true }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await GET(get(), ctx())).status).toBe(404)
  })

  it('is rate limited per IP and key', async () => {
    for (let i = 0; i < 30; i++) expect((await GET(get(), ctx())).status).toBe(200)
    const res = await GET(get(), ctx())
    expect(res.status).toBe(429)
    expect((await GET(get(ORIGIN, '198.51.100.7'), ctx())).status).toBe(200)
  })
})

describe('OPTIONS', () => {
  const preflight = (origin: string | null) =>
    new Request(`http://localhost/api/v1/robo/${KEY}`, {
      method: 'OPTIONS',
      headers: origin ? { origin, 'access-control-request-method': 'POST' } : {},
    })

  it('204 with CORS headers for a registered site', async () => {
    const res = await OPTIONS(preflight(ORIGIN), ctx())
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect(res.headers.get('access-control-allow-methods')).toContain('POST')
    expect(res.headers.get('access-control-allow-headers')).toContain('Content-Type')
    expect(res.headers.get('vary')).toBe('Origin')
  })

  it('403 for other origins, a missing origin, or a bot without domains', async () => {
    expect((await OPTIONS(preflight('https://evil.com'), ctx())).status).toBe(403)
    expect((await OPTIONS(preflight(null), ctx())).status).toBe(403)
    h.state.source!.bot_config = botConfig({ domains: [] })
    expect((await OPTIONS(preflight(ORIGIN), ctx())).status).toBe(403)
  })

  it('404 for an unknown bot', async () => {
    expect((await OPTIONS(preflight(ORIGIN), ctx('short'))).status).toBe(404)
  })
})

describe('POST', () => {
  it('creates the lead through ingestLead with the bot-owned destination and returns a WhatsApp link', async () => {
    const res = await POST(post(GOOD), ctx())
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect(await res.json()).toEqual({
      ok: true,
      whatsapp_url: `https://wa.me/5511999990000?text=${encodeURIComponent('Oi, sou Ana Souza')}`,
    })
    expect(h.ingest).toHaveBeenCalledTimes(1)
    const [, source, payload, options] = h.ingest.mock.calls[0]
    expect(source).toEqual({
      id: 'src-1',
      account_id: 'acct-1',
      name: 'Robo da Loja',
      pipeline_id: 'pipe-1',
      stage_id: 'stage-1',
      tag_ids: ['tag-1'],
      assignee_user_id: 'user-9',
      received_count: 3,
      field_map: { name: 'name', phone: 'phone', email: 'email', custom: { [FIELD]: 'a_cor' } },
    })
    expect(payload).toMatchObject({ name: 'Ana Souza', phone: '5511987654321', email: 'ana@exemplo.com', a_cor: 'Azul' })
    expect(payload._consent).toEqual({ at: expect.any(String), text: defaultBotConfig().lgpd.text, link: '' })
    expect(options).toMatchObject({ keepExistingCustomValues: true, checkRecentRepeat: 24 })
    expect(JSON.stringify(payload)).not.toMatch(/203\.0\.113/)
    expect(options.dealNotes).toBe('Respostas do robô do site\nE-mail?: ana@exemplo.com\nCor?: Azul')
    // automations run after the response, not inside it
    expect(h.automations).toHaveLength(0)
    await flushAfter()
    expect(h.automations.map((a) => a.triggerType)).toEqual(['new_contact_created', 'lead_captured'])
  })

  it('never takes account, pipeline, stage, tags, assignee or field ids from the request', async () => {
    const evil = {
      ...GOOD,
      account_id: 'acct-evil',
      pipeline_id: 'pipe-evil',
      stage_id: 'stage-evil',
      tag_ids: ['tag-evil'],
      assignee_user_id: 'user-evil',
      field_map: { custom: { 'cf-evil': 'x' } },
      answers: { ...GOOD.answers },
    }
    await POST(post(evil), ctx())
    const [, source] = h.ingest.mock.calls[0]
    expect(source).toMatchObject({ account_id: 'acct-1', pipeline_id: 'pipe-1', stage_id: 'stage-1', tag_ids: ['tag-1'], assignee_user_id: 'user-9' })
    expect(JSON.stringify(h.ingest.mock.calls[0])).not.toContain('evil')
    const res = await POST(post({ ...GOOD, answers: { ...GOOD.answers, pipeline_id: 'pipe-evil' } }, { ip: '198.51.100.1' }), ctx())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('unknown_question')
  })

  it('403 for a missing, foreign or insecure origin, and for a bot with no domains; nothing is created', async () => {
    for (const origin of [null, 'https://evil.com', 'http://minhaloja.com.br', 'https://minhaloja.com.br.evil.com']) {
      const res = await POST(post(GOOD, { origin }), ctx())
      expect(res.status).toBe(403)
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    }
    h.state.source!.bot_config = botConfig({ domains: [] })
    expect((await POST(post(GOOD, { ip: '198.51.100.2' }), ctx())).status).toBe(403)
    expect(h.ingest).not.toHaveBeenCalled()
  })

  it('404 for an unknown, inactive or malformed bot', async () => {
    expect((await POST(post(GOOD), ctx('short'))).status).toBe(404)
    h.state.source!.is_active = false
    expect((await POST(post(GOOD), ctx())).status).toBe(404)
    expect(h.ingest).not.toHaveBeenCalled()
  })

  it('400 without consent (consent must be exactly true)', async () => {
    for (const consent of [false, undefined, 'true', 1]) {
      const res = await POST(post({ ...GOOD, consent }, { ip: `198.51.100.${consent === undefined ? 20 : String(consent).length + 30}` }), ctx())
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('consent_required')
    }
    expect(h.ingest).not.toHaveBeenCalled()
  })

  it('a filled honeypot gets the same success shape and creates nothing', async () => {
    const real = await (await POST(post(GOOD), ctx())).json()
    h.ingest.mockClear()
    h.automations.length = 0
    const res = await POST(post({ ...GOOD, contact_ref: 'http://spam' }, { ip: '198.51.100.3' }), ctx())
    expect(res.status).toBe(200)
    const dropped = await res.json()
    expect(Object.keys(dropped).sort()).toEqual(Object.keys(real).sort())
    expect(dropped.whatsapp_url).toBe(real.whatsapp_url)
    expect(h.ingest).not.toHaveBeenCalled()
    expect(h.automations).toHaveLength(0)
  })

  it('a conversation under 3 seconds (or without a timer) gets the same success and creates nothing', async () => {
    let n = 40
    for (const elapsed_ms of [0, 2999, undefined, 'fast', -5]) {
      const res = await POST(post({ ...GOOD, elapsed_ms }, { ip: `198.51.100.${n++}` }), ctx())
      expect(res.status).toBe(200)
      expect(await res.json()).toHaveProperty('whatsapp_url')
    }
    expect(h.ingest).not.toHaveBeenCalled()
    expect((await POST(post({ ...GOOD, elapsed_ms: 3000 }, { ip: '198.51.100.99' }), ctx())).status).toBe(200)
    expect(h.ingest).toHaveBeenCalledTimes(1)
  })

  it('a dropped request does not record anything personal', async () => {
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'info')]
    await POST(post({ ...GOOD, contact_ref: 'x' }), ctx())
    await POST(post(GOOD), ctx())
    h.ingest.mockResolvedValueOnce({ status: 'error', httpStatus: 500, error: 'boom', duplicate: false, contactCreated: false })
    await POST(post(GOOD, { ip: '198.51.100.8' }), ctx())
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls))
    for (const personal of ['Ana Souza', '98765', 'ana@exemplo.com', '203.0.113.5']) expect(logged).not.toContain(personal)
  })

  it('413 over 8 KB, with or without a Content-Length', async () => {
    const big = { ...GOOD, answers: { ...GOOD.answers, nome: 'a'.repeat(9000) } }
    expect((await POST(post(big), ctx())).status).toBe(413)
    const req = post(null, { raw: JSON.stringify(big), ip: '198.51.100.4' })
    req.headers.delete('content-length')
    expect((await POST(req, ctx())).status).toBe(413)
    const exact = JSON.stringify({ ...GOOD, pad: 'p'.repeat(8192) })
    expect((await POST(post(null, { raw: exact, ip: '198.51.100.5' }), ctx())).status).toBe(413)
    expect(h.ingest).not.toHaveBeenCalled()
  })

  it('400 for a body that is not a JSON object', async () => {
    for (const raw of ['nope', '[]', '"x"', '']) {
      const res = await POST(post(null, { raw, ip: `198.51.100.${raw.length + 60}` }), ctx())
      expect(res.status).toBe(400)
    }
  })

  it.each([
    ['invalid phone', { fone: '123' }, 'invalid_phone'],
    ['missing name', { nome: '  ' }, 'missing_answer'],
    ['invalid email', { mail: 'nope' }, 'invalid_email'],
    ['option that does not exist', { cor: 'Vermelho' }, 'invalid_option'],
    ['answer over 500 chars', { cor: 'x'.repeat(501) }, 'answer_too_long'],
    ['non-text answer', { nome: 123 }, 'invalid_answers'],
  ])('400 on %s, nothing created', async (_label, patch, error) => {
    const res = await POST(post({ ...GOOD, answers: { ...GOOD.answers, ...patch } }), ctx())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe(error)
    expect(h.ingest).not.toHaveBeenCalled()
  })

  it('answers the same for a new, a repeated and a failed-phone-free contact (no leak of existence)', async () => {
    const run = async (result: Record<string, unknown>, ip: string) => {
      h.ingest.mockResolvedValueOnce(result)
      const res = await POST(post(GOOD, { ip }), ctx())
      return { status: res.status, body: await res.json() }
    }
    const fresh = await run({ status: 'ok', httpStatus: 200, contactId: 'c-new', dealId: 'd-1', duplicate: false, contactCreated: true }, '198.51.100.10')
    const dup = await run({ status: 'duplicate', httpStatus: 200, contactId: 'c-old', duplicate: true, contactCreated: false }, '198.51.100.11')
    expect(dup).toEqual(fresh)
    expect(JSON.stringify(dup)).not.toMatch(/c-old|c-new|duplicate|contact|deal/)
  })

  it('maps ingest failures without leaking internals', async () => {
    h.ingest.mockResolvedValueOnce({ status: 'error', httpStatus: 400, error: 'phone_invalid', duplicate: false, contactCreated: false })
    const bad = await POST(post(GOOD), ctx())
    expect(bad.status).toBe(400)
    h.ingest.mockResolvedValueOnce({ status: 'error', httpStatus: 500, error: 'contact_insert_failed: secret db text', duplicate: false, contactCreated: false })
    const res = await POST(post(GOOD, { ip: '198.51.100.12' }), ctx())
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret db text')
  })

  it('omits the WhatsApp link when the button is off', async () => {
    h.state.source!.bot_config = botConfig({ end: { thanks: 'Valeu', whatsappEnabled: false, whatsappNumber: '', messageTemplate: '' } })
    const res = await POST(post(GOOD), ctx())
    expect((await res.json()).whatsapp_url).toBeNull()
  })

  it('limits leads to 5 per IP per key, then 429, other IPs unaffected', async () => {
    for (let i = 0; i < 5; i++) expect((await POST(post(GOOD), ctx())).status).toBe(200)
    const res = await POST(post(GOOD), ctx())
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBeTruthy()
    expect((await POST(post(GOOD, { ip: '198.51.100.50' }), ctx())).status).toBe(200)
  })

  it('limits the bot to 60 posts per minute across IPs', async () => {
    for (let i = 0; i < 60; i++) {
      expect((await POST(post({ ...GOOD, contact_ref: 'x' }, { ip: `10.0.${Math.floor(i / 200)}.${i}` }), ctx())).status).toBe(200)
    }
    expect((await POST(post(GOOD, { ip: '10.9.9.9' }), ctx())).status).toBe(429)
  })
})

describe('abuse limits', () => {
  it('one IP hammering the endpoint does not spend the budget other visitors share', async () => {
    for (let i = 0; i < 5; i++) expect((await POST(post(GOOD, { ip: '198.51.100.200' }), ctx())).status).toBe(200)
    for (let i = 0; i < 100; i++) expect((await POST(post(GOOD, { ip: '198.51.100.200' }), ctx())).status).toBe(429)
    // 5 used above; 55 more from other addresses still fit in the 60/min of the bot
    for (let i = 0; i < 55; i++) {
      const ip = `10.1.0.${i + 1}`
      const res = await POST(post({ ...GOOD, contact_ref: 'x' }, { ip }), ctx())
      expect(res.status, ip).toBe(200)
    }
    expect((await POST(post(GOOD, { ip: '10.2.0.1' }), ctx())).status).toBe(429)
  })

  it('requests from a foreign origin do not spend the bot budget', async () => {
    for (let i = 0; i < 100; i++) {
      expect((await POST(post(GOOD, { origin: 'https://evil.com', ip: `10.3.${Math.floor(i / 200)}.${i}` }), ctx())).status).toBe(403)
    }
    expect((await POST(post(GOOD, { ip: '10.4.0.1' }), ctx())).status).toBe(200)
  })

  it('GET: one IP over its limit does not block the others', async () => {
    for (let i = 0; i < 30; i++) await GET(get(ORIGIN, '198.51.100.9'), ctx())
    for (let i = 0; i < 700; i++) expect((await GET(get(ORIGIN, '198.51.100.9'), ctx())).status).toBe(429)
    expect((await GET(get(ORIGIN, '198.51.100.10'), ctx())).status).toBe(200)
  })

  it('sends a typed number to the automations at most twice a day per bot, with the same answer', async () => {
    const sameNumber = (n: number) => post(GOOD, { ip: `198.51.100.${100 + n}` })
    const bodies = []
    for (let n = 0; n < 4; n++) {
      const res = await POST(sameNumber(n), ctx())
      expect(res.status).toBe(200)
      bodies.push(await res.json())
    }
    expect(h.ingest).toHaveBeenCalledTimes(2)
    expect(bodies[3]).toEqual(bodies[0])
    // another number is not affected
    const other = { ...GOOD, answers: { ...GOOD.answers, fone: '(21) 98888-7777' } }
    await POST(post(other, { ip: '198.51.100.150' }), ctx())
    expect(h.ingest).toHaveBeenCalledTimes(3)
  })

  it('does not fire lead_captured again for a contact that came through this bot in the last 24 h', async () => {
    h.ingest.mockResolvedValueOnce({ status: 'duplicate', httpStatus: 200, contactId: 'c-1', duplicate: true, contactCreated: false, recentRepeat: true })
    const res = await POST(post(GOOD), ctx())
    expect(await res.json()).toEqual({ ok: true, whatsapp_url: expect.any(String) })
    await flushAfter()
    expect(h.automations).toHaveLength(0)
    // a duplicate that is NOT a recent repeat still fires it (and only lead_captured)
    h.ingest.mockResolvedValueOnce({ status: 'duplicate', httpStatus: 200, contactId: 'c-1', duplicate: true, contactCreated: false, recentRepeat: false })
    await POST(post(GOOD, { ip: '198.51.100.31' }), ctx())
    await flushAfter()
    expect(h.automations.map((a) => a.triggerType)).toEqual(['lead_captured'])
  })

  it('rejects a name that is a link, with nothing created', async () => {
    const res = await POST(post({ ...GOOD, answers: { ...GOOD.answers, nome: 'ganhe em www.golpe.com' } }), ctx())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_name')
    expect(h.ingest).not.toHaveBeenCalled()
  })

  it('counts dropped submissions without personal data', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    await POST(post({ ...GOOD, contact_ref: 'x' }), ctx())
    await POST(post({ ...GOOD, elapsed_ms: 100 }, { ip: '198.51.100.40' }), ctx())
    const lines = info.mock.calls.map((c) => String(c[0]))
    expect(lines).toEqual([`[site-bot] dropped key=${KEY.slice(0, 8)} reason=honeypot`, `[site-bot] dropped key=${KEY.slice(0, 8)} reason=too_fast`])
  })

  it('treats a bot without pipeline and stage as not found (it would lose the answers)', async () => {
    h.state.source!.stage_id = null
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await GET(get(), ctx())).status).toBe(404)
    expect((await POST(post(GOOD), ctx())).status).toBe(404)
  })

  it('lets browsers reuse the public config for a minute', async () => {
    const res = await GET(get(), ctx())
    expect(res.headers.get('cache-control')).toBe('public, max-age=60')
    expect(res.headers.get('vary')).toBe('Origin')
  })
})
