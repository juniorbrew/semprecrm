import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>

const h = vi.hoisted(() => ({
  state: { role: 'agent' as string | null, aiModule: true, conversations: [] as Row[] },
  runTriage: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => ({ admin: true }) }))
vi.mock('@/lib/support/ai-triage', () => ({ runTriage: h.runTriage }))

function makeSupabase() {
  return {
    from() {
      let rows = [...h.state.conversations]
      const b = {
        select: () => b,
        eq: (col: string, val: unknown) => {
          rows = rows.filter((r) => r[col] === val)
          return b
        },
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      }
      return b
    },
  }
}

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>()
  const { hasMinRole } = await import('@/lib/auth/roles')
  return {
    ...actual,
    requireRole: vi.fn(async (min: 'agent') => {
      if (!h.state.role) throw new actual.UnauthorizedError()
      if (!hasMinRole(h.state.role as 'agent', min)) throw new actual.ForbiddenError('Insufficient role')
      return { supabase: makeSupabase(), userId: 'user-a', accountId: 'acc-a', role: h.state.role, account: { id: 'acc-a', name: 'X' } }
    }),
    requireModule: vi.fn(async () => {
      if (!h.state.aiModule) throw new actual.ModuleNotIncludedError('ai')
      return {}
    }),
  }
})

import { __resetRateLimitForTests } from '@/lib/rate-limit'
import { AiError } from '@/lib/ai/errors'
import { POST } from './route'

const CONV = '11111111-1111-4111-8111-111111111111'
const OTHER = '33333333-3333-4333-8333-333333333333'
const ANON = '44444444-4444-4444-8444-444444444444'

const post = (id: string) =>
  POST(new Request(`http://localhost/api/conversations/${id}/ai/triage`, { method: 'POST' }), {
    params: Promise.resolve({ id }),
  })

beforeEach(() => {
  __resetRateLimitForTests()
  h.runTriage.mockReset()
  h.runTriage.mockResolvedValue({ status: 'applied', result: {} })
  h.state.role = 'agent'
  h.state.aiModule = true
  h.state.conversations = [
    { id: CONV, account_id: 'acc-a', channel: 'official', contact_id: 'c1', contact: { name: 'Ana', anonymized_at: null } },
    { id: OTHER, account_id: 'acc-b', channel: 'official', contact_id: 'c2', contact: { name: 'Zoe', anonymized_at: null } },
    { id: ANON, account_id: 'acc-a', channel: 'official', contact_id: 'c3', contact: { name: null, anonymized_at: '2026-01-01' } },
  ]
})

describe('POST /api/conversations/:id/ai/triage', () => {
  it('401 without a session and 403 for viewers', async () => {
    h.state.role = null
    expect((await post(CONV)).status).toBe(401)
    h.state.role = 'viewer'
    expect((await post(CONV)).status).toBe(403)
    expect(h.runTriage).not.toHaveBeenCalled()
  })

  it('403 when the plan has no AI module', async () => {
    h.state.aiModule = false
    expect((await post(CONV)).status).toBe(403)
    expect(h.runTriage).not.toHaveBeenCalled()
  })

  it('404 for another account or a malformed id, without calling the model', async () => {
    expect((await post(OTHER)).status).toBe(404)
    expect((await post('nope')).status).toBe(404)
    expect(h.runTriage).not.toHaveBeenCalled()
  })

  it('refuses anonymised contacts (LGPD)', async () => {
    const res = await post(ANON)
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('contact_anonymized')
    expect(h.runTriage).not.toHaveBeenCalled()
  })

  it('agent: runs triage with the session account and reports applied', async () => {
    const res = await post(CONV)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ applied: true })
    expect(h.runTriage).toHaveBeenCalledWith(
      { admin: true },
      expect.objectContaining({ accountId: 'acc-a', conversationId: CONV, userId: 'user-a' }),
    )
  })

  it('a skip is 200 with the reason; disabled triage is 409', async () => {
    h.runTriage.mockResolvedValueOnce({ status: 'skipped', reason: 'low_confidence' })
    expect(await (await post(CONV)).json()).toEqual({ applied: false, reason: 'low_confidence' })
    h.runTriage.mockResolvedValueOnce({ status: 'skipped', reason: 'triage_disabled' })
    const res = await post(CONV)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('triage_disabled')
  })

  it('maps budget errors to 402', async () => {
    h.runTriage.mockRejectedValueOnce(new AiError('budget_exceeded'))
    expect((await post(CONV)).status).toBe(402)
  })

  it('rate-limits per user', async () => {
    for (let i = 0; i < 10; i++) expect((await post(CONV)).status).toBe(200)
    expect((await post(CONV)).status).toBe(429)
  })
})
