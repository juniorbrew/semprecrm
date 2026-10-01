import { beforeEach, describe, expect, it, vi } from 'vitest'

const run = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: run }))
vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  requireRole: async () => ({ accountId: 'acct-1', userId: 'user-1', role: 'agent' }),
}))

import { __resetRateLimitForTests, RATE_LIMITS } from '@/lib/rate-limit'
import { POST } from './route'

const call = () =>
  POST(
    new Request('http://localhost/api/automations/engine', {
      method: 'POST',
      body: JSON.stringify({ trigger_type: 'keyword' }),
    }),
  )

beforeEach(() => {
  __resetRateLimitForTests()
  run.mockClear()
})

describe('POST /api/automations/engine', () => {
  it('caps manual triggers per user', async () => {
    for (let i = 0; i < RATE_LIMITS.automationTrigger.limit; i++) {
      expect((await call()).status).toBe(200)
    }
    expect((await call()).status).toBe(429)
    expect(run).toHaveBeenCalledTimes(RATE_LIMITS.automationTrigger.limit)
  })
})
