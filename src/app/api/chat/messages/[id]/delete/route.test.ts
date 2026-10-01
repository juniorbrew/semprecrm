import { beforeEach, describe, expect, it, vi } from 'vitest'

// ------------------------------------------------------------
// POST /api/chat/messages/[id]/delete — the service-role removal must
// only touch objects under the caller's account AND the message's own
// thread, never a sender-planted path; DB errors stay server-side.
// ------------------------------------------------------------

const ACCT = '11111111-1111-1111-1111-111111111111'
const THREAD = '22222222-2222-2222-2222-222222222222'
const MSG = '33333333-3333-3333-3333-333333333333'

const h = vi.hoisted(() => ({
  message: null as Record<string, unknown> | null,
  lookupError: null as { message: string } | null,
  removed: [] as string[][],
}))

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    storage: {
      from: () => ({
        remove: async (paths: string[]) => {
          h.removed.push(paths)
          return { error: null }
        },
      }),
    },
  }),
}))

function makeSupabase() {
  return {
    from: () => {
      const b: Record<string, unknown> = {}
      for (const op of ['select', 'eq', 'update']) b[op] = () => b
      b.maybeSingle = async () => ({ data: h.message, error: h.lookupError })
      b.single = async () => ({ data: { ...h.message, deleted_at: 'now' }, error: null })
      b.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve)
      return b
    },
  }
}

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>()
  return {
    ...actual,
    getCurrentAccount: vi.fn(async () => ({
      supabase: makeSupabase(),
      userId: 'user-1',
      accountId: ACCT,
      role: 'agent',
      account: {},
    })),
  }
})

import { __resetRateLimitForTests } from '@/lib/rate-limit'
import { POST } from './route'

const call = () =>
  POST(new Request(`http://localhost/api/chat/messages/${MSG}/delete`, { method: 'POST' }), {
    params: Promise.resolve({ id: MSG }),
  })

function withAttachment(path: string) {
  h.message = {
    id: MSG,
    thread_id: THREAD,
    sender_id: 'user-1',
    kind: 'text',
    deleted_at: null,
    attachment: { path, mime: 'application/pdf', name: 'x.pdf', size: 1 },
  }
}

beforeEach(() => {
  h.message = null
  h.lookupError = null
  h.removed = []
  __resetRateLimitForTests()
})

describe('POST /api/chat/messages/[id]/delete', () => {
  it('removes the attachment when it lives under this account and thread', async () => {
    const path = `account-${ACCT}/chat/${THREAD}/abc-x.pdf`
    withAttachment(path)
    expect((await call()).status).toBe(200)
    expect(h.removed).toEqual([[path]])
  })

  it.each([
    `account-99999999-9999-9999-9999-999999999999/chat/${THREAD}/abc-x.pdf`,
    `account-${ACCT}/chat/44444444-4444-4444-4444-444444444444/abc-x.pdf`,
    `account-${ACCT}/chat/${THREAD}/../../../account-other/chat/t/x.pdf`,
  ])('never removes a foreign path %s (message still soft-deleted)', async (path) => {
    withAttachment(path)
    expect((await call()).status).toBe(200)
    expect(h.removed).toEqual([])
  })

  it('does not leak DB error text', async () => {
    h.lookupError = { message: 'relation "secret_table" does not exist' }
    const res = await call()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret_table')
  })
})
