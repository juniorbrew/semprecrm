import { beforeEach, describe, expect, it, vi } from 'vitest'

// requireWritable / requireModule: the server side of read-only mode.

const h = vi.hoisted(() => ({
  ent: null as null | { blocked: false | { reason: string }; modules: Record<string, boolean> },
}))

vi.mock('@/lib/plans-server', () => ({ loadAccountEntitlements: async () => h.ent }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }))

import { ForbiddenError, ModuleNotIncludedError, ReadOnlyError, requireModule, requireWritable, toErrorResponse, type AccountContext } from './account'

const ctx = { supabase: {}, accountId: 'acct-1', userId: 'u-1', role: 'agent' } as unknown as AccountContext
const active = (blocked: false | { reason: string } = false) => ({ blocked, modules: { ai: true, broadcasts: true } })

beforeEach(() => {
  h.ent = active()
})

describe('requireWritable', () => {
  it('lets an active account through and returns the context', async () => {
    expect(await requireWritable(ctx)).toBe(ctx)
  })

  it.each(['trial_expired', 'past_due'])('%s -> 402 read_only with a pt-BR message', async (reason) => {
    h.ent = active({ reason })
    const err = await requireWritable(ctx).catch((e) => e)
    expect(err).toBeInstanceOf(ReadOnlyError)
    const res = toErrorResponse(err)
    expect(res.status).toBe(402)
    expect(await res.json()).toMatchObject({ code: 'read_only', error: expect.stringContaining('somente leitura') })
  })

  it.each(['suspended', 'canceled', 'plan_unavailable'])('%s -> 403 account_blocked, not read-only', async (reason) => {
    h.ent = active({ reason })
    const err = await requireWritable(ctx).catch((e) => e)
    expect(err).toBeInstanceOf(ForbiddenError)
    expect(err).not.toBeInstanceOf(ReadOnlyError)
    expect(toErrorResponse(err).status).toBe(403)
    expect(err.code).toBe('account_blocked')
  })

  it('an unreadable account fails closed', async () => {
    h.ent = null
    await expect(requireWritable(ctx)).rejects.toBeInstanceOf(ForbiddenError)
  })
})

describe('requireModule in read-only mode', () => {
  it('refuses with 402 by default', async () => {
    h.ent = active({ reason: 'past_due' })
    await expect(requireModule(ctx, 'ai')).rejects.toBeInstanceOf(ReadOnlyError)
  })

  it('reads can opt in with allowReadOnly, but the module must still be on', async () => {
    h.ent = active({ reason: 'trial_expired' })
    await expect(requireModule(ctx, 'ai', { allowReadOnly: true })).resolves.toBeTruthy()
    h.ent = { blocked: { reason: 'past_due' }, modules: { ai: false } }
    await expect(requireModule(ctx, 'ai', { allowReadOnly: true })).rejects.toBeInstanceOf(ModuleNotIncludedError)
  })

  it('allowReadOnly never opens a suspended account', async () => {
    h.ent = active({ reason: 'suspended' })
    await expect(requireModule(ctx, 'ai', { allowReadOnly: true })).rejects.toBeInstanceOf(ModuleNotIncludedError)
  })
})
