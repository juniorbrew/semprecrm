import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ------------------------------------------------------------
// /api/channels/qr/{connect,status,logout} — the session-authenticated
// proxies. Covers auth, the `channel_qr` module gate, `max_channels`,
// the proxy call itself and the gateway-down / env-unset paths.
// ------------------------------------------------------------

const h = vi.hoisted(() => ({
  state: {
    /** null = no session (401). */
    role: 'admin' as string | null,
    account: {
      plan: 'trial',
      plan_status: 'trial',
      plan_expires_at: null as string | null,
      module_overrides: {} as Record<string, unknown>,
      limit_overrides: {} as Record<string, unknown>,
    },
    officialChannels: 0,
    qrRow: null as Record<string, unknown> | null,
    upserts: [] as Record<string, unknown>[],
  },
}))

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>()
  return {
    ...actual,
    requireRole: vi.fn(async (min: string) => {
      if (!h.state.role) throw new actual.UnauthorizedError()
      const order = ['viewer', 'agent', 'admin', 'owner']
      if (order.indexOf(h.state.role) < order.indexOf(min)) {
        throw new actual.ForbiddenError('Insufficient role')
      }
      return {
        supabase: makeSupabase(),
        userId: 'user-1',
        accountId: 'acct-1',
        role: h.state.role,
        account: { id: 'acct-1', name: 'Acme' },
      }
    }),
  }
})

function makeSupabase() {
  function builder(table: string) {
    const ops = { count: false, type: 'select' as string, payload: undefined as unknown }
    const filters: [string, unknown][] = []
    const b: Record<string, unknown> = {
      select: (_cols?: string, opts?: { count?: string }) => {
        if (opts?.count) ops.count = true
        return b
      },
      upsert: (p: Record<string, unknown>) => {
        ops.type = 'upsert'
        ops.payload = p
        h.state.upserts.push(p)
        h.state.qrRow = { ...(h.state.qrRow ?? {}), ...p }
        return b
      },
      eq: (k: string, v: unknown) => (filters.push([k, v]), b),
      neq: (k: string, v: unknown) => (filters.push([`!${k}`, v]), b),
      maybeSingle: () => Promise.resolve(resolve()),
      single: () => Promise.resolve(resolve()),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(resolve()).then(onF, onR),
    }
    function resolve() {
      if (table === 'accounts') return { data: h.state.account, error: null }
      if (table === 'whatsapp_config') {
        return { data: null, count: h.state.officialChannels, error: null }
      }
      if (table === 'wa_qr_sessions') {
        if (ops.type === 'upsert') return { data: h.state.qrRow, error: null }
        if (ops.count) {
          const live = h.state.qrRow && h.state.qrRow.status !== 'disconnected' ? 1 : 0
          return { data: null, count: live, error: null }
        }
        return { data: h.state.qrRow, error: null }
      }
      return { data: null, error: null }
    }
    return b
  }
  return { from: (table: string) => builder(table) }
}

import { POST as connect } from './connect/route'
import { GET as status } from './status/route'
import { POST as logout } from './logout/route'

const fetchMock = vi.fn()

