import { beforeEach, describe, expect, it, vi } from 'vitest'

// ------------------------------------------------------------
// Every outbound route family refuses a read-only account (402) with the
// real guards (requireWritable / requireModule) and behaves normally when
// the account is active. The guards read the plan through plans-server,
// mocked here; the routes themselves are the real ones.
// ------------------------------------------------------------

const h = vi.hoisted(() => ({
  blocked: false as false | { reason: string },
  claim: vi.fn(async () => true),
}))

const entitlements = () => ({
  plan: 'pro',
  status: 'active',
  expiresAt: null,
  modules: { broadcasts: true, ai: true },
  limits: {},
  blocked: h.blocked,
})

vi.mock('@/lib/plans-server', () => ({
  loadAccountEntitlements: async () => entitlements(),
  accountHasModule: async () => !h.blocked,
}))
vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>()
  return {
    ...actual,
    requireRole: async () => ({ supabase: {}, accountId: 'acct-1', userId: 'u-1', role: 'agent' }),
  }
})
vi.mock('@/lib/whatsapp/broadcast-resume', () => ({ claimBroadcastDelivery: h.claim }))

function chain(): Record<string, unknown> {
  const c: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'is', 'order', 'limit', 'update']) c[m] = () => c
  c.maybeSingle = async () => ({ data: null, error: null })
  c.single = async () => ({ data: null, error: null })
  return c
}
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u-1' } }, error: null }) },
    from: (table: string) => {
      const c = chain()
      if (table === 'profiles') c.maybeSingle = async () => ({ data: { account_id: 'acct-1' }, error: null })
      return c
    },
  }),
}))
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => ({ from: () => chain() }) }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({ from: () => chain() }) }))

import { POST as react } from '@/app/api/whatsapp/react/route'
import { POST as typing } from '@/app/api/whatsapp/typing/route'
import { POST as broadcastBatch } from '@/app/api/whatsapp/broadcast/route'
import { POST as broadcastStart } from '@/app/api/whatsapp/broadcast/[id]/start/route'
import { POST as scheduledCreate } from '@/app/api/inbox/scheduled/route'
import { POST as scheduledSendNow } from '@/app/api/inbox/scheduled/[id]/send/route'
import { POST as aiSuggest } from '@/app/api/conversations/[id]/ai/suggest/route'
import { POST as automationCreate } from '@/app/api/automations/route'
import { PATCH as automationPatch, DELETE as automationDelete } from '@/app/api/automations/[id]/route'
import { POST as automationDuplicate } from '@/app/api/automations/[id]/duplicate/route'
import { POST as flowCreate } from '@/app/api/flows/route'
import { PUT as flowPut, DELETE as flowDelete } from '@/app/api/flows/[id]/route'
import { POST as flowActivate } from '@/app/api/flows/[id]/activate/route'
import { POST as templateSubmit } from '@/app/api/whatsapp/templates/submit/route'
import { PATCH as templatePatch, DELETE as templateDelete } from '@/app/api/whatsapp/templates/[id]/route'
import { POST as templateSync } from '@/app/api/whatsapp/templates/sync/route'
import { PATCH as scheduledPatch, DELETE as scheduledDelete } from '@/app/api/inbox/scheduled/[id]/route'

const post = (body: unknown = {}) =>
  new Request('http://localhost/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const idParams = { params: Promise.resolve({ id: 'x-1' }) }

// Each family: how to call it, and the status it answers when the account
// is fine (the request is empty, so it stops at its own validation).
const FAMILIES: [string, () => Promise<Response>, number][] = [
  ['whatsapp react', () => react(post({})), 400],
  ['whatsapp typing', () => typing(post({})), 400],
  ['broadcast batch', () => broadcastBatch(post({})), 400],
  ['broadcast start', () => broadcastStart(post({}), idParams), 200],
  ['scheduled message create', () => scheduledCreate(post({})), 400],
  ['scheduled message send now', () => scheduledSendNow(post({}), idParams), 404],
  ['AI suggest', () => aiSuggest(post({}), idParams), 404],
]

beforeEach(() => {
  h.blocked = false
  h.claim.mockClear()
})

describe.each(FAMILIES)('%s', (_name, call, okStatus) => {
  it.each(['trial_expired', 'past_due'])('is refused with 402 read_only while %s', async (reason) => {
    h.blocked = { reason }
    const res = await call()
    expect(res.status).toBe(402)
    expect(await res.json()).toMatchObject({ code: 'read_only', error: expect.stringContaining('somente leitura') })
    expect(h.claim).not.toHaveBeenCalled()
  })

  it('is refused for a suspended account too (403), unchanged behaviour', async () => {
    h.blocked = { reason: 'suspended' }
    expect([402, 403]).toContain((await call()).status)
    expect((await call()).status).not.toBe(okStatus)
  })

  it('works as before for an active account', async () => {
    expect((await call()).status).toBe(okStatus)
  })
})

// Mutating routes that write CRM rows with the service-role client (which
// bypasses the 094 RLS block): the route itself must refuse a read-only or
// blocked account before touching anything.
const uuidParams = { params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }) }
const SERVICE_ROLE_WRITERS: [string, () => Promise<Response>][] = [
  ['automation create', () => automationCreate(post({}))],
  ['automation update', () => automationPatch(post({}), idParams)],
  ['automation delete', () => automationDelete(post({}), idParams)],
  ['automation duplicate', () => automationDuplicate(post({}), idParams)],
  ['flow create', () => flowCreate(post({}))],
  ['flow update', () => flowPut(post({}), idParams)],
  ['flow delete', () => flowDelete(post({}), idParams)],
  ['flow activate', () => flowActivate(post({}), idParams)],
  ['template submit', () => templateSubmit(post({}))],
  ['template update', () => templatePatch(post({}), uuidParams)],
  ['template delete', () => templateDelete(post({}), uuidParams)],
  ['template sync', () => templateSync()],
  ['scheduled message update', () => scheduledPatch(post({}), idParams)],
  ['scheduled message delete', () => scheduledDelete(post({}), idParams)],
]

describe.each(SERVICE_ROLE_WRITERS)('service-role writer: %s', (_name, call) => {
  it.each(['trial_expired', 'past_due'])('is refused with 402 read_only while %s', async (reason) => {
    h.blocked = { reason }
    const res = await call()
    expect(res.status).toBe(402)
    expect(await res.json()).toMatchObject({ code: 'read_only' })
  })

  it.each(['suspended', 'canceled'])('is refused with 403 account_blocked while %s', async (reason) => {
    h.blocked = { reason }
    const res = await call()
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'account_blocked' })
  })
})
