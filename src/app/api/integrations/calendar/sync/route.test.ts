import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sync = vi.hoisted(() => vi.fn(async () => ({ synced: 0 })))

vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => ({}) }))
vi.mock('@/lib/calendar/sync/engine', () => ({ CRON_BATCH_LIMIT: 20, syncDueConnections: sync }))

import { POST } from './route'

const call = (secret?: string) =>
  POST(
    new Request('http://localhost/api/integrations/calendar/sync', {
      method: 'POST',
      headers: secret === undefined ? {} : { 'x-cron-secret': secret },
    }),
  )

beforeEach(() => {
  sync.mockClear()
  vi.stubEnv('AUTOMATION_CRON_SECRET', 'cron-secret-value')
})
afterEach(() => vi.unstubAllEnvs())

describe('POST /api/integrations/calendar/sync — cron secret', () => {
  it('fails closed (503) when the secret is not configured', async () => {
    vi.stubEnv('AUTOMATION_CRON_SECRET', '')
    expect((await call('anything')).status).toBe(503)
    expect(sync).not.toHaveBeenCalled()
  })

  it.each([undefined, '', 'wrong', 'cron-secret-valuX', 'cron-secret-value-longer'])(
    '401 for a missing / wrong secret %j',
    async (secret) => {
      expect((await call(secret)).status).toBe(401)
      expect(sync).not.toHaveBeenCalled()
    },
  )

  it('runs the sync with the right secret', async () => {
    expect((await call('cron-secret-value')).status).toBe(200)
    expect(sync).toHaveBeenCalledTimes(1)
  })
})