function gatewayOk(body: unknown, init: { status?: number } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  h.state.role = 'admin'
  h.state.account = {
    plan: 'trial',
    plan_status: 'trial',
    plan_expires_at: null,
    module_overrides: {},
    limit_overrides: {},
  }
  h.state.officialChannels = 0
  h.state.qrRow = null
  h.state.upserts = []
  process.env.WA_GATEWAY_URL = 'http://gateway.test:3201'
  process.env.WA_GATEWAY_SECRET = 'shh'
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('auth + module gate', () => {
  it('401 without a session', async () => {
    h.state.role = null
    const res = await connect()
    expect(res.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('403 for an agent (admin+ only)', async () => {
    h.state.role = 'agent'
    expect((await connect()).status).toBe(403)
    expect((await status()).status).toBe(403)
    expect((await logout()).status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('403 module_not_included when channel_qr is off', async () => {
    h.state.account.module_overrides = { channel_qr: false }
    const res = await connect()
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'module_not_included' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('403 when the account is blocked', async () => {
    h.state.account.plan_status = 'suspended'
    expect((await status()).status).toBe(403)
  })
})

describe('POST /connect — max_channels', () => {
  it('403 plan_limit_reached when the official channel already fills the slot', async () => {
    h.state.officialChannels = 1 // trial: max_channels = 1
    const res = await connect()
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('plan_limit_reached')
    expect(body.error).toMatch(/Seu plano permite/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('lets an existing (non-disconnected) session reconnect even at the limit', async () => {
    h.state.officialChannels = 1
    h.state.qrRow = { account_id: 'acct-1', status: 'connecting' }
    fetchMock
      .mockResolvedValueOnce(gatewayOk({ status: 'connecting' }))
      .mockResolvedValueOnce(gatewayOk({ status: 'qr', qr: 'data:image/png;base64,AAA' }))
    const res = await connect()
    expect(res.status).toBe(200)
  })

  it('proxies to the gateway with the secret and mirrors the state', async () => {
    fetchMock
      .mockResolvedValueOnce(gatewayOk({ status: 'connecting' }))
      .mockResolvedValueOnce(gatewayOk({ status: 'qr', qr: 'data:image/png;base64,AAA' }))

    const res = await connect()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.session).toMatchObject({ status: 'qr', qr: 'data:image/png;base64,AAA' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://gateway.test:3201/sessions/acct-1/connect')
    expect(init.method).toBe('POST')
    expect(init.headers['x-gateway-secret']).toBe('shh')
    expect(h.state.upserts[0]).toMatchObject({ account_id: 'acct-1', status: 'qr' })
  })

  it('503 gateway_unreachable when fetch throws', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    const res = await connect()
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.code).toBe('gateway_unreachable')
    expect(body.error).toMatch(/gateway/i)
    expect(h.state.upserts).toHaveLength(0)
  })

  it('503 gateway_unconfigured when env is unset', async () => {
    delete process.env.WA_GATEWAY_URL
    const res = await connect()
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ code: 'gateway_unconfigured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('GET /status', () => {
  it('returns the gateway state and mirrors phone/name when connected', async () => {
    h.state.qrRow = { account_id: 'acct-1', status: 'qr' }
    fetchMock.mockResolvedValueOnce(
      gatewayOk({ status: 'connected', phone: '5511999990000', name: 'Loja' }),
    )
    const res = await status()
    expect(res.status).toBe(200)
    expect((await res.json()).session).toMatchObject({
      status: 'connected',
      phone: '5511999990000',
      phone_number: '5511999990000',
      display_name: 'Loja',
    })
    expect(fetchMock.mock.calls[0][0]).toBe('http://gateway.test:3201/sessions/acct-1')
    expect(h.state.upserts[0]).toMatchObject({ status: 'connected', phone_number: '5511999990000' })
  })

  it('does not rewrite the row when nothing changed', async () => {
    h.state.qrRow = { account_id: 'acct-1', status: 'connected', phone_number: '55', display_name: 'L' }
    fetchMock.mockResolvedValueOnce(gatewayOk({ status: 'connected', phone: '55', name: 'L' }))
    await status()
    expect(h.state.upserts).toHaveLength(0)
  })

  it('503 with the last known row when the gateway is down', async () => {
    h.state.qrRow = { account_id: 'acct-1', status: 'connected', phone_number: '55' }
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const res = await status()
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.code).toBe('gateway_unreachable')
    expect(body.session).toMatchObject({ status: 'connected', phone_number: '55' })
  })

  it('treats a rejected secret (401 from the gateway) as unreachable', async () => {
    fetchMock.mockResolvedValueOnce(gatewayOk({ error: 'bad secret' }, { status: 401 }))
    const res = await status()
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ code: 'gateway_unreachable' })
  })
})

describe('POST /logout', () => {
  it('proxies and marks the row disconnected', async () => {
    h.state.qrRow = { account_id: 'acct-1', status: 'connected', phone_number: '55' }
    fetchMock.mockResolvedValueOnce(gatewayOk({}))
    const res = await logout()
    expect(res.status).toBe(200)
    expect(fetchMock.mock.calls[0][0]).toBe('http://gateway.test:3201/sessions/acct-1/logout')
    expect(h.state.upserts[0]).toMatchObject({
      status: 'disconnected',
      phone_number: null,
      display_name: null,
      connected_at: null,
    })
  })

  it('503 and no DB write when the gateway is down', async () => {
    h.state.qrRow = { account_id: 'acct-1', status: 'connected' }
    fetchMock.mockRejectedValueOnce(new Error('down'))
    const res = await logout()
    expect(res.status).toBe(503)
    expect(h.state.upserts).toHaveLength(0)
  })
})
