import { beforeEach, describe, expect, it, vi } from 'vitest'

// ------------------------------------------------------------
// GET /api/companies/lookup/[cnpj] — authorization, validation, the
// duplicate check scoped to the caller's account, and pass-through
// of the lookup chain's result.
// ------------------------------------------------------------

const h = vi.hoisted(() => ({
  role: 'agent' as 'owner' | 'admin' | 'agent' | 'viewer' | null,
  existing: null as Record<string, unknown> | null,
  queries: [] as [string, ...unknown[]][][],
  lookup: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/br/lookup-server', () => ({ lookupCnpj: h.lookup }))

function makeSupabase() {
  return {
    from: (table: string) => {
      if (table !== 'companies') throw new Error(`unexpected table ${table}`)
      const ops: [string, ...unknown[]][] = []
      h.queries.push(ops)
      const b: Record<string, unknown> = {}
      for (const op of ['select', 'eq', 'neq', 'limit']) {
        b[op] = (...args: unknown[]) => {
          ops.push([op, ...args])
          return b
        }
      }
      b.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: h.existing ? [h.existing] : [], error: null }).then(resolve)
      return b
    },
  }
}

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>()
  const { hasMinRole } = await import('@/lib/auth/roles')
  return {
    ...actual,
    requireRole: vi.fn(async (min: 'owner' | 'admin' | 'agent' | 'viewer') => {
      if (!h.role) throw new actual.UnauthorizedError()
      if (!hasMinRole(h.role, min)) throw new actual.ForbiddenError('Insufficient role')
      return { supabase: makeSupabase(), userId: `user-${h.role}`, accountId: 'acct-1', role: h.role, account: {} }
    }),
  }
})

import { __resetRateLimitForTests } from '@/lib/rate-limit'
import { GET } from './route'

const call = (cnpj: string) =>
  GET(new Request(`http://localhost/api/companies/lookup/${cnpj}`), { params: Promise.resolve({ cnpj }) })

const company = { taxId: '11222333000181', legalName: 'Padaria Sol LTDA' }

beforeEach(() => {
  h.role = 'agent'
  h.existing = null
  h.queries = []
  h.lookup.mockReset()
  __resetRateLimitForTests()
})

describe('GET /api/companies/lookup/[cnpj]', () => {
  it('401 without a session and 403 for a viewer, without calling the sources', async () => {
    h.role = null
    expect((await call('11222333000181')).status).toBe(401)
    h.role = 'viewer'
    expect((await call('11222333000181')).status).toBe(403)
    expect(h.lookup).not.toHaveBeenCalled()
  })

  it('422 for an invalid CNPJ without calling the sources', async () => {
    const res = await call('11222333000182')
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ ok: false, reason: 'invalid', existing: null })
    expect(h.lookup).not.toHaveBeenCalled()
  })

  it('returns the company and the account duplicate, checked in the caller account', async () => {
    h.lookup.mockResolvedValue({ ok: true, company })
    h.existing = { id: 'co-9', razao_social: 'Padaria Sol LTDA', nome_fantasia: null, cnpj: '11222333000181', cidade: null, uf: null }
    const res = await call('11.222.333.0001-81')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(await res.json()).toEqual({ ok: true, company, existing: h.existing })
    expect(h.lookup).toHaveBeenCalledWith('11222333000181', undefined, { enrichEmail: false })
    expect(h.queries[0]).toContainEqual(['eq', 'cnpj', '11222333000181'])
    expect(h.queries[0]).toContainEqual(['eq', 'account_id', 'acct-1'])
  })

  it('still reports the duplicate when the sources do not know the CNPJ or are down', async () => {
    h.existing = { id: 'co-9', razao_social: 'Padaria Sol LTDA' }
    h.lookup.mockResolvedValueOnce({ ok: false, reason: 'not_found' })
    let res = await call('11222333000181')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ ok: false, reason: 'not_found', existing: h.existing })

    h.lookup.mockResolvedValueOnce({ ok: false, reason: 'upstream_error' })
    res = await call('11222333000181')
    expect(res.status).toBe(502)
    expect((await res.json()).existing).toEqual(h.existing)
  })

  it('rate-limits per user at 10 a minute', async () => {
    h.lookup.mockResolvedValue({ ok: true, company })
    let last: Response | null = null
    for (let i = 0; i < 11; i++) last = await call('11222333000181')
    expect(last?.status).toBe(429)
    // Another user has their own bucket.
    h.role = 'admin'
    expect((await call('11222333000181')).status).toBe(200)
  })
})
