import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ api: true }))

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>()
  return {
    ...actual,
    requireRole: vi.fn(async () => ({ userId: 'u1', accountId: 'acc', role: 'admin' })),
    requireModule: vi.fn(async (_ctx: unknown, module: string) => {
      if (module === 'api' && !h.api) throw new actual.ModuleNotIncludedError('api')
      return {}
    }),
  }
})

import { requireAdmin } from './admin-guard'

describe('requireAdmin', () => {
  it('lets an admin through when the plan has the api module', async () => {
    expect(await requireAdmin()).toMatchObject({ ctx: { accountId: 'acc' } })
  })

  it('refuses with 403 when the plan lacks the api module (099)', async () => {
    h.api = false
    const out = await requireAdmin()
    expect('response' in out && out.response.status).toBe(403)
  })
})
