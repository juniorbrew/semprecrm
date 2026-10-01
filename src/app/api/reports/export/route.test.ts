import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>

const h = vi.hoisted(() => ({
  role: 'admin' as string | null,
  dashboardModule: true,
  rpcCalls: [] as { name: string; args: Row }[],
  rpcError: null as { code: string; message: string } | null,
  limited: false,
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rate-limit')>()
  return {
    ...actual,
    checkRateLimit: vi.fn(() => (h.limited ? { success: false, retryAfterMs: 1000, limit: 30, remaining: 0 } : { success: true, limit: 30, remaining: 29 })),
    rateLimitResponse: vi.fn(() => new Response(JSON.stringify({ error: 'rate' }), { status: 429 })),
  }
})
vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>()
  const { hasMinRole } = await import('@/lib/auth/roles')
  const table = (rows: Row[]) => {
    const b: Record<string, unknown> = {}
    b.select = () => b
    b.eq = () => b
    b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(ok)
    return b
  }
  return {
    ...actual,
    requireRole: vi.fn(async (min: 'admin') => {
      if (!h.role) throw new actual.UnauthorizedError()
      if (!hasMinRole(h.role as 'admin', min)) throw new actual.ForbiddenError('Insufficient role')
      return {
        supabase: {
          rpc: async (name: string, args: Row) => {
            h.rpcCalls.push({ name, args })
            if (h.rpcError) return { data: null, error: h.rpcError }
            if (name === 'support_report_backlog') return { data: [{ bucket: 'lt1d', total: 2 }], error: null }
            const key = args.p_group === 'all' ? 'all' : args.p_group === 'team' ? 'team-1' : args.p_group === 'category' ? null : args.p_group === 'priority' ? 'high' : 'user-1'
            return {
              data: [
                { group_key: key, opened: 3, resolved: 2, backlog: 1, fr_count: 1, fr_avg_seconds: 60, fr_median_seconds: 60, fr_p90_seconds: 60, res_count: 2, res_avg_seconds: 3600, res_median_seconds: 3600, res_p90_seconds: 3600, sla_met: 1, sla_missed: 0, reopened: 0, csat_sent: 1, csat_answered: 1, csat_avg: 5 },
              ],
              error: null,
            }
          },
          from: (t: string) =>
            table(
              t === 'teams'
                ? [{ id: 'team-1', name: 'Financeiro' }]
                : t === 'conversation_categories'
                  ? [{ id: 'cat-1', name: '=cmd|calc' }]
                  : [{ user_id: 'user-1', full_name: 'Ana' }],
            ),
        },
        userId: 'u-a',
        accountId: 'acc-a',
        role: h.role,
      }
    }),
    requireModule: vi.fn(async () => {
      if (!h.dashboardModule) throw new actual.ModuleNotIncludedError('dashboard')
      return {}
    }),
  }
})

import { GET } from './route'

const url = (qs: string) => new Request(`http://localhost/api/reports/export?${qs}`)
const OK = 'from=2026-03-01&to=2026-03-07'

beforeEach(() => {
  h.role = 'admin'
  h.dashboardModule = true
  h.rpcCalls = []
  h.rpcError = null
  h.limited = false
})

describe('GET /api/reports/export', () => {
  it('401 without a session, 403 for an agent or a viewer, no database call', async () => {
    h.role = null
    expect((await GET(url(OK))).status).toBe(401)
    for (const role of ['agent', 'viewer']) {
      h.role = role
      expect((await GET(url(OK))).status).toBe(403)
    }
    expect(h.rpcCalls).toEqual([])
  })

  it('403 when the plan has no dashboard module', async () => {
    h.dashboardModule = false
    expect((await GET(url(OK))).status).toBe(403)
  })

  it('429 when rate limited', async () => {
    h.limited = true
    expect((await GET(url(OK))).status).toBe(429)
  })

  it.each([
    ['no period', ''],
    ['to before from', 'from=2026-03-07&to=2026-03-01'],
    ['bad date', 'from=2026-02-31&to=2026-03-01'],
    ['over a year', 'from=2024-01-01&to=2026-03-01'],
    ['bad team id', `${OK}&team_id=abc`],
    ['sql in a filter', `${OK}&category_id=${encodeURIComponent("x' or 1=1 --")}`],
    ['bad channel', `${OK}&channel=sms`],
  ])('400 for %s', async (_label, qs) => {
    expect((await GET(url(qs))).status).toBe(400)
    expect(h.rpcCalls).toEqual([])
  })

  it('returns a CSV that follows the filters, with names only', async () => {
    const team = '11111111-1111-4111-8111-111111111111'
    const res = await GET(url(`${OK}&team_id=${team}&channel=qr`))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/csv')
    expect(res.headers.get('content-disposition')).toContain('relatorio-suporte-2026-03-01_2026-03-07.csv')
    expect(res.headers.get('cache-control')).toBe('no-store')
    // Same filters on every query, on the caller's own account.
    expect(h.rpcCalls).toHaveLength(6)
    for (const c of h.rpcCalls) {
      expect(c.args).toMatchObject({ p_account_id: 'acc-a', p_team_id: team, p_channel: 'qr', p_category_id: null, p_agent_id: null })
    }
    expect(h.rpcCalls.filter((c) => c.name === 'support_report').map((c) => c.args.p_group)).toEqual(['all', 'category', 'team', 'agent', 'priority'])
    const csv = await res.text()
    expect(csv).toContain('equipe;Financeiro;')
    expect(csv).toContain('atendente;Ana;')
    expect(csv).toContain('prioridade;Alta;')
    expect(csv).toContain('categoria;Sem definição;')
    expect(csv).toContain('fila_por_idade;Menos de 1 dia;2')
    // A category named like a formula stays text.
    expect(csv).not.toMatch(/(^|;)=cmd/m)
  })

  it('a database refusal is a 403, not a leak', async () => {
    h.rpcError = { code: '42501', message: 'reports are for account admins' }
    const res = await GET(url(OK))
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain('account admins')
  })
})
