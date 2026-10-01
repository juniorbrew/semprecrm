import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ send: vi.fn() }))

vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => ({}) }))
vi.mock('@/lib/whatsapp/read-receipts', () => ({
  ConversationNotFoundError: class extends Error {},
  sendReadReceipts: h.send,
}))
vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  getCurrentAccount: async () => ({ accountId: 'acct-1', userId: 'user-1', role: 'agent' }),
}))

import { __resetRateLimitForTests } from '@/lib/rate-limit'
import { POST } from './route'

const call = () =>
  POST(new Request('http://localhost/api/conversations/c1/read', { method: 'POST' }), {
    params: Promise.resolve({ id: 'c1' }),
  })

beforeEach(() => {
  __resetRateLimitForTests()
  h.send.mockReset()
  h.send.mockResolvedValue({ marked: 1 })
})

describe('POST /api/conversations/[id]/read', () => {
  it('hides the upstream error text behind a generic 502', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    h.send.mockRejectedValue(new Error('gateway at http://10.0.0.3:4000 refused token abc'))
    const res = await call()
    expect(res.status).toBe(502)
    expect(JSON.stringify(await res.json())).not.toMatch(/10\.0\.0\.3|token/)
  })

  it('rate-limits per user', async () => {
    let last = 0
    for (let i = 0; i < 121; i++) last = (await call()).status
    expect(last).toBe(429)
  })
})
